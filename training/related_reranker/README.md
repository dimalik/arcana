# Related Reranker Training

This directory contains a first practical cross-encoder trainer for the exported
related-paper pair corpus.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r training/related_reranker/requirements.txt
```

## Train

```bash
python training/related_reranker/train_cross_encoder.py \
  --train benchmark/training/related-papers-large/related.train.pairs.jsonl \
  --dev benchmark/training/related-papers-large/related.dev.pairs.jsonl \
  --output-dir artifacts/related_reranker_modernbert \
  --model-name answerdotai/ModernBERT-base \
  --max-length 1024 \
  --train-batch-size 4 \
  --eval-batch-size 8 \
  --gradient-accumulation 4 \
  --epochs 3 \
  --learning-rate 2e-5 \
  --bf16 \
  --gradient-checkpointing
```

## Notes

- The script trains a 3-way relevance classifier: `0`, `1`, `2`.
- Judged pairs are weighted more heavily than weak labels.
- `score_open_reranker.py` is the inference worker used by the app-side
  `qwen3_reranker_v1` / `bge_reranker_v1` backends.
- `qwen3_reranker_v1` is treated as GPU-first by default and falls back to
  `bge_reranker_v1` when the Qwen worker cannot start or times out.
- If you run an external rerank service such as `embed-rerank`, the app can use
  it directly via:
  - `ARCANA_RELATED_RERANK_SERVICE_URL`
  - `ARCANA_RELATED_RERANK_SERVICE_MODE=openai|native`
  - optional `ARCANA_RELATED_RERANK_SERVICE_PATH`
  - optional `ARCANA_RELATED_RERANK_SERVICE_API_KEY`
- Dev metrics include grouped reranker-style metrics:
  - `ndcg_at_10`
  - `mrr_at_10`
  - `recall_at_20`
- The trainer saves:
  - model checkpoints
  - `training_manifest.json`
  - `dev_predictions.jsonl`

## Suggested first experiments

- `answerdotai/ModernBERT-base`
- `answerdotai/ModernBERT-large`
- `allenai/scibert_scivocab_uncased`

For `scibert`, lower `--max-length` to `512`.
