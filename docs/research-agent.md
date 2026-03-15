# Research Agent

The research agent is an autonomous LLM loop that follows the scientific method: search the literature, formulate hypotheses, write and run experiments, critique results, and iterate. It runs as a `streamText()` session with ~30 tools and auto-continues across sessions.

## How it works

The agent is started via `startResearchAgent()` in `src/lib/research/agent.ts`. It:

1. Loads the project context (brief, papers, remote hosts, GPU info, capabilities, process memories)
2. Builds a detailed system prompt with research methodology instructions
3. Runs a `streamText()` loop with tools, streaming events to the client via SSE
4. Auto-continues when the step budget (~80 steps) is reached — sessions chain automatically

The agent never stops on its own. The user decides when to pause or end a project.

## Research cycle

The agent follows a repeating loop:

### Phase 1: Literature & Hypotheses
- Search academic databases (`search_papers`)
- Read papers in the library (`read_paper`, `search_library`)
- Check Mind Palace insights (`query_insights`)
- Formulate testable hypotheses (`log_finding` with type "hypothesis")

### Phase 2: Experiment
- Search the web for existing tools and libraries (`web_search`, `fetch_webpage`)
- Write experiment code (`write_file`) with `requirements.txt`
- Run on remote GPUs (`execute_remote`) or locally (`execute_command`)
- Read results (`read_file`, `list_files`)

### Phase 3: Critique
- Pass results to the adversarial reviewer (`adversarial_review`)
- Compare to baselines from the literature
- Check statistical rigor
- Update hypotheses (`update_hypothesis`)

### Phase 4: Back to literature
- When results are unexpected, search for techniques that address the specific problem
- Check existing papers and insights for solutions
- Adapt approaches from the literature into new experiments

### Phase 5: Follow-up
- Ablation studies, parameter sensitivity, generalization tests
- Address weaknesses identified in critique
- Loop back to Phase 3

### Phase 6: Iteration advancement
- Call `complete_iteration` with reflection and next goal
- Each iteration is a focused research cycle (30-80 steps)
- New iteration starts immediately with a fresh question

## Tools

### Literature
| Tool | Description |
|------|-------------|
| `search_papers` | Search Semantic Scholar, arXiv, OpenAlex |
| `read_paper` | Read a paper's full text, summary, and insights |
| `search_library` | Search existing papers in the user's library |
| `query_insights` | Search Mind Palace for relevant techniques |
| `discover_papers` | Run citation graph exploration from seed papers |

### Web & Reading
| Tool | Description |
|------|-------------|
| `web_search` | Search the web (for libraries, docs, tutorials) |
| `fetch_webpage` | Fetch and extract content from a URL |

### Code & Files
| Tool | Description |
|------|-------------|
| `write_file` | Write a file to the experiment directory |
| `read_file` | Read a file from the experiment directory |
| `list_files` | List files in a directory |
| `write_shared_utility` | Write a reusable utility to the shared directory |

### Execution
| Tool | Description |
|------|-------------|
| `execute_command` | Run a command locally |
| `execute_remote` | Submit experiment to a remote GPU server (non-blocking) |
| `check_job` | Check status of a background remote job |
| `wait_for_jobs` | Block until specific jobs complete |
| `check_remote` | Run a quick SSH command on a remote host |
| `run_experiment_sweep` | Submit multiple experiment variants across hosts |

### Research Management
| Tool | Description |
|------|-------------|
| `log_finding` | Record a finding (hypothesis, observation, breakthrough, etc.) |
| `update_hypothesis` | Update hypothesis status with evidence |
| `complete_iteration` | End current iteration, set next goal |
| `save_lesson` | Save a practical lesson to process memory |

### Multi-Agent
| Tool | Description |
|------|-------------|
| `dispatch_scouts` | Launch parallel literature scout sub-agents |
| `collect_results` | Gather results from sub-agent tasks |
| `adversarial_review` | Get independent critique from a hostile reviewer persona |

## Multi-agent coordination

The agent coordinates three levels of parallelism:

### Background jobs (RemoteJob)
`execute_remote` submits a job and returns immediately. The job runs on the remote host while the agent continues working. The agent uses `check_job` to poll status and `wait_for_jobs` when it needs results before proceeding.

### Sub-agents (AgentTask)
`dispatch_scouts` launches 2-4 lightweight literature scout agents that search different angles of a research question simultaneously. Each scout runs its own `generateText()` loop with a limited tool set (search, read, library search) and a 15-step budget. Results are collected with `collect_results`.

Sub-agents are implemented in `src/lib/research/sub-agent.ts`. They write structured findings to the `AgentTask.output` field in the database.

### Adversarial review
`adversarial_review` calls `generateText()` with a separate hostile-reviewer system prompt. The reviewer gets no tools — it's pure analysis. This provides an independent perspective on hypotheses, methodology, and results.

## Experiment sweeps

`run_experiment_sweep` takes a base script and a list of variants (different args, env vars, or configs). It submits each variant to a different remote host in round-robin fashion, all non-blocking. The agent can then compare results across variants.

## Process memory

The agent learns from trial and error. When it discovers a practical lesson (package version issue, code pattern, environment quirk), it saves it with `save_lesson`. These lessons are loaded into the system prompt of future sessions via `AgentMemory` records, organized by category:

- `package` — library compatibility, version pinning
- `environment` — venv, CUDA, system setup
- `code_pattern` — what works better than the obvious approach
- `debugging` — error diagnosis shortcuts
- `dataset` — preprocessing requirements
- `performance` — optimization tricks

## Research log

The agent maintains a `RESEARCH_LOG.md` in the experiment directory. This is a shared document — the user can read and edit it to steer the agent's direction. Log entries are also stored as `ResearchLogEntry` records in the database with types: decision, observation, question, dead_end, breakthrough, agent_suggestion, user_note.

## Steering the agent

Users can influence the agent through:

1. **Research log** — edit `RESEARCH_LOG.md` to add notes, suggest papers, or redirect focus
2. **Hypothesis management** — manually update hypothesis status in the UI
3. **Step control** — skip, execute, or restore individual steps
4. **User messages** — send a message to the agent during its session
5. **Agent capabilities** — configure custom tools and resources in settings
