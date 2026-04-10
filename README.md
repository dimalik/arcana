# Arcana

<p align="center">
  <strong>Your AI research lab in a browser.</strong>
</p>

<p align="center">
  Import papers. Formulate hypotheses. Run experiments on GPUs. Iterate autonomously.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <img src="https://img.shields.io/badge/Next.js-14-black?style=for-the-badge&logo=next.js" alt="Next.js 14">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#key-features">Features</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="docs/getting-started.md">Docs</a>
</p>

---

Arcana connects the full arc of research — from reading papers to running experiments to writing up findings. An autonomous agent searches literature, spots gaps, writes experiment code, executes it on your GPU cluster, analyzes results, and loops back with better hypotheses. You steer; it does the legwork.

<p align="center">
  <img src="docs/screenshots/research-dashboard.png" alt="Research Dashboard" width="800">
</p>

## Key Features

- **[Phase-gated research agent](docs/research-agent.md)** — literature, hypothesis, experiment, analysis, reflection. Code-enforced gates prevent skipping steps.
- **[Remote GPU execution](docs/remote-execution.md)** — SSH + rsync to your machines. Auto environment setup, OOM detection, adaptive polling, workspace lifecycle management.
- **[Multi-agent parallelism](docs/research-agent.md#sub-agents)** — scouts, synthesizer, architect, adversarial reviewer, provocateur, and visualizer working concurrently.
- **[Auto-fix layer](docs/research-agent.md#auto-fix)** — classifies failures as code bugs, research failures, or infrastructure issues. Patches code errors and resubmits automatically.
- **[Static analysis](docs/remote-execution.md#pyright)** — runs pyright on the remote host before submission. Catches wrong imports, API mismatches, and type errors before burning GPU time.
- **[Structured experiment tracking](docs/research-agent.md#experiment-tracking)** — approach trees, canonical metrics, baselines, verdicts, and auto-generated research summaries.
- **[Multi-source paper import](docs/getting-started.md#importing-papers)** — arXiv, DOI, OpenReview, ACL Anthology, URL, PDF upload. Metadata from OpenAlex, Semantic Scholar, CrossRef.
- **[Paper conversations](docs/getting-started.md#paper-chat)** — ask questions grounded in actual content, compare methods across papers, extract code from methods sections.
- **[Research chat with vision](docs/research-agent.md#chat)** — query findings, methods, and figures with server-side retrieval and multimodal image analysis.
- **[Research dashboard](docs/research-agent.md#dashboard)** — narrative timeline, metric charts, approach trees, file browser, figures gallery, and integrated chat.
- **[Mind Palace](docs/getting-started.md#mind-palace)** — distill papers into topic-organized insights with spaced repetition. Feeds back into active research.
- **[Literature synthesis](docs/getting-started.md#synthesis)** — structured reviews with methodology comparison, gap analysis, and PDF/LaTeX export.
- **[Any LLM provider](docs/llm-configuration.md)** — OpenAI, Anthropic, or any OpenAI-compatible proxy (OpenRouter, LiteLLM, Azure, custom gateways). Responses API supported for Codex models.

## How It Works

```
                    +-----------+
                    |  Arcana   |
                    +-----+-----+
                          |
            +-------------+-------------+
            |             |             |
       +----v----+  +-----v-----+  +----v----+
       | Library |  |  Research  |  |Synthesis|
       |         |  |   Agent   |  |         |
       +---------+  +-----+-----+  +---------+
                          |
          +---------------+---------------+
          |               |               |
    +-----v------+  +-----v------+  +-----v------+
    | Sub-agents |  | Phase Gates|  | Remote GPUs|
    | scouts     |  | literature |  | SSH+rsync  |
    | architect  |  | hypothesis |  | auto-fix   |
    | reviewer   |  | experiment |  | pyright    |
    | visualizer |  | analysis   |  | workspace  |
    +------------+  | reflection |  | lifecycle  |
                    +------------+  +------------+
```

The research agent follows a **strict scientific method**: search literature, formulate hypotheses, run experiments, analyze results, reflect and iterate. Each phase transition is enforced by gates — the agent proves it has enough evidence before moving forward.

The agent runs as a **background process** decoupled from the browser. Navigate away, close the tab — it keeps going. A persistent research log lets you steer direction at any time.

## Quick Start

**Requirements:** Node >= 18

```bash
git clone https://github.com/dimalik/arcana.git
cd arcana
npm install
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The onboarding wizard guides you through LLM setup, profile creation, and library seeding.

See the [Getting Started guide](docs/getting-started.md) for detailed setup including remote GPU hosts and proxy configuration.

## Learn More

**Why phase gates?** Research agents without structure loop endlessly or skip to conclusions. Arcana's gates ensure the agent has read enough papers before hypothesizing, has hypotheses before experimenting, and has analyzed results before reflecting. It's the difference between a junior researcher running random experiments and a senior one following a methodology.

**Why remote execution?** ML experiments need GPUs. Rather than requiring cloud orchestrators or managed platforms, Arcana works with whatever machines you have — lab servers, Lambda instances, university clusters. SSH in, rsync files, run the script, sync results back.

**Why sub-agents?** A single agent context gets polluted after 50+ tool calls. Specialized sub-agents (literature scouts, adversarial reviewer, architect) each get fresh context tuned for their role. The lead agent coordinates; sub-agents execute.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[AGPL-3.0](LICENSE)
