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
    │   ├── Research Agent (streamText loop + tools + phase gates)
    │   ├── Auto-fix layer (error classification + code patching)
    │   ├── Sub-agents (scouts, synthesizer, architect, reviewer, provocateur, visualizer)
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
      papers/[id]/            # Paper CRUD, LLM ops, references
      research/[id]/          # Research projects, agent, steps, hypotheses, chat, figures
      mind-palace/            # Rooms, insights, review sessions
      synthesis/[id]/         # Multi-paper synthesis
      discovery/              # Citation graph exploration
      admin/                  # Usage stats, events, users, batch processing
      auth/                   # Login, signup, sessions
      settings/               # Model config, API keys, remote hosts
      search/                 # Full-text search, recommendations
      tags/                   # Clustering, merging, cleanup
      collections/            # Collection CRUD
      notebook/               # Research notebook entries
  components/
    research/                 # Dashboard, experiment cards, metric chart, chat, notification bell
    mind-palace/              # Insight cards, review UI
    synthesis/                # Synthesis progress and output
    chat/                     # Paper chat, selection popover
    layout/                   # App shell, sidebar, header
    ui/                       # shadcn/ui primitives
  lib/
    research/                 # Agent core, phase gates, auto-fix, sub-agents, remote executor
      agent.ts                # Main agent loop with phase-gated tools
      auto-fix.ts             # Error classification and code patching
      sub-agent.ts            # Scout, synthesizer, architect, reviewer, provocateur, visualizer
      remote-executor.ts      # SSH + rsync job submission with ControlMaster
      research-state.ts       # Structured state document for agent context
      research-summary.ts     # Paper-style summary generation
      metric-recompute.ts     # Canonical metric remapping
      figure-captioner.ts     # Auto-caption figures as Artifact records
      workspace.ts            # Cached workspace state (file manifests, packages, results)
      task-classifier.ts      # Experiment taxonomy classification
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
  schema.prisma               # Database schema (~50 models)
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
  → startResearchAgent() runs as detached background process
  → Builds system prompt (or condensed version for non-Claude models)
  → Injects RESEARCH_STATE.md (structured project state from DB)
  → streamText() loop with ~40 tools, phase-gated
      - Phase gates enforce: literature → hypothesis → experiment → analysis → reflection
      - Tool calls checked against current phase (e.g., execute_remote blocked outside experiment)
      - Steps logged to DB as ResearchStep records
      - Findings logged as ResearchLogEntry records
      - Experiment results recorded as ExperimentResult records
      - Approach branches tracked in ApproachBranch tree
      - Artifacts (figures, results) registered and auto-captioned
  → Auto-fix layer intercepts failed jobs:
      - CODE_ERROR → patch + resubmit (up to 2 attempts)
      - RESEARCH_FAILURE → record as real result
      - RESOURCE_ERROR → queue for user attention
  → Sub-agents run in parallel (AgentTask records)
  → Remote jobs run independently (RemoteJob records)
  → Session auto-continues when step limit reached (up to 20 sessions)
  → Non-Claude models: outer directive loop with phase-specific prompts
```

### Research chat

```
User sends a message in project chat
  → Server-side retrieval gathers context from DB:
      - Hypotheses, experiment results, approaches
      - Breakthroughs and decisions from research log
      - Paper summaries, file listings, figure artifacts
  → If question references an image file:
      - Read the image from disk
      - Attach as multimodal vision input
  → streamText() with retrieved context as system prompt
  → User directives forwarded to running agent via research log
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

SQLite in WAL mode. The schema has ~50 models organized into groups:

- **Auth & Observability**: User, UserSession, LlmUsageLog, AppEvent
- **Core**: Paper, Tag, TagCluster, Collection, Reference, Conversation, ChatMessage
- **Research**: ResearchProject, ResearchIteration, ResearchStep, ResearchHypothesis, ResearchLogEntry, RemoteHost, RemoteJob, AgentTask, AgentMemory, AgentCapability
- **Experiment Tracking**: ApproachBranch (tree structure), ExperimentResult (metrics + verdict), Artifact (figures, files, captioned)
- **Knowledge**: MindPalaceRoom, Insight, NotebookEntry, DiscoverySession, DiscoveryProposal
- **Synthesis**: SynthesisSession, SynthesisSection, SynthesisPaper
- **Processing**: ProcessingBatch, PaperFigure, PaperEngagement

Key schema additions:

- `ResearchProject.currentPhase` — tracks the phase state machine (literature/hypothesis/experiment/analysis/reflection)
- `ResearchProject.metricSchema` — JSON array of canonical metrics with name, direction, and description
- `ApproachBranch` — self-referential tree (parent/children) for organizing research directions
- `ExperimentResult` — links job, hypothesis, approach branch, canonical metrics, raw metrics, verdict, and reflection
- `Artifact` — typed files (figure/model/results/code/log) with captions and key takeaways, linked to experiments
- `RemoteJob.fixAttempts` / `errorClass` — tracks auto-fix attempts and error classification

Prisma generates the client to `src/generated/prisma/client`. The singleton lives at `src/lib/prisma.ts` with dev-mode caching on `globalThis`.

## Authentication

Cookie-based sessions. `getCurrentUser()` in `src/lib/auth.ts` reads the session cookie and returns the user. A default user is auto-provisioned on first access. Multi-user is supported but not the primary use case.

## LLM provider abstraction

`src/lib/llm/provider.ts` wraps the Vercel AI SDK to support:

- **OpenAI** — direct API
- **Anthropic** — direct API
- **Proxy** — any OpenAI-compatible endpoint (OpenRouter, LiteLLM, Azure, vLLM, etc.)

Model selection is configurable in settings. The provider instruments all calls for cost tracking via `src/lib/usage.ts`. Non-Claude models receive condensed system prompts and phase-specific directive loops to compensate for different tool-calling behavior.
