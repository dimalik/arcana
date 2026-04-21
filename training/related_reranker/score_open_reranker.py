#!/usr/bin/env python3
"""Score related-paper candidates with an open reranker model.

Reads a JSON request from stdin and emits JSON scores to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Dict, List, TypeVar

import torch
from transformers import (
    AutoModelForCausalLM,
    AutoModelForSequenceClassification,
    AutoTokenizer,
)


@dataclass
class RequestDocument:
    id: str
    text: str


@dataclass
class RerankerRequest:
    model_id: str
    model_type: str
    instruction: str
    max_length: int
    batch_size: int
    device: str | None
    trust_remote_code: bool
    query: str
    documents: List[RequestDocument]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score related-paper candidates.")
    parser.add_argument("--stdin", action="store_true", help="Read JSON request from stdin.")
    return parser.parse_args()


def parse_request() -> RerankerRequest:
    payload = json.loads(sys.stdin.read())
    documents = [
        RequestDocument(
            id=str(document["id"]),
            text=str(document["text"]),
        )
        for document in payload["documents"]
    ]
    return RerankerRequest(
        model_id=str(payload["modelId"]),
        model_type=str(payload["modelType"]),
        instruction=str(payload.get("instruction") or "").strip(),
        max_length=max(1, int(payload.get("maxLength", 1024))),
        batch_size=max(1, int(payload.get("batchSize", 8))),
        device=str(payload["device"]).strip() if payload.get("device") else None,
        trust_remote_code=bool(payload.get("trustRemoteCode", False)),
        query=str(payload["query"]),
        documents=documents,
    )


def resolve_device(request: RerankerRequest) -> str:
    if request.device:
        return request.device
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def resolve_dtype(device: str) -> torch.dtype | None:
    if device != "cuda":
        return None
    if torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16


T = TypeVar("T")


def batched(values: List[T], batch_size: int) -> List[List[T]]:
    return [values[index : index + batch_size] for index in range(0, len(values), batch_size)]


def score_sequence_classification(request: RerankerRequest) -> Dict[str, float]:
    device = resolve_device(request)
    dtype = resolve_dtype(device)
    tokenizer = AutoTokenizer.from_pretrained(
        request.model_id,
        trust_remote_code=request.trust_remote_code,
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        request.model_id,
        trust_remote_code=request.trust_remote_code,
        torch_dtype=dtype,
    ).eval()
    model.to(device)

    scores: Dict[str, float] = {}
    for batch in batched(request.documents, request.batch_size):
        documents = [document.text for document in batch]
        queries = [request.query] * len(batch)
        encoded = tokenizer(
            queries,
            documents,
            padding=True,
            truncation="longest_first",
            max_length=request.max_length,
            return_tensors="pt",
        )
        encoded = {key: value.to(device) for key, value in encoded.items()}

        with torch.inference_mode():
            logits = model(**encoded).logits.float()

        if logits.ndim == 1:
            batch_scores = torch.sigmoid(logits)
        elif logits.shape[-1] == 1:
            batch_scores = torch.sigmoid(logits.squeeze(-1))
        else:
            batch_scores = torch.softmax(logits, dim=-1)[:, -1]

        for document, score in zip(batch, batch_scores.tolist()):
            scores[document.id] = float(max(0.0, min(score, 1.0)))

    return scores


def encode_yes_no_token(tokenizer: AutoTokenizer, value: str) -> int:
    token_ids = tokenizer.encode(value, add_special_tokens=False)
    if not token_ids:
        raise RuntimeError(f"Unable to encode token '{value}' for Qwen reranker")
    return token_ids[0]


def build_qwen_input(request: RerankerRequest, document_text: str) -> str:
    return (
        f"<Instruct>: {request.instruction}\n"
        f"<Query>: {request.query}\n"
        f"<Document>: {document_text}"
    )


def score_qwen3(request: RerankerRequest) -> Dict[str, float]:
    device = resolve_device(request)
    dtype = resolve_dtype(device)
    tokenizer = AutoTokenizer.from_pretrained(request.model_id, padding_side="left")
    if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        request.model_id,
        torch_dtype=dtype,
    ).eval()
    model.to(device)

    yes_token_id = encode_yes_no_token(tokenizer, "yes")
    no_token_id = encode_yes_no_token(tokenizer, "no")

    scores: Dict[str, float] = {}
    for batch in batched(request.documents, request.batch_size):
        prompts = [build_qwen_input(request, document.text) for document in batch]
        encoded = tokenizer(
            prompts,
            padding=True,
            truncation=True,
            max_length=request.max_length,
            return_tensors="pt",
        )
        encoded = {key: value.to(device) for key, value in encoded.items()}

        with torch.inference_mode():
            logits = model(**encoded).logits[:, -1, :].float()

        yes_no_logits = torch.stack(
            [logits[:, no_token_id], logits[:, yes_token_id]],
            dim=-1,
        )
        batch_scores = torch.softmax(yes_no_logits, dim=-1)[:, 1]

        for document, score in zip(batch, batch_scores.tolist()):
            scores[document.id] = float(max(0.0, min(score, 1.0)))

    return scores


def main() -> None:
    args = parse_args()
    if not args.stdin:
        raise SystemExit("Use --stdin and pipe a JSON request into this script.")

    request = parse_request()
    if request.model_type == "qwen3":
        scores = score_qwen3(request)
    elif request.model_type == "sequence_classification":
        scores = score_sequence_classification(request)
    else:
        raise SystemExit(f"Unsupported model_type: {request.model_type}")

    print(
        json.dumps(
            {
                "modelId": request.model_id,
                "scores": [
                    {"id": document.id, "score": scores.get(document.id, 0.0)}
                    for document in request.documents
                ],
            }
        )
    )


if __name__ == "__main__":
    main()
