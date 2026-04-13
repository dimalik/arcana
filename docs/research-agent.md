# Research Agent

The research agent is an autonomous LLM loop that follows a phase-gated scientific method: search the literature, formulate hypotheses, write and run experiments, analyze results, and iterate. It runs as a `streamText()` session with ~40 tools, enforced phase gates, and auto-continues across sessions.

## How it works

The agent is started via `startResearchAgent()` in `src/lib/research/agent.ts`. It:

1. Loads the project context (brief, papers, remote hosts, GPU info, capabilities, process memories)
2. Builds a detailed system prompt (or a condensed version for non-Claude models)
3. Injects the structured research state from `RESEARCH_STATE.md`
4. Runs a `streamText()` loop with phase-gated tools, streaming events to the client via SSE
5. Auto-continues when the step budget (~80 steps) is reached — sessions chain automatically (up to 20)

The agent never stops on its own. The user decides when to pause or end a project.

## Phase-gated research cycle

The agent operates in a strict state machine with five phases. Each transition is enforced by gates that check database state — the agent cannot skip steps.

```
literature → hypothesis → experiment → analysis → reflection
     ↑                                                  │
     └──────────────────────────────────────────────────┘
```

### Phase 1: Literature

Search databases, read papers, extract methods and baselines. Required tools: `search_papers`, `dispatch_scouts`, `read_paper`, `dispatch_synthesizer`.

**Gate to hypothesis**: 3+ papers (or 1+ scout dispatched), all papers processed, and 1+ completed synthesis.

### Phase 2: Hypothesis

Formulate testable claims, define canonical metrics, get architecture proposals, write mechanism design documents.

**Gate to experiment**: 1+ hypothesis, 1+ completed architect proposal, 1+ mechanism design document (logged as decision), and metric schema defined.

### Phase 3: Experiment

Write Python code following the naming taxonomy, validate environments, submit to remote GPUs. Scripts must follow the taxonomy: `poc_NNN_name.py` (proof of concept), `exp_NNN_name.py` (full experiment), `analysis_NNN_name.py` (post-experiment analysis), `sweep_NNN_name.py` (parameter sweep). Non-conforming names are blocked.

**Gate to analysis**: 1+ completed experiment and 1+ adversarial review.

### Phase 4: Analysis

Record structured results with canonical metrics, reflect on failures, run adversarial reviews, update hypotheses with evidence.

**Gate to reflection**: 1+ hypothesis updated with evidence, 1+ `SUPPORTED` or `REPRODUCED` claim, at least one supporting evidence row attached to that claim, and at least one reviewer or reproducer check recorded against the claim ledger.

### Phase 5: Reflection

Complete the iteration with a reflection on what was learned and set the next goal. The cycle then repeats with a new iteration.

### Advancing phases

The agent calls `advance_phase` to move between phases. Each call checks the relevant gate conditions. The agent can always go backwards (e.g., from experiment back to literature to search for more techniques).

## Tools

### Phase Management
| Tool | Description |
|------|-------------|
| `advance_phase` | Move to the next research phase (checks gate conditions) |
| `register_approach` | Create or update a branch in the approach tree |
| `define_metrics` | Set canonical metrics for the project (name, direction, description) |
| `define_evaluation_protocol` | Define datasets, seed set, min runs, and acceptance criteria |
| `show_evaluation_protocol` | Show active evaluation protocol contract |
| `record_result` | Record an experiment result with canonical metrics, raw metrics, and verdict |
| `reflect_on_failure` | Record a structured failure reflection before retrying |
| `query_results` | Query experiment results with filters |
| `view_approach_tree` | Display the full approach tree with metrics |

### Literature
| Tool | Description |
|------|-------------|
| `search_papers` | Search Semantic Scholar, arXiv, OpenAlex |
| `read_paper` | Read a paper's full text, summary, and insights |
| `search_library` | Search existing papers in the user's library |
| `query_insights` | Search Mind Palace for relevant techniques |
| `query_skills` | Retrieve reusable skill cards (trigger, mechanism, risk) from distilled insights |
| `design_creative_portfolio` | Generate a novel-but-testable idea portfolio using skills + anti-patterns |
| `discover_papers` | Run citation graph exploration from seed papers |

### Web & Reading
| Tool | Description |
|------|-------------|
| `web_search` | Search the web (for libraries, docs, tutorials) |
| `fetch_webpage` | Fetch and extract content from a URL |

### Code & Files
| Tool | Description |
|------|-------------|
| `write_file` | Write a file to the experiment directory (enforces naming taxonomy) |
| `read_file` | Read a file from the experiment directory |
| `list_files` | List files in a directory |
| `get_workspace` | Structured view of all files, results, packages, job status (cached) |
| `read_remote_file` | Read a specific file from the remote experiment directory |
| `write_shared_utility` | Write a reusable utility to the shared directory |

### Execution
| Tool | Description |
|------|-------------|
| `execute_command` | Run a command locally |
| `execute_remote` | Submit experiment to a remote GPU server (non-blocking) |
| `validate_environment` | Test package availability on remote before submitting |
| `check_job` | Check status of a background remote job |
| `wait_for_jobs` | Block until specific jobs complete |
| `monitor_experiment` | Live training metrics check (NaN, divergence, plateau detection) |
| `check_remote` | Run a quick SSH command on a remote host |
| `run_experiment_sweep` | Submit multiple experiment variants across hosts |

### Research Management
| Tool | Description |
|------|-------------|
| `log_finding` | Record a finding (hypothesis, observation, breakthrough, etc.) |
| `record_claim` | Add a claim to the project claim ledger |
| `attach_claim_evidence` | Link papers, results, logs, tasks, or remote jobs to a claim |
| `review_claim` | Mark a claim as supported, contested, reproduced, or retracted |
| `promote_claim_to_memory` | Promote a verified claim into durable agent memory |
| `show_claim_ledger` | Show the current ledger with evidence and status |
| `update_hypothesis` | Update hypothesis status with evidence |
| `complete_iteration` | End current iteration, set next goal |
| `save_lesson` | Save a practical lesson to process memory |

### Multi-Agent
| Tool | Description |
|------|-------------|
| `dispatch_scouts` | Launch parallel literature scout sub-agents |
| `dispatch_synthesizer` | Launch synthesizer to find cross-paper patterns |
| `dispatch_architect` | Launch architect to propose novel approaches |
| `dispatch_reviewer` | Launch deep background adversarial review |
| `dispatch_provocateur` | Launch creative lateral thinker for unconventional ideas |
| `dispatch_visualizer` | Launch visualization script generator from experiment results |
| `collect_results` | Gather results from sub-agent tasks |
| `adversarial_review` | Get quick inline critique from a hostile reviewer persona |

## Multi-agent coordination

The agent coordinates three levels of parallelism:

### Background jobs (RemoteJob)
`execute_remote` submits a job and returns immediately. The job runs on the remote host while the agent continues working. The agent uses `check_job` to poll status and `wait_for_jobs` when it needs results before proceeding.

### Sub-agents (AgentTask)

Seven specialized sub-agent roles:

- **Scouts** — search 2-4 different angles of a research question simultaneously. Limited tool set (search, read, library search) with a 15-step budget.
- **Synthesizer** (Opus) — reads all papers together, finds contradictions, complementary techniques, and unexplored combinations. Required before forming hypotheses.
- **Architect** (Opus) — proposes 2-3 novel approaches with risk ratings and validation experiments. Required before experimenting. Always recommends the cheapest validation first.
- **Reviewer** — deep background adversarial review of methodology and results. Required before advancing to analysis.
- **Reproducer** — verifies the strongest claim against the recorded run, artifacts, and protocol before it is treated as durable knowledge.
- **Provocateur** — creative lateral thinker that deliberately breaks from the current trajectory. Suggests approaches the team would never consider on their own.
- **Visualizer** — generates analysis and visualization scripts from experiment results. Runs after experiments produce data.

Sub-agents are implemented in `src/lib/research/sub-agent.ts`. They write structured findings to the `AgentTask.output` field in the database.

### Adversarial review
`adversarial_review` calls `generateText()` with a separate hostile-reviewer system prompt. The reviewer gets no tools — it's pure analysis. This provides an independent perspective on hypotheses, methodology, and results.

## Experiment taxonomy

Python scripts must follow a strict naming convention:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `poc_` | Proof of concept — quick validation, <5 min | `poc_001_baseline.py` |
| `exp_` | Full experiment — tests a hypothesis | `exp_002_attention_mechanism.py` |
| `analysis_` | Post-experiment analysis/visualization | `analysis_003_error_breakdown.py` |
| `sweep_` | Parameter sweep | `sweep_004_lr_search.py` |

Utility modules (`utils.py`, `config.py`, etc.) and non-Python files use any name. Non-conforming Python script names are blocked by the `write_file` tool.

## Metric schema

Each project defines canonical metrics via `define_metrics`:

```json
[
  { "name": "f1", "direction": "higher", "description": "F1 score on test set" },
  { "name": "latency_ms", "direction": "lower", "description": "Inference latency in milliseconds" }
]
```

When the agent calls `record_result`, it provides both canonical metrics (mapped to the schema) and raw metrics (experiment-specific detail). The metric chart in the dashboard plots canonical metrics across experiments. When the schema changes, `metric-recompute.ts` uses an LLM to re-map all existing results to the new canonical names.

## Evaluation protocol

Use `define_evaluation_protocol` to lock experiment rigor before full execution:

- primary metric for decision making
- evaluation datasets/splits
- allowed seed set
- minimum run count
- statistical test/confidence method
- acceptance criteria and required baselines

`run_experiment`, `execute_remote`, and `run_experiment_sweep` validate seed usage against the active protocol.  
`record_result` validates that the protocol primary metric is present.

## Auto-fix layer

When an experiment fails (`src/lib/research/auto-fix.ts`), the error is classified before the agent sees it:

- **CODE_ERROR** — fixable bugs (typos, wrong API, OOM from batch size, missing imports, shape mismatches). Auto-patched and resubmitted (up to 2 attempts).
- **RESEARCH_FAILURE** — the experiment ran but the hypothesis was disproven, training diverged, or results were degenerate. Recorded as a real result.
- **RESOURCE_ERROR** — missing packages, GPU unavailable, permission denied. Queued for user attention via the notification system.

The fix generation enforces a sanity check: the patched script must be 0.5x-2.0x the original size to prevent rewrites. This layer is invisible to the research agent.

## Experiment sweeps

`run_experiment_sweep` takes a base script and a list of variants (different args, env vars, or configs). It submits each variant to a different remote host in round-robin fashion, all non-blocking. The agent can then compare results across variants.

Sweep safety contract:
- Arcana allows only one active run per `host + workspace` to avoid hidden process replacement.
- If a sweep schedules two variants onto the same host workspace concurrently, later submissions are blocked instead of silently interfering.
- To maximize sweep parallelism, provide multiple hosts or separate work directories.

## Process memory

The agent learns from trial and error. When it discovers a practical lesson (package version issue, code pattern, environment quirk), it saves it with `save_lesson`. These lessons are loaded into the system prompt of future sessions via `AgentMemory` records, organized by category:

- `package` — library compatibility, version pinning
- `environment` — venv, CUDA, system setup
- `code_pattern` — what works better than the obvious approach
- `debugging` — error diagnosis shortcuts
- `dataset` — preprocessing requirements
- `performance` — optimization tricks

Research knowledge is stricter than operational memory. Findings, breakthroughs, and hypothesis assessments now enter the claim ledger first; only verified claims should be promoted into approved memory.

## Claim ledger

Arcana tracks research conclusions as structured `ResearchClaim` records instead of letting them live only in free-form agent prose. Each claim carries:

- a status: `DRAFT`, `SUPPORTED`, `CONTESTED`, `REPRODUCED`, or `RETRACTED`
- a confidence level: `PRELIMINARY`, `MODERATE`, or `STRONG`
- linked evidence rows (`ClaimEvidence`) pointing to papers, experiment results, artifacts, log entries, agent tasks, or remote jobs

This ledger is what powers credibility-first summaries:

- only `SUPPORTED` and `REPRODUCED` claims become key findings
- `CONTESTED` claims are surfaced as limitations or open questions
- durable memories and distilled insights should reference a source claim rather than raw chat text

## Research state and summary

Two complementary documents are generated from database state:

- **RESEARCH_STATE.md** (`research-state.ts`) — structured data dump for the agent's context. Includes phase, hypotheses, approach tree, experiment results with metrics, pending jobs, and step count. Injected into the system prompt each session.
- **RESEARCH_SUMMARY.md** (`research-summary.ts`) — paper-style writeup for human consumption. Generated via `generateObject` with a structured schema: introduction, key findings (with confidence and evidence), methods, open questions, status, and TL;DR.

## Research log

The agent maintains a `RESEARCH_LOG.md` in the experiment directory. This is a shared document — the user can read and edit it to steer the agent's direction. Log entries are also stored as `ResearchLogEntry` records in the database with types: decision, observation, question, dead_end, breakthrough, agent_suggestion, user_note.

## Non-Claude model support

The agent adapts for GPT and other non-Claude models:

1. **Condensed system prompt** — the full ~18K token prompt is replaced with a phase-specific condensed version covering essential rules, current phase, and available tools.
2. **Reduced tool set** — only essential tools for the current phase are exposed (avoiding confusion from 40+ tools).
3. **Directive loop** — an outer loop sends phase-specific directives after each tool round (up to 15 rounds), compensating for GPT models stopping after each tool call rather than continuing autonomously.

## Deterministic test modes

The agent API supports deterministic acceptance testing without UI interaction.

Request body options on `POST /api/research/:id/agent`:

- `disable_auto_continue: true` — run a single session only (no chained 80-step auto-continue sessions)
- `mock_llm_fixture: "<fixture-id>"` — replay a fixed tool-call fixture instead of live LLM generation
- `mock_executor: { enabled: true, mode: "success" | "failure", write_result_file?: boolean }` — short-circuit remote submission into deterministic `RemoteJob` records

Current fixture IDs are defined in `src/lib/research/agent-test-fixtures.ts`.

Safety contract:
- Test runtime options are rejected in production (`NODE_ENV=production`).
- Tool phase gates and protocol checks still execute normally in fixture mode.
- Mock executor affects submission/remote execution only; planning, gating, and database contracts remain live.

CLI harnesses:
- `npm run acceptance:superpowers` — protocol/seed/metric/skills acceptance route
- `npm run acceptance:agent-mock` — end-to-end agent fixture run (SSE + DB assertions)

## Steering the agent

Users can influence the agent through:

1. **Research log** — edit `RESEARCH_LOG.md` to add notes, suggest papers, or redirect focus
2. **Research chat** — send messages that are forwarded to the agent via the research log
3. **Hypothesis management** — manually update hypothesis status in the UI
4. **Step control** — skip, execute, or restore individual steps
5. **User messages** — send a message to the agent during its session
6. **Agent capabilities** — configure custom tools and resources in settings
7. **Notification responses** — resolve attention items (missing packages, API keys) surfaced by the notification bell
