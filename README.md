# Arcana

**Your AI research lab in a browser.** Import papers, chat with them, formulate hypotheses, run experiments on remote GPUs, critique results, and iterate — all from one place.

Arcana is for researchers who don't just read papers — they act on them. It connects the full arc from literature review to novel findings: search the literature, spot gaps, write experiment code, execute it on your GPU cluster, analyze results, and loop back with better hypotheses.

---

## What can it do?

### Import from anywhere
arXiv, DOI, OpenReview, ACL Anthology, URL, or raw PDF. Arcana auto-fetches metadata from OpenAlex, Semantic Scholar, and CrossRef, extracts full text (with OCR fallback), and organizes everything with smart tagging.

### Talk to your papers
Ask questions grounded in the actual paper content. Highlight a passage and get instant explanations. Compare methodologies across papers. Extract code from methods sections. Run custom prompts against any paper.

### Run autonomous research projects
The research agent follows the scientific method in a loop:

1. **Literature** — searches databases, reads papers, extracts methods and baselines
2. **Hypotheses** — formulates specific, testable claims from gaps in the literature
3. **Experiment** — writes Python code with real datasets, executes on your remote GPU servers
4. **Critique** — an adversarial reviewer tears apart the results, finds confounds, challenges claims
5. **Iterate** — consults the literature and your Mind Palace for techniques to try next

The agent writes to a persistent `RESEARCH_LOG.md` you can read and edit at any time to steer its direction. It handles multi-GPU setups, manages Python environments automatically, and supports parallel experiment sweeps across multiple hosts.

### Multi-agent parallelism
The agent doesn't work alone. It dispatches **literature scouts** to search multiple research angles simultaneously, runs **adversarial reviews** with a separate hostile-reviewer persona, and submits **experiment sweeps** across your GPU cluster — all running in parallel while the lead agent continues thinking.

### Build a Mind Palace
Distill papers into insights organized by topic (rooms). A spaced-repetition system surfaces them for review on schedule. The research agent can query your Mind Palace to find relevant techniques when experiments need improvement — your accumulated knowledge feeds back into active research.

### Synthesize literature reviews
Select papers, choose analysis depth, and generate structured synthesis reports with methodology comparisons, thematic analysis, gap identification, and citations. Export to PDF or LaTeX.

### Explore citation graphs
Start from seed papers and traverse citation networks using Semantic Scholar. Discover related work you didn't know existed, with smart deduplication against your library.

### Keep a research notebook
Collect highlights, explanations, chat excerpts, and personal notes across all papers in a two-panel research journal. Filter by type, search across entries, and build your thinking over time.

---

## Quick start

```bash
git clone https://github.com/dimalik/arcana.git
cd arcana
npm install
```

Create a `.env` file:

```env
# At least one LLM provider
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."

# Optional: OpenAI-compatible proxy (OpenRouter, LiteLLM, Azure, etc.)
# LLM_PROXY_URL="https://your-proxy.example.com/v1"

# Optional: higher Semantic Scholar rate limits
# S2_API_KEY="..."
```

Initialize and run:

```bash
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router), TypeScript |
| UI | Tailwind CSS, shadcn/ui, Radix |
| Database | Prisma 6 + SQLite |
| AI | Vercel AI SDK v6 (OpenAI, Anthropic, or any compatible proxy) |
| PDF | pdf-parse, pdfjs-dist, Tesseract.js (OCR) |
| Graphs | @xyflow/react, Dagre, Recharts |
| Remote execution | SSH + rsync to GPU servers |

---

## Documentation

See the [`docs/`](docs/) directory:

- **[Architecture](docs/architecture.md)** — system design, data flow, and project structure
- **[Research Agent](docs/research-agent.md)** — how the autonomous agent works, its tools, and multi-agent coordination
- **[Remote Execution](docs/remote-execution.md)** — setting up GPU servers for experiment execution
- **[LLM Configuration](docs/llm-configuration.md)** — providers, proxies, and model selection
- **[API Reference](docs/api-reference.md)** — all API endpoints

---

## License

MIT
