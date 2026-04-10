# Arcana

<p align="center">
  <strong>Your AI research lab in a browser.</strong>
</p>

<p align="center">
  Import papers. Formulate hypotheses. Run experiments on GPUs. Iterate autonomously.<br>
  <em>The research assistant you wish your PhD advisor had been.</em>
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

Arcana closes the loop that every researcher leaves open — the gap between "I read an interesting paper" and "I have novel results." An autonomous agent searches literature, spots gaps, writes experiment code, ships it to your GPUs, analyzes results, and comes back with better hypotheses. You set the direction; it handles the 3am experiment reruns.

<p align="center">
  <img src="docs/screenshots/research-dashboard.png" alt="Research Dashboard" width="800">
</p>

## Key Features

- **[Phase-gated research agent](docs/research-agent.md)** — literature, hypothesis, experiment, analysis, reflection. Code-enforced gates keep the agent honest — no skipping to experiments without reading papers first.
- **[Remote GPU execution](docs/remote-execution.md)** — SSH + rsync to your machines. Works with whatever you have — lab servers, Lambda, university clusters. Auto environment setup, OOM detection, and workspace cleanup so experiments don't pile up.
- **[Multi-agent parallelism](docs/research-agent.md#sub-agents)** — literature scouts, synthesizer, architect, adversarial reviewer, provocateur, and visualizer all working concurrently. The lead agent coordinates; sub-agents bring fresh perspective.
- **[Auto-fix layer](docs/research-agent.md#auto-fix)** — experiment failed because of a typo? Wrong API call? The auto-fix layer patches code bugs and resubmits before you even notice. Real research failures are recorded as-is.
- **[Static analysis](docs/remote-execution.md#pyright)** — pyright runs on the remote host before submission, catching wrong imports, API mismatches, and type errors before burning GPU time.
- **[Structured experiment tracking](docs/research-agent.md#experiment-tracking)** — approach trees, canonical metrics, baselines, verdicts, and auto-generated paper-style research summaries.
- **[Multi-source paper import](docs/getting-started.md#importing-papers)** — arXiv, DOI, OpenReview, ACL Anthology, URL, or just drop a PDF. Metadata auto-fetched from OpenAlex, Semantic Scholar, CrossRef.
- **[Paper conversations](docs/getting-started.md#paper-chat)** — ask questions grounded in the actual paper content. Compare methods across papers. Extract code from methods sections.
- **[Research chat with vision](docs/research-agent.md#chat)** — "What does this attention heatmap show?" Ask about your figures and the model actually looks at them.
- **[Research dashboard](docs/research-agent.md#dashboard)** — narrative timeline, metric charts, approach trees, file browser, figures gallery, and integrated chat. Everything in one view.
- **[Mind Palace](docs/getting-started.md#mind-palace)** — distill papers into insights organized by topic with spaced repetition. Your accumulated knowledge feeds back into active research.
- **[Literature synthesis](docs/getting-started.md#synthesis)** — structured reviews with methodology comparison, gap analysis, and PDF/LaTeX export.
- **[Any LLM provider](docs/llm-configuration.md)** — OpenAI, Anthropic, or any compatible proxy (OpenRouter, LiteLLM, Azure, custom gateways). Bring your own models.

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

The research agent follows a **strict scientific method**: read the literature, form hypotheses, run experiments, analyze results, reflect and iterate. Each phase transition is enforced by gates — the agent has to earn its way forward with evidence, not just decide it's ready.

The agent runs as a **background process** decoupled from the browser. Close the tab, go to sleep, come back to new results in the morning. A persistent research log lets you steer direction at any time — "focus on the attention mechanism" or "try a different baseline."

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

**Why phase gates?** Without structure, research agents loop endlessly or jump to conclusions. Arcana's gates are the difference between a junior researcher running random experiments and a senior one who reads before they code. The agent earns each phase transition with evidence.

**Why remote execution?** ML experiments need GPUs. Arcana doesn't require Kubernetes or managed platforms — just SSH access to whatever machines you have. Your lab server, a Lambda instance, a university cluster. It handles the rest.

**Why sub-agents?** After 50+ tool calls, a single agent loses the plot. Specialized sub-agents — scouts for parallel literature search, an architect for novel approaches, an adversarial reviewer to poke holes — each get fresh context tuned for their role. Better results, less drift.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[AGPL-3.0](LICENSE)
