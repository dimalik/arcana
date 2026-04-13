# Skillized Insights + Creativity Portfolio + Rigor Contracts

## Objective

Implement three additive capabilities without breaking existing agent behavior:

1. Convert distilled paper insights into reusable Skill Cards.
2. Add a structured creativity operator that proposes novel but testable idea portfolios.
3. Enforce explicit experiment rigor via evaluation protocols.

## Implemented components

### 1) Skillized insight retrieval

- Added `src/lib/research/insight-skills.ts`.
- New `query_skills` tool in main agent:
  - Modes: `exploit`, `balanced`, `explore`
  - Returns trigger/mechanism/implementation/risk/confidence/novelty
  - Adds diversity selection across rooms to reduce local-minima search behavior
- Added anti-pattern retrieval from `ResearchLogEntry` dead ends.
- Added `query_skills` to sub-agent shared library tools.

### 2) Creativity portfolio operator

- Added `design_creative_portfolio` tool in main agent.
- Generates 2-8 ideas with:
  - cross-domain analogy
  - falsifiable one-day test
  - success metric + kill criterion
  - explicit anti-pattern avoidance

### 3) Evaluation protocol contract

- Added `src/lib/research/evaluation-protocol.ts`.
- New tools:
  - `define_evaluation_protocol`
  - `show_evaluation_protocol`
- Protocol fields include:
  - primary/secondary metrics
  - datasets
  - seed set
  - minimum runs
  - statistical test
  - acceptance criteria
  - required baselines
- Enforcement:
  - hypothesis→experiment gate requires protocol for first-run projects
  - `run_experiment`, `execute_remote`, and `run_experiment_sweep` validate seeds
  - `record_result` requires the protocol primary metric
- Protocol is persisted as a decision log contract (`ResearchLogEntry`) with typed metadata.

## Compatibility

- Changes are additive; existing tools remain available.
- Existing projects with prior runs are not hard-blocked on gate migration.
- Strict seed validation applies only when a protocol exists.

## Evidence hooks

- Type-check pass (`npx tsc --noEmit`).
- Lifecycle integrity pass (`npm run check:experiment-integrity`).

## Automated acceptance harness

Added non-UI acceptance path:

1. API route: `POST /api/research/:id/acceptance/superpowers`
2. CLI runner: `npm run acceptance:superpowers -- --project <project-id>`

The harness checks:

- protocol save/load
- seed contract gating (missing, wrong, correct seed)
- primary metric requirement for result recording
- skill-card retrieval
- anti-pattern retrieval
