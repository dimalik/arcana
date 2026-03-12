/**
 * Classify a step title into a task category for resource preference matching.
 */

const CATEGORY_KEYWORDS: [string, string[]][] = [
  ["data_generation", ["generat", "data", "preprocess", "download", "dataset", "scrape", "collect"]],
  ["training", ["train", "fine-tune", "finetune", "finetuning", "fine_tune", "distill"]],
  ["evaluation", ["eval", "test", "benchmark", "score", "metric", "validate"]],
  ["analysis", ["analyz", "plot", "visualiz", "compare", "ablat", "inspect", "interpret"]],
  ["setup", ["install", "setup", "config", "requirements", "environment", "depend"]],
];

export function classifyTaskCategory(title: string): string {
  const lower = title.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "general_compute";
}
