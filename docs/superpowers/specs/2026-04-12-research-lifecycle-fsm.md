# Research Lifecycle FSM

**Date:** 2026-04-12
**Status:** Draft
**Replaces:** The current phase system (`currentPhase` field, `checkPhaseGate`, `PHASE_RESTRICTED_TOOLS`, `advance_phase` tool, all reactive gate logic)

## Problem

The current system uses a flat phase model (literature -> hypothesis -> experiment -> analysis -> reflection) with reactive gates. The agent tries an action, hits a gate error as a string, and must interpret the error and discover the right prerequisite tool among 58 options. In practice, the LLM fails to do this ~95% of the time, resulting in infinite loops where the agent files help requests about tools it already has.

Root causes:
1. **No separation of concerns.** Project progression, run lifecycle, and evidence governance are all mixed into one phase field and ad-hoc gate checks.
2. **Reactive, not proactive.** Prerequisites are discovered through trial-and-error, not enforced structurally.
3. **Error strings, not state transitions.** The agent gets prose like "Use define_evaluation_protocol before the first experiment run" and must interpret it as an action among 58 tools.

## Design

### Principle

Three orthogonal finite state machines, each owning its own domain. The system drives transitions. The agent acts within the current state; it does not navigate between states by guessing.

### Architecture: Three FSMs + Overlays

```
+---------------------------+
|  Project FSM              |  Research progression
|  DISCOVERY -> HYPOTHESIS  |
|  -> DESIGN -> EXECUTION   |
|  -> ANALYSIS -> DECISION  |
|  -> { DESIGN | HYPOTHESIS |
|       | COMPLETE }        |
+---------------------------+

+---------------------------+
|  Run FSM (per experiment) |  Execution lifecycle
|  DRAFT -> READY -> QUEUED |
|  -> RUNNING -> IMPORTING  |
|  -> DONE                  |
|  terminal: FAILED,        |
|    CANCELLED              |
+---------------------------+

+---------------------------+
|  Hypothesis FSM (per hyp) |  Evidence progression
|  PROPOSED -> ACTIVE       |
|  -> EVALUATING            |
|  -> { SUPPORTED |         |
|       CONTESTED |         |
|       REVISED | RETIRED } |
+---------------------------+

Overlays (per domain):
  ACTIVE | PAUSED | BLOCKED | FAILED | ARCHIVED
```

These three machines never bleed into each other. "Project is in EXECUTION" and "Run #3 is FAILED" are independent facts. "Project is BLOCKED" is an operational overlay, not a lifecycle state.

---

## 1. Project FSM

### States

| State | Purpose | Substates / Tasks |
|-------|---------|-------------------|
| **DISCOVERY** | Literature search, paper processing, cross-paper synthesis | search, import, process, synthesize |
| **HYPOTHESIS** | Formulate testable hypotheses from synthesis findings | formulate, register approaches |
| **DESIGN** | Define what and how to measure before running anything | define metrics, define evaluation protocol, plan PoC |
| **EXECUTION** | Run experiments. All prerequisites are already satisfied. | submit, monitor, collect |
| **ANALYSIS** | Interpret results, update hypotheses with evidence, record claims | analyze, compare, claim |
| **DECISION** | Gated adjudication: iterate, pivot, or conclude | auto-resolve or explicit decision |
| **COMPLETE** | Research concluded, final summary produced | archive |

### Transition Guards

Each transition has **entry conditions** that must be true before the system allows it. These are not error strings the agent must interpret; they are boolean checks the system evaluates and enforces.

```
DISCOVERY -> HYPOTHESIS
  guard:
    - paper_count >= 3 OR scout_dispatched
    - all imported papers processed (no PENDING/EXTRACTING)
    - at least 1 completed synthesis task

HYPOTHESIS -> DESIGN
  guard:
    - hypothesis_count >= 1
    - at least 1 approach registered

DESIGN -> EXECUTION
  guard:
    - metric_schema defined (non-empty)
    - evaluation_protocol exists
    - at least 1 hypothesis in ACTIVE state

EXECUTION -> ANALYSIS
  guard:
    - at least 1 run in DONE state

ANALYSIS -> DECISION
  guard:
    - at least 1 hypothesis updated with evidence (status != PROPOSED, != ACTIVE)
    - at least 1 claim recorded OR at least 1 hypothesis in terminal state

DECISION -> COMPLETE
  guard:
    - all active hypotheses adjudicated (no ACTIVE or EVALUATING)
    - no open required runs (coordinator queue empty or all COMPLETED/SKIPPED)
    - at least 1 hypothesis in SUPPORTED or RETIRED state (research produced a conclusion)

DECISION -> DESIGN
  guard:
    - at least 1 hypothesis still viable (REVISED or ACTIVE)
    - coordinator has emitted required experiments OR agent explicitly requests more testing

DECISION -> HYPOTHESIS
  guard:
    - analysis invalidated current hypothesis set OR
    - agent/user explicitly requests new hypothesis family
```

### Auto-Transitions

The system evaluates guards continuously (on relevant DB writes). When a guard becomes satisfiable, the transition fires automatically. The agent does not call "advance_phase."

| Transition | Auto-resolve? | Condition |
|------------|---------------|-----------|
| DISCOVERY -> HYPOTHESIS | Yes | All entry conditions met |
| HYPOTHESIS -> DESIGN | Yes | All entry conditions met |
| DESIGN -> EXECUTION | Yes | All entry conditions met (metrics + protocol + active hypothesis) |
| EXECUTION -> ANALYSIS | Yes | At least 1 DONE run |
| ANALYSIS -> DECISION | No | Agent must explicitly record analysis (claims, hypothesis updates) |
| DECISION -> COMPLETE | Yes, when unambiguous | All hypotheses adjudicated, no open obligations |
| DECISION -> DESIGN | Yes, when unambiguous | Viable hypothesis + coordinator-required experiments |
| DECISION -> HYPOTHESIS | No | Requires explicit decision artifact |

### DESIGN Substates

DESIGN is a macro-state containing ordered substeps. The system drives through them:

1. **METRICS** — Define canonical metrics for the project. Agent provides metric names and directions (higher/lower is better). System persists.
2. **PROTOCOL** — Define evaluation protocol. If metrics are already defined, the system auto-derives a default protocol (primary = first metric, seeds = [42, 123, 456], minRuns = 1, bootstrap 95% CI) and the agent can refine it. If the agent doesn't refine within one session, the default stands and DESIGN auto-completes.
3. **POC_PLAN** — (Optional) If the project has no completed runs, suggest a PoC before full experiments. This is advisory, not blocking.

The key behavior: when the agent defines metrics, the system immediately auto-creates a default protocol. DESIGN can auto-complete to EXECUTION without the agent calling a separate "define protocol" tool, because the system proactively satisfies the prerequisite.

### Decision Artifacts

Every transition (auto or explicit) produces a `TransitionRecord`:

```typescript
interface TransitionRecord {
  id: string;
  projectId: string;
  from: ProjectState;
  to: ProjectState;
  trigger: "auto" | "agent" | "user";
  basis: string;         // why this transition was chosen
  guardsEvaluated: Record<string, boolean>;
  createdAt: Date;
}
```

For DECISION state specifically, a `DecisionRecord` extends this:

```typescript
interface DecisionRecord extends TransitionRecord {
  decisionType: "iterate" | "pivot" | "conclude";
  hypothesesConsidered: string[];   // IDs
  evidenceSummary: string;
  alternativesConsidered?: string;
}
```

---

## 2. Run FSM

Per-experiment execution lifecycle. Each `ExperimentRun` (or `RemoteJob`) has its own independent state machine.

### States

```
DRAFT -> READY -> QUEUED -> RUNNING -> IMPORTING -> DONE
                                          |
                                     FAILED, CANCELLED
```

Any non-terminal state can transition to FAILED or CANCELLED.

| State | Meaning |
|-------|---------|
| **DRAFT** | Script exists but prerequisites not yet checked |
| **READY** | Preflight passed, host resolved, workspace prepared |
| **QUEUED** | Submitted to remote host, waiting for slot |
| **RUNNING** | Actively executing on remote host |
| **IMPORTING** | Execution complete, importing results/artifacts |
| **DONE** | Results imported, metrics recorded |
| **FAILED** | Terminal failure (see `failureClass`) |
| **CANCELLED** | Explicitly cancelled by agent or user |

### Failure Classification

Failure is a terminal state. The cause is data, not a separate state:

```typescript
type FailureClass =
  | "INFRA"        // SSH, host down, OOM, timeout
  | "CODE"         // Script error, syntax, runtime exception
  | "POLICY"       // Blocked by convergence barrier, duplicate hash, etc.
  | "VALIDATION"   // Preflight failed, pyright errors, dataset trimming
  | "IMPORT"       // Results arrived but import/parse failed
```

This replaces the current pattern of encoding cause taxonomy into state names (`FAILED_INFRA`, `FAILED_CODE`). A single `FAILED` state with a `failureClass` field is simpler and extensible.

### Run FSM Transition Guards

```
DRAFT -> READY
  guard: preflight passed, script exists, syntax valid

READY -> QUEUED
  guard: host resolved, workspace lease acquired, no active job on same workspace

QUEUED -> RUNNING
  guard: remote helper reports execution started

RUNNING -> IMPORTING
  guard: remote helper reports execution completed (exit code 0)

IMPORTING -> DONE
  guard: metrics parsed, result record created, artifacts synced

* -> FAILED
  guard: any error matching failureClass taxonomy

* -> CANCELLED
  guard: explicit stop signal from agent or user
```

### Relationship to Project FSM

The project FSM does not track individual runs. It only cares about aggregate facts:
- "At least 1 run in DONE" triggers EXECUTION -> ANALYSIS
- "No runs in QUEUED or RUNNING" is relevant for DECISION auto-resolution

The run FSM reports events upward; the project FSM reacts to aggregate state.

---

## 3. Hypothesis FSM

Per-hypothesis evidence progression.

### States

```
PROPOSED -> ACTIVE -> EVALUATING -> { SUPPORTED | CONTESTED | REVISED | RETIRED }
```

| State | Meaning |
|-------|---------|
| **PROPOSED** | Hypothesis formulated, not yet being tested |
| **ACTIVE** | Experiment(s) designed or running against this hypothesis |
| **EVALUATING** | Results exist, adjudication in progress |
| **SUPPORTED** | Evidence supports the hypothesis |
| **CONTESTED** | Evidence is mixed or contradictory |
| **REVISED** | Hypothesis modified based on evidence, new version created |
| **RETIRED** | Hypothesis abandoned (refuted, superseded, or out of scope) |

### Auto-Transitions

| Transition | Auto? | Trigger |
|------------|-------|---------|
| PROPOSED -> ACTIVE | Yes | When linked to a run that enters QUEUED or later |
| ACTIVE -> EVALUATING | Yes | When all linked runs are in terminal state (DONE or FAILED) |
| EVALUATING -> terminal | No | Agent must record verdict via `update_hypothesis` or claim system |

### Relationship to Project FSM

- DESIGN -> EXECUTION requires at least 1 hypothesis in ACTIVE state
- ANALYSIS -> DECISION requires at least 1 hypothesis updated (not PROPOSED, not ACTIVE)
- Hypothesis terminal states feed into DECISION auto-resolution logic

---

## 4. Operational Overlays

Orthogonal to lifecycle. Each domain (project, run, task) can independently have an overlay.

| Overlay | Meaning | Applies to |
|---------|---------|------------|
| **ACTIVE** | Normal operation | Project, Run |
| **PAUSED** | Temporarily suspended (user action or stagnation detection) | Project |
| **BLOCKED** | Cannot proceed; waiting on external resolution | Project, Run |
| **FAILED** | Unrecoverable error in the domain itself (not a run failure) | Project |
| **ARCHIVED** | Completed and archived for reference | Project |

Key distinction: a project in EXECUTION with overlay BLOCKED means "we're in the experiment phase but something external is preventing progress" (e.g., all hosts offline). The lifecycle state is still EXECUTION; the operational state is BLOCKED.

The current `status` field on `ResearchProject` maps to the overlay. The current `currentPhase` field maps to the project FSM state.

---

## 5. System Prompt Implications

The current system prompt explains phases, gates, and tool restrictions in ~500 words of prose. The FSM replaces this with:

1. **State announcement**: At the start of each session, the system tells the agent: "Project is in STATE. Your job is: [state-specific instructions]."
2. **Available actions**: Only tools relevant to the current state are presented. Not 58 tools with phase restrictions; the actual subset for the current state.
3. **No gate discovery**: The agent never hits a gate error. If it's in EXECUTION, all prerequisites are already satisfied. If it's in DESIGN, the tools are about metrics and protocol, not about running experiments.

### Tool Sets Per State

| State | Available tools |
|-------|----------------|
| DISCOVERY | search_papers, dispatch_scouts, search_library, dispatch_synthesizer, collect_results, read/write files |
| HYPOTHESIS | log_finding, register_approach, view_approach_tree, query_insights, read/write files |
| DESIGN | define_metrics, define_evaluation_protocol, show_evaluation_protocol, write_file (PoC scripts) |
| EXECUTION | run_experiment, execute_remote, run_experiment_sweep, check_job, monitor_experiment, validate_environment, diagnose_remote_host |
| ANALYSIS | record_result, query_results, record_claim, update_hypothesis, reflect_on_failure, log_finding |
| DECISION | (read-only tools + explicit decision tool) |
| COMPLETE | (archive/export tools only) |

Cross-cutting tools available in all states: read_file, list_files, get_workspace, request_help, save_lesson, query_insights, query_skills.

---

## 6. Migration Path

### What Gets Removed

- `currentPhase` field semantics (repurposed to store FSM state name)
- `checkPhaseGate` function
- `PHASE_RESTRICTED_TOOLS` map
- `advance_phase` tool (system drives transitions)
- `assessExperimentSubmission` readiness cascade (replaced by FSM entry guards)
- `computeExperimentSubmissionReadiness` (replaced by Run FSM DRAFT -> READY guard)
- `formatExperimentSubmissionReadiness` (no more error formatting; if you're in EXECUTION, you're ready)
- `autoAdvanceExperimentPhaseIfNeeded` (subsumed by auto-transitions)
- All `.catch(() => {})` gate workarounds in agent.ts
- The 500-word phase explanation in the system prompt

### What Gets Added

- `src/lib/research/fsm/project-fsm.ts` — Project state machine definition, guards, transitions
- `src/lib/research/fsm/run-fsm.ts` — Run state machine definition
- `src/lib/research/fsm/hypothesis-fsm.ts` — Hypothesis state machine definition
- `src/lib/research/fsm/transition-engine.ts` — Evaluates guards, fires auto-transitions, emits TransitionRecords
- `src/lib/research/fsm/tool-sets.ts` — Maps FSM states to available tool subsets
- Schema: `TransitionRecord` model, `DecisionRecord` model
- Schema: `failureClass` field on `RemoteJob` / `ExperimentRun`

### What Gets Modified

- `agent.ts:createTools` — filter tools based on FSM state instead of phase-restricted map
- `agent.ts` system prompt — replace phase prose with state-specific instructions
- `research-state.ts` — generate RESEARCH_STATE.md from FSM state, not phase
- `remote-executor.ts` — emit Run FSM transitions instead of ad-hoc status updates
- `ResearchProject` schema — `currentPhase` stores FSM state; add `operationalStatus` for overlay

---

## 7. Implementation Boundaries

This spec covers the **state machine definitions, transition logic, and integration points**. It does NOT cover:

- Claim credibility FSM (already exists and works separately)
- Coordinator/queue system changes (works on top of FSM outputs)
- UI changes (the phase dots in the header adapt to new state names; the tabs already moved to the left panel)
- Sub-agent dispatch changes (sub-agents are tasks within a state, not states themselves)

These are downstream consumers of the FSM. They adapt to it but are not redesigned by this spec.
