# Arcana

A personal research workbench for reading, analyzing, and experimenting with academic papers. Import papers from arXiv, DOI, or PDF, then use AI to summarize, chat, extract concepts, compare methodologies, and run autonomous research projects with remote GPU execution.

Built for researchers who want to go beyond reading — Arcana helps you formulate hypotheses, run experiments, critique results, consult the literature, and iterate until you find something new.

## Features

### Paper Library
- Import from arXiv, DOI, OpenReview, URL, or direct PDF upload
- Auto-fetches metadata from OpenAlex, Semantic Scholar, and CrossRef
- Full-text extraction with OCR fallback
- Tag management with auto-clustering by research domain
- Collections for organizing papers by project or topic

### AI Analysis
- Structured summarization (core problem, novelty, methodology, results)
- Paper-aware chat — ask questions grounded in the paper's content
- Code extraction and generation from paper methods
- Cross-paper methodology comparison and gap finding
- Concept hierarchies extracted from paper content
- Custom prompts for any LLM operation

### Research Agent
An autonomous research loop modeled on the scientific method:

1. **Literature** — searches for papers, reads them, extracts methods and baselines
2. **Hypotheses** — formulates specific, testable claims based on gaps in the literature
3. **Experiment** — writes runnable Python code with real datasets and baselines, executes on remote GPU servers
4. **Critique** — interrogates results, compares to literature, identifies weaknesses
5. **Back to literature** — when results are unexpected, searches existing papers and Mind Palace insights for techniques to adapt
6. **Follow-up** — designs literature-informed follow-up experiments, iterates

The agent writes to a persistent research log (RESEARCH_LOG.md) that you can read and edit at any time to steer its direction. It supports user-defined capabilities (W&B, HuggingFace, custom data sources) and probes GPU hardware to handle multi-GPU setups.

### Mind Palace
Spaced repetition for research knowledge. Distill papers into insights organized by room (topic), then review them on an SM-2 schedule. The research agent can query your Mind Palace to find relevant techniques when experiments need improvement.

### Synthesis
Combine multiple papers into structured reports. Select papers, choose analysis depth, and generate a synthesis with methodology comparisons, thematic analysis, and identified gaps. Export to PDF or LaTeX.

### Discovery
Explore citation graphs starting from seed papers. Uses Semantic Scholar's paper graph to surface related work, with smart deduplication against your existing library.

### Notebook
Collect selections, explanations, chat excerpts, and personal notes across all papers. Filter by type or source paper.

## Tech Stack

- **Framework**: Next.js 14 (App Router), TypeScript, Tailwind CSS
- **UI**: shadcn/ui + Radix primitives
- **Database**: Prisma 6 + SQLite
- **AI**: Vercel AI SDK v6 (OpenAI, Anthropic, or any OpenAI-compatible proxy)
- **PDF**: pdf-parse, pdfjs-dist, Tesseract.js for OCR
- **Remote execution**: SSH + rsync to GPU servers

## Setup

```bash
git clone https://github.com/dimalik/arcana.git
cd arcana
npm install
```

Create a `.env` file:

```env
# At least one LLM provider is required
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."

# Optional: OpenAI-compatible proxy endpoint
# LLM_PROXY_URL="https://your-proxy.example.com/v1"

# Optional: Semantic Scholar API key (higher rate limits)
# S2_API_KEY="..."
```

Initialize the database and start:

```bash
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
src/
  app/                  # Next.js pages and API routes
    api/
      papers/           # Paper CRUD, LLM operations, references
      research/         # Research projects, agent, steps, hypotheses
      mind-palace/      # Rooms, insights, review sessions
      synthesis/        # Multi-paper synthesis
      discovery/        # Citation graph exploration
      admin/            # Usage stats, DB export/import
  components/
    research/           # Agent activity bar, phase tabs, workspace
    mind-palace/        # Insight cards, review sessions
    synthesis/          # Synthesis UI
    chat/               # Paper chat, selection popover
    layout/             # App shell, topbar, navigation
    ui/                 # shadcn/ui primitives
  lib/
    research/           # Agent core, remote executor, orchestrator
    llm/                # Provider abstraction, prompts, models
    import/             # arXiv, S2, CrossRef, PDF finder
    mind-palace/        # Spaced repetition algorithm
    synthesis/          # Synthesis engine
prisma/
  schema.prisma         # Database schema
```

## License

MIT
