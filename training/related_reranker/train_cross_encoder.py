#!/usr/bin/env python3
"""Train a related-paper cross-encoder from exported JSONL pairs.

The input format matches benchmark/training/related-papers/*.pairs.jsonl.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Sequence

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
    set_seed,
)


RELEVANCE_VALUES = np.asarray([0.0, 1.0, 2.0], dtype=np.float32)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a cross-encoder for related-paper reranking.",
    )
    parser.add_argument(
        "--train",
        default="benchmark/training/related-papers/related.train.pairs.jsonl",
        help="Training JSONL path.",
    )
    parser.add_argument(
        "--dev",
        default="benchmark/training/related-papers/related.dev.pairs.jsonl",
        help="Development JSONL path.",
    )
    parser.add_argument(
        "--output-dir",
        default="artifacts/related_reranker",
        help="Directory for checkpoints and metrics.",
    )
    parser.add_argument(
        "--model-name",
        default="answerdotai/ModernBERT-base",
        help="Hugging Face checkpoint to fine-tune.",
    )
    parser.add_argument("--max-length", type=int, default=1024)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--train-batch-size", type=int, default=4)
    parser.add_argument("--eval-batch-size", type=int, default=8)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--logging-steps", type=int, default=10)
    parser.add_argument("--save-total-limit", type=int, default=2)
    parser.add_argument("--num-workers", type=int, default=2)
    parser.add_argument("--sample-train", type=int, default=0)
    parser.add_argument("--sample-dev", type=int, default=0)
    parser.add_argument("--title-chars", type=int, default=240)
    parser.add_argument("--abstract-chars", type=int, default=900)
    parser.add_argument("--summary-chars", type=int, default=1200)
    parser.add_argument("--feature-decimals", type=int, default=3)
    parser.add_argument("--weight-judged", type=float, default=1.0)
    parser.add_argument("--weight-weak-silver", type=float, default=0.7)
    parser.add_argument("--weight-weak-bronze", type=float, default=0.45)
    parser.add_argument("--weight-hard-negative", type=float, default=0.5)
    parser.add_argument(
        "--gradient-checkpointing",
        action="store_true",
        help="Enable gradient checkpointing on the encoder.",
    )
    parser.add_argument("--bf16", action="store_true")
    parser.add_argument("--fp16", action="store_true")
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Pass trust_remote_code=True to Auto* loaders.",
    )
    return parser.parse_args()


def read_jsonl(path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def maybe_sample(rows: List[Dict[str, Any]], limit: int, seed: int) -> List[Dict[str, Any]]:
    if limit <= 0 or len(rows) <= limit:
        return rows
    random.Random(seed).shuffle(rows)
    return rows[:limit]


def strip_markdown(text: str | None) -> str:
    if not text:
        return ""
    cleaned = text.replace("```", " ").replace("##", " ")
    cleaned = re.sub(r"`([^`]*)`", r"\1", cleaned)
    cleaned = re.sub(r"\[(.*?)\]\((.*?)\)", r"\1", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def truncate(text: str | None, limit: int) -> str:
    normalized = strip_markdown(text)
    if not normalized:
        return ""
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(0, limit - 1)].rstrip() + "…"


def format_authors(authors: Sequence[str]) -> str:
    if not authors:
        return ""
    return ", ".join(authors[:8])


def format_paper(paper: Dict[str, Any], role: str, args: argparse.Namespace) -> str:
    lines = [
        f"{role} title: {truncate(paper.get('title'), args.title_chars)}",
    ]
    authors = format_authors(paper.get("authors") or [])
    if authors:
        lines.append(f"{role} authors: {authors}")
    year = paper.get("year")
    venue = paper.get("venue")
    if year is not None or venue:
        parts = []
        if year is not None:
            parts.append(str(year))
        if venue:
            parts.append(str(venue))
        lines.append(f"{role} venue: {' | '.join(parts)}")
    abstract = truncate(paper.get("abstract"), args.abstract_chars)
    if abstract:
        lines.append(f"{role} abstract: {abstract}")
    summary = truncate(paper.get("summary"), args.summary_chars)
    if summary:
        lines.append(f"{role} summary: {summary}")
    return "\n".join(lines)


def format_features(features: Dict[str, Any], decimals: int) -> str:
    signal_fields = {
        "baseline_confidence": features.get("baselineConfidence", 0),
        "rerank_score": features.get("rerankScore", 0),
        "semantic_similarity": features.get("semanticSimilarity", 0),
        "title_similarity": features.get("titleSimilarity", 0),
        "query_title_overlap": features.get("queryTitleOverlap", 0),
        "body_token_overlap": features.get("bodyTokenOverlap", 0),
        "tag_overlap": features.get("tagOverlap", 0),
        "lexical_author_overlap": features.get("lexicalAuthorOverlap", 0),
        "identity_author_overlap": features.get("identityAuthorOverlap", 0),
        "venue_overlap": features.get("venueOverlap", 0),
        "year_proximity": features.get("yearProximity", 0),
        "hub_score": features.get("hubScore", 0),
        "citation_prior": features.get("citationPrior", 0),
        "relation_type_prior": features.get("relationTypePrior", 0),
    }
    deterministic = features.get("deterministicSignals") or {}
    for name, value in deterministic.items():
        signal_fields[f"signal_{name}"] = value
    return "; ".join(
        f"{name}={float(value):.{decimals}f}" for name, value in signal_fields.items()
    )


def pair_to_text_pair(pair: Dict[str, Any], args: argparse.Namespace) -> tuple[str, str]:
    seed_text = format_paper(pair["seedPaper"], "seed", args)
    candidate_text = "\n".join(
        [
            format_paper(pair["candidatePaper"], "candidate", args),
            f"pair signals: {format_features(pair['features'], args.feature_decimals)}",
            f"pair source: {pair['label']['source']} ({pair['label']['strength']})",
        ]
    )
    return seed_text, candidate_text


def example_weight(pair: Dict[str, Any], args: argparse.Namespace) -> float:
    source = pair["label"]["source"]
    strength = pair["label"]["strength"]
    if source == "judged":
        return args.weight_judged
    if source == "hard_negative":
        return args.weight_hard_negative
    if strength == "silver":
        return args.weight_weak_silver
    return args.weight_weak_bronze


def class_weights_from_pairs(pairs: Sequence[Dict[str, Any]]) -> torch.Tensor:
    counts = np.zeros(3, dtype=np.float32)
    for pair in pairs:
        counts[int(pair["label"]["relevance"])] += 1.0
    counts = np.maximum(counts, 1.0)
    inverse = counts.sum() / counts
    normalized = inverse / inverse.mean()
    return torch.tensor(normalized.tolist(), dtype=torch.float32)


@dataclass
class EncodedExample:
    input_ids: List[int]
    attention_mask: List[int]
    labels: int
    example_weight: float


class RelatedPairDataset(Dataset):
    def __init__(
        self,
        pairs: Sequence[Dict[str, Any]],
        tokenizer: AutoTokenizer,
        args: argparse.Namespace,
        max_length: int,
    ) -> None:
        self.pairs = list(pairs)
        self.examples: List[EncodedExample] = []
        seed_texts: List[str] = []
        candidate_texts: List[str] = []

        for pair in self.pairs:
            seed_text, candidate_text = pair_to_text_pair(pair, args)
            seed_texts.append(seed_text)
            candidate_texts.append(candidate_text)

        encodings = tokenizer(
            seed_texts,
            candidate_texts,
            truncation="longest_first",
            padding=False,
            max_length=max_length,
        )

        for index, pair in enumerate(self.pairs):
            self.examples.append(
                EncodedExample(
                    input_ids=list(encodings["input_ids"][index]),
                    attention_mask=list(encodings["attention_mask"][index]),
                    labels=int(pair["label"]["relevance"]),
                    example_weight=float(example_weight(pair, args)),
                ),
            )

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int) -> Dict[str, Any]:
        example = self.examples[index]
        return {
            "input_ids": example.input_ids,
            "attention_mask": example.attention_mask,
            "labels": example.labels,
            "example_weights": example.example_weight,
        }


class WeightedSequenceClassificationTrainer(Trainer):
    def __init__(self, *args: Any, class_weights: torch.Tensor | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.class_weights = class_weights

    def compute_loss(
        self,
        model: torch.nn.Module,
        inputs: Dict[str, Any],
        return_outputs: bool = False,
        num_items_in_batch: int | None = None,
    ) -> Any:
        labels = inputs.pop("labels")
        example_weights = inputs.pop("example_weights", None)
        outputs = model(**inputs)
        logits = outputs.get("logits")

        class_weights = None
        if self.class_weights is not None:
            class_weights = self.class_weights.to(logits.device)

        loss = F.cross_entropy(
            logits,
            labels,
            reduction="none",
            weight=class_weights,
        )
        if example_weights is not None:
            loss = loss * example_weights.to(logits.device)
        loss = loss.mean()
        return (loss, outputs) if return_outputs else loss


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def macro_f1_score(labels: np.ndarray, predictions: np.ndarray) -> float:
    scores: List[float] = []
    for target in range(3):
        true_positive = int(np.sum((predictions == target) & (labels == target)))
        false_positive = int(np.sum((predictions == target) & (labels != target)))
        false_negative = int(np.sum((predictions != target) & (labels == target)))
        if true_positive == 0 and false_positive == 0 and false_negative == 0:
            scores.append(0.0)
            continue
        precision = true_positive / max(1, true_positive + false_positive)
        recall = true_positive / max(1, true_positive + false_negative)
        if precision + recall == 0:
            scores.append(0.0)
        else:
            scores.append(2 * precision * recall / (precision + recall))
    return float(sum(scores) / len(scores))


def dcg_at_k(relevances: Sequence[int], k: int) -> float:
    total = 0.0
    for index, relevance in enumerate(relevances[:k]):
        total += (2**relevance - 1) / math.log2(index + 2)
    return total


def grouped_ranking_metrics(
    pairs: Sequence[Dict[str, Any]],
    logits: np.ndarray,
) -> Dict[str, float]:
    probabilities = softmax(logits)
    expected_scores = probabilities @ RELEVANCE_VALUES
    groups: Dict[str, List[tuple[float, int]]] = defaultdict(list)

    for pair, expected in zip(pairs, expected_scores):
        group_id = pair.get("seedCaseId") or pair["seedPaper"]["id"]
        groups[group_id].append((float(expected), int(pair["label"]["relevance"])))

    ndcg_scores: List[float] = []
    mrr_scores: List[float] = []
    recall_scores: List[float] = []

    for rows in groups.values():
        ranked = sorted(rows, key=lambda item: item[0], reverse=True)
        actual_relevances = [relevance for _, relevance in ranked]
        ideal_relevances = sorted(actual_relevances, reverse=True)

        ideal_dcg = dcg_at_k(ideal_relevances, 10)
        ndcg_scores.append(dcg_at_k(actual_relevances, 10) / ideal_dcg if ideal_dcg > 0 else 0.0)

        reciprocal_rank = 0.0
        for index, (_, relevance) in enumerate(ranked[:10]):
            if relevance > 0:
                reciprocal_rank = 1.0 / float(index + 1)
                break
        mrr_scores.append(reciprocal_rank)

        relevant_total = sum(1 for _, relevance in rows if relevance > 0)
        relevant_hits = sum(1 for _, relevance in ranked[:20] if relevance > 0)
        recall_scores.append(relevant_hits / relevant_total if relevant_total else 0.0)

    return {
        "ndcg_at_10": float(sum(ndcg_scores) / max(1, len(ndcg_scores))),
        "mrr_at_10": float(sum(mrr_scores) / max(1, len(mrr_scores))),
        "recall_at_20": float(sum(recall_scores) / max(1, len(recall_scores))),
    }


def build_compute_metrics(eval_pairs: Sequence[Dict[str, Any]]):
    def compute_metrics(eval_prediction: Any) -> Dict[str, float]:
        logits = np.asarray(eval_prediction.predictions)
        labels = np.asarray(eval_prediction.label_ids)
        predictions = logits.argmax(axis=1)
        probabilities = softmax(logits)

        metrics = {
            "accuracy": float(np.mean(predictions == labels)),
            "macro_f1": macro_f1_score(labels, predictions),
            "mean_expected_relevance": float(np.mean(probabilities @ RELEVANCE_VALUES)),
        }
        metrics.update(grouped_ranking_metrics(eval_pairs, logits))
        return metrics

    return compute_metrics


def resolve_max_length(tokenizer: AutoTokenizer, requested_max_length: int) -> int:
    model_max_length = tokenizer.model_max_length
    if model_max_length and model_max_length < 100_000:
        return min(requested_max_length, int(model_max_length))
    return requested_max_length


def save_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def save_predictions(
    path: Path,
    pairs: Sequence[Dict[str, Any]],
    logits: np.ndarray,
) -> None:
    probabilities = softmax(logits)
    with path.open("w", encoding="utf-8") as handle:
        for pair, probs in zip(pairs, probabilities):
            expected_relevance = float(np.dot(probs, RELEVANCE_VALUES))
            row = {
                "id": pair["id"],
                "pairKey": pair["pairKey"],
                "seedCaseId": pair.get("seedCaseId"),
                "seedPaperId": pair["seedPaper"]["id"],
                "candidatePaperId": pair["candidatePaper"]["id"],
                "goldRelevance": int(pair["label"]["relevance"]),
                "predictedRelevance": int(np.argmax(probs)),
                "expectedRelevance": expected_relevance,
                "probabilities": {
                    "irrelevant": float(probs[0]),
                    "related": float(probs[1]),
                    "highly_related": float(probs[2]),
                },
            }
            handle.write(json.dumps(row) + "\n")


def main() -> None:
    args = parse_args()
    set_seed(args.seed)

    train_pairs = read_jsonl(args.train)
    dev_pairs = read_jsonl(args.dev)
    train_pairs = maybe_sample(train_pairs, args.sample_train, args.seed)
    dev_pairs = maybe_sample(dev_pairs, args.sample_dev, args.seed + 1)

    tokenizer = AutoTokenizer.from_pretrained(
        args.model_name,
        use_fast=True,
        trust_remote_code=args.trust_remote_code,
    )
    if tokenizer.pad_token is None and tokenizer.eos_token is not None:
        tokenizer.pad_token = tokenizer.eos_token

    max_length = resolve_max_length(tokenizer, args.max_length)

    train_dataset = RelatedPairDataset(train_pairs, tokenizer, args, max_length)
    dev_dataset = RelatedPairDataset(dev_pairs, tokenizer, args, max_length)

    model = AutoModelForSequenceClassification.from_pretrained(
        args.model_name,
        num_labels=3,
        trust_remote_code=args.trust_remote_code,
    )
    model.config.label2id = {
        "irrelevant": 0,
        "related": 1,
        "highly_related": 2,
    }
    model.config.id2label = {value: key for key, value in model.config.label2id.items()}

    if args.gradient_checkpointing:
        model.gradient_checkpointing_enable()

    class_weights = class_weights_from_pairs(train_pairs)
    output_dir = Path(args.output_dir)

    training_args = TrainingArguments(
        output_dir=str(output_dir),
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        warmup_ratio=args.warmup_ratio,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.train_batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        dataloader_num_workers=args.num_workers,
        evaluation_strategy="epoch",
        save_strategy="epoch",
        logging_strategy="steps",
        logging_steps=args.logging_steps,
        load_best_model_at_end=True,
        metric_for_best_model="ndcg_at_10",
        greater_is_better=True,
        save_total_limit=args.save_total_limit,
        report_to=[],
        remove_unused_columns=False,
        bf16=args.bf16,
        fp16=args.fp16,
        seed=args.seed,
    )

    trainer = WeightedSequenceClassificationTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=dev_dataset,
        tokenizer=tokenizer,
        compute_metrics=build_compute_metrics(dev_pairs),
        class_weights=class_weights,
    )

    trainer.train()
    trainer.save_model()

    eval_metrics = trainer.evaluate(eval_dataset=dev_dataset)
    prediction_output = trainer.predict(dev_dataset)

    manifest = {
        "train_path": args.train,
        "dev_path": args.dev,
        "model_name": args.model_name,
        "max_length": max_length,
        "train_examples": len(train_pairs),
        "dev_examples": len(dev_pairs),
        "class_weights": class_weights.tolist(),
        "hyperparameters": {
            "epochs": args.epochs,
            "learning_rate": args.learning_rate,
            "weight_decay": args.weight_decay,
            "warmup_ratio": args.warmup_ratio,
            "train_batch_size": args.train_batch_size,
            "eval_batch_size": args.eval_batch_size,
            "gradient_accumulation": args.gradient_accumulation,
        },
        "metrics": {key: float(value) for key, value in eval_metrics.items() if isinstance(value, (int, float))},
    }

    save_json(output_dir / "training_manifest.json", manifest)
    save_predictions(output_dir / "dev_predictions.jsonl", dev_pairs, np.asarray(prediction_output.predictions))


if __name__ == "__main__":
    main()
