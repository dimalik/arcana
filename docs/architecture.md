# Architecture

Arcana is a Next.js 14 application using the App Router. Everything runs as a single process — no separate backend, no message queues. The database is SQLite via Prisma, and all AI operations use the Vercel AI SDK.

## High-level overview

```
Browser (React)
    ↕ HTTP / SSE streams
Next.js App Router
    ├── Pages (src/app/**/page.tsx)
    ├── API Routes (src/app/api/**/route.ts)
    ├── Library layer (src/lib/**)
    │   ├── Research Agent (streamText loop + tools)
    │   ├── LLM providers (OpenAI, Anthropic, proxy)
    │   ├── Import pipeline (arXiv, S2, CrossRef, PDF)
    │   └── Synthesis engine
    └── Prisma + SQLite (prisma/dev.db)
          └── WAL mode for concurrent reads
```

## Project structure

```
src/
  app/                        # Next.js App Router
    (main)/                   # Main layout group
    api/
      papers/[id]/            # Paper CRUD, LLM ops, references, concepts
      research/[id]/          # Research projects, agent, steps, hypotheses
      mind-palace/            # Rooms, insights, review sessions
      synthesis/[id]/         # Multi-paper synthesis
      discovery/              # Citation graph exploration
      admin/                  # Usage stats, events, users
      auth/                   # Login, signup, sessions
      settings/               # Model config, API keys, remote hosts
      search/                 # Full-text search, recommendations
      tags/                   # Clustering, merging, cleanup
      collections/            # Collection CRUD
      notebook/               # Research notebook entries
  components/
    research/                 # Agent workspace, phase tabs, step cards
    mind-palace/              # Insight cards, review UI
    synthesis/                # Synthesis progress and output
    chat/                     # Paper chat, selection popover
    layout/                   # App shell, sidebar, header
    ui/                       # shadcn/ui primitives
  lib/
    research/                 # Agent core, remote executor, sub-agents
    llm/                      # Provider abstraction, prompts, models
    import/                   # arXiv, Semantic Scholar, CrossRef, PDF
    mind-palace/              # SM-2 spaced repetition
    synthesis/                # Synthesis engine
    processing/               # Background paper processing queue
    prisma.ts                 # DB singleton
    auth.ts                   # Cookie-based authentication
    usage.ts                  # LLM cost tracking
    logger.ts                 # Structured event logging
prisma/
  schema.prisma               # Database schema (~45 models)
  dev.db                      # SQLite database
```

## Data flow

### Paper import

```
User adds URL/arXiv ID/PDF
  → API route validates input
  → Import module fetches metadata (OpenAlex, S2, CrossRef)
  → Paper record created in DB
  → Processing queue picks it up:
      1. Extract full text (pdf-parse, OCR fallback)
      2. Fetch additional metadata
      3. Summarize with LLM
      4. Auto-categorize and tag
      5. Extract references
      6. Extract citation contexts
```

### Research agent

```
User starts agent session
  → API route creates SSE stream
  → startResearchAgent() builds system prompt with:
      - Project brief and methodology
      - Papers in collection
      - Remote host info + GPU probes
      - Agent capabilities and process memories
      - Shared utilities
  → streamText() loop with tools
      - Agent calls tools (search, read, write, execute, etc.)
      - Tool results feed back into the conversation
      - Steps logged to DB as ResearchStep records
      - Findings logged as ResearchLogEntry records
      - Hypotheses tracked as ResearchHypothesis records
  → Sub-agents run in parallel (AgentTask records)
  → Remote jobs run independently (RemoteJob records)
  → Session auto-continues when step limit reached
```

### Synthesis

```
User selects papers + depth
  → SynthesisSession created
  → Engine runs through phases:
      PLANNING → MAPPING → GRAPHING → EXPANDING → REDUCING → COMPOSING
  → Each phase calls LLM with focused prompts
  → Sections generated and stored
  → User can export to PDF/LaTeX
```

## Database

SQLite in WAL mode. The schema has ~45 models organized into groups:

- **Auth & Observability**: User, UserSession, LlmUsageLog, AppEvent
- **Core**: Paper, Tag, TagCluster, Collection, Reference, Conversation, ChatMessage
- **Research**: ResearchProject, ResearchIteration, ResearchStep, ResearchHypothesis, RemoteHost, RemoteJob, AgentTask, AgentMemory, AgentCapability
- **Knowledge**: MindPalaceRoom, Insight, NotebookEntry, DiscoverySession, DiscoveryProposal
- **Synthesis**: SynthesisSession, SynthesisSection, SynthesisPaper
- **Processing**: ProcessingBatch, PaperFigure, PaperEngagement

Prisma generates the client to `src/generated/prisma/client`. The singleton lives at `src/lib/prisma.ts` with dev-mode caching on `globalThis`.

## Authentication

Cookie-based sessions. `getCurrentUser()` in `src/lib/auth.ts` reads the session cookie and returns the user. A default user is auto-provisioned on first access. Multi-user is supported but not the primary use case.

## LLM provider abstraction

`src/lib/llm/provider.ts` wraps the Vercel AI SDK to support:

- **OpenAI** — direct API
- **Anthropic** — direct API
- **Proxy** — any OpenAI-compatible endpoint (OpenRouter, LiteLLM, Azure, vLLM, etc.)

Model selection is configurable in settings. The provider instruments all calls for cost tracking via `src/lib/usage.ts`.
