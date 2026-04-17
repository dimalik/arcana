# GROBID Local Setup

## Prerequisites

- Docker Desktop or a compatible container runtime
- At least 4 GB of RAM available for the GROBID container

## Quick Start

```bash
docker run --rm -d --name grobid \
  -p 8070:8070 \
  -e GROBID_NB_THREADS=4 \
  lfoppiano/grobid:0.8.1
```

Verify it is running:

```bash
curl http://localhost:8070/api/isalive
```

Expected: HTTP 200

## Environment Variables

Add these to `.env` or copy from `.env.example`:

```env
GROBID_SERVER_URL=http://localhost:8070
GROBID_INTERACTIVE_CONCURRENCY=1
GROBID_BACKFILL_CONCURRENCY=2
```

The default concurrency budget is `1 + 2 = 3`, which intentionally leaves one
thread of headroom on a 4-thread GROBID instance.

## Smoke Test

Health-only:

```bash
GROBID_SERVER_URL=http://127.0.0.1:8070 \
  npx tsx scripts/smoke-grobid-references.ts --health
```

Run against a specific paper already in the local DB:

```bash
GROBID_SERVER_URL=http://127.0.0.1:8070 \
  npx tsx scripts/smoke-grobid-references.ts --paper-id <paper-id> --sample 5
```

Run directly against a PDF path without touching the DB:

```bash
GROBID_SERVER_URL=http://127.0.0.1:8070 \
  npx tsx scripts/smoke-grobid-references.ts --pdf uploads/example.pdf --sample 5
```

Use `--grobid-only` when you want to isolate preflight + GROBID behavior without
the LLM fallback path.

## Resource Notes

- GROBID is memory-intensive. With 4 worker threads, expect 2-4 GB RAM usage.
- On Apple Silicon Macs, use the `linux/amd64` platform flag if the default image fails:

```bash
docker run --rm -d --name grobid --platform linux/amd64 \
  -p 8070:8070 \
  lfoppiano/grobid:0.8.1
```

- GROBID returns HTTP 503 when all worker threads are busy. The client handles
  this with admission control and circuit breaking in
  `src/lib/references/grobid/admission.ts`.

## Stopping

```bash
docker stop grobid
```

## Troubleshooting

- `503` during backfill: reduce `GROBID_BACKFILL_CONCURRENCY` or increase `GROBID_NB_THREADS`.
- Slow startup: GROBID loads models on first request. The first call can take 30-60 seconds.
- ARM/M1 compatibility: if you see segfaults, try `--platform linux/amd64`.
