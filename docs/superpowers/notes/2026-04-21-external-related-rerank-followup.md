## External Related-Rerank Follow-Up

This note parks the external-model work for related-paper reranking so it can be resumed later without re-discovering the same constraints.

### Landed

- `src/lib/papers/retrieval/open-reranker.ts` can now use an external rerank service before falling back to the local Python worker.
- Supported env vars:
  - `ARCANA_RELATED_RERANK_SERVICE_URL`
  - `ARCANA_RELATED_RERANK_SERVICE_MODE=openai|native`
  - `ARCANA_RELATED_RERANK_SERVICE_PATH`
  - `ARCANA_RELATED_RERANK_SERVICE_API_KEY`
  - `ARCANA_RELATED_RERANK_SERVICE_TIMEOUT_MS`
- The client now accepts both response shapes seen in the wild:
  - native-style `{ results: [...] }`
  - OpenAI-style `{ data: [...] }`
- It also normalizes either `relevance_score` or `score` fields and passes the configured model id through in the service request body.

### What Was Tried

- Local `embed-rerank` install in `/tmp/embed-rerank-service-py313/.venv`
- Python 3.13 was required; Python 3.10 was too old.
- `embed-rerank` was missing `psutil` at runtime and needed that installed manually.
- Service startup against Hugging Face-hosted models stalled on Xet-backed downloads over a slow connection.

### Important Findings

- `embed-rerank` is a viable service seam for external reranking, but cold start and model download behavior need to be handled explicitly.
- Its packaged MLX reranker implementation is not a full transformer cross-encoder; it is a lighter MLX-native approximation. Treat it as an experiment, not a guaranteed quality win.
- For a first serious service-backed evaluation, a torch/MPS cross-encoder is the safer baseline than assuming the MLX path will be better.
- The OpenAI-compatible related-paper rerankers produced somewhat better results in spot checks, but they are still too slow for the current interactive product surface.
- **Current product decision:** keep `feature_v1` as the live default until reranking is made fast enough via caching, service-backed warm models, or a cheaper model family.

### Resume Plan

When bandwidth is stable again:

1. Start a local rerank service with Xet disabled.
2. Validate the transport path with small models first.
3. Then compare stronger rerankers on the judged related-papers set.
4. Only reconsider making it live if latency is acceptable for the interactive related-papers surface.

Suggested startup sequence:

```bash
cd /tmp/embed-rerank-service-py313
source .venv/bin/activate

HF_HUB_DISABLE_XET=1 \
BACKEND=torch \
MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2 \
RERANKER_BACKEND=torch \
RERANKER_MODEL_ID=cross-encoder/ms-marco-MiniLM-L-6-v2 \
RERANK_BATCH_SIZE=8 \
embed-rerank --host 127.0.0.1 --port 8000
```

Then point the app at it:

```bash
export ARCANA_RELATED_RERANK_SERVICE_URL=http://127.0.0.1:8000
export ARCANA_RELATED_RERANK_SERVICE_MODE=openai
export ARCANA_RELATED_RERANKER_BACKEND=bge_reranker_v1
```

After the path is proven, try stronger models:

- `BAAI/bge-reranker-v2-m3`
- `BAAI/bge-reranker-v2-gemma`
- `Qwen/Qwen3-Reranker-0.6B`

### Success Criteria

- The external service is warm and stable across repeated related-paper requests.
- The judged related-papers benchmark beats `feature_v1`.
- Live canaries improve:
  - `Attention Is All You Need`
- `Phi-3 Technical Report`
- reward-shaping papers
- Failure mode stays safe: short list or empty, never confident junk.
- Interactive latency is good enough that the related-papers panel no longer feels sluggish on first view.
