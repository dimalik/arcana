export interface AgentFixtureToolCall {
  tool: string;
  input: Record<string, unknown>;
  expectContains?: string[];
}

export interface AgentFixtureStep {
  note?: string;
  calls: AgentFixtureToolCall[];
}

export interface AgentTestFixture {
  id: string;
  description: string;
  steps: AgentFixtureStep[];
}

const FIXTURES: Record<string, AgentTestFixture> = {
  poc_smoke_success: {
    id: "poc_smoke_success",
    description: "Defines protocol + writes a PoC script + submits one experiment run.",
    steps: [
      {
        note: "Define canonical metrics for comparison.",
        calls: [
          {
            tool: "define_metrics",
            input: {
              metrics: [
                { name: "f1", direction: "higher", description: "Primary F1 score" },
                { name: "accuracy", direction: "higher", description: "Classification accuracy" },
              ],
            },
          },
        ],
      },
      {
        note: "Define a strict evaluation protocol with fixed seeds.",
        calls: [
          {
            tool: "define_evaluation_protocol",
            input: {
              primary_metric: "f1",
              secondary_metrics: ["accuracy"],
              datasets: ["mock_smoke_set"],
              seeds: [11, 23, 47],
              min_runs: 3,
              statistical_test: "bootstrap 95% CI",
              acceptance_criteria: "mean f1 must exceed baseline by >= 0.01",
              required_baselines: ["baseline_a"],
              notes: "Fixture protocol",
            },
          },
        ],
      },
      {
        note: "Write a minimal PoC script for deterministic mock execution.",
        calls: [
          {
            tool: "write_file",
            input: {
              filename: "poc_001_fixture_eval.py",
              content: [
                "import argparse",
                "import json",
                "",
                "p = argparse.ArgumentParser()",
                "p.add_argument('--seed', type=int, required=True)",
                "args = p.parse_args()",
                "",
                "f1 = 0.70 + (args.seed % 10) * 0.001",
                "acc = 0.80 + (args.seed % 10) * 0.001",
                "print(f'seed={args.seed} f1={f1:.4f} acc={acc:.4f}', flush=True)",
                "",
                "with open('results.json', 'w', encoding='utf-8') as f:",
                "    json.dump({'seed': args.seed, 'f1': f1, 'accuracy': acc}, f)",
              ].join("\n"),
            },
          },
        ],
      },
      {
        note: "Submit one run through run_experiment using an allowed seed.",
        calls: [
          {
            tool: "run_experiment",
            input: {
              script: "poc_001_fixture_eval.py",
              args: "--seed 11",
            },
            expectContains: ["Job submitted"],
          },
        ],
      },
    ],
  },
};

export function getAgentTestFixture(id: string): AgentTestFixture | null {
  return FIXTURES[id] || null;
}

export function listAgentTestFixtureIds(): string[] {
  return Object.keys(FIXTURES);
}
