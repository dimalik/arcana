export type AgentMode = "analyze" | "modify";

export interface AgentTemplateContext {
  outputFolder?: string;
  attachPath?: string;
}

export interface AgentTemplate {
  id: string;
  label: string;
  description: string;
  mode: AgentMode;
  promptBuilder: (paper: { title: string; abstract: string | null }, ctx?: AgentTemplateContext) => string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "deep-analysis",
    label: "Deep Analysis",
    description: "Web-enriched comprehensive analysis with multi-step reasoning",
    mode: "analyze",
    promptBuilder: (paper) =>
      `Perform a deep analysis of this paper: "${paper.title}".

Do the following:
1. Read the paper content from the database (it's already provided in context).
2. Search the web for related work, recent citations, and any follow-up papers.
3. Search for the authors' other publications and their research trajectory.
4. Identify the paper's position in the broader research landscape.
5. Assess the novelty and significance of the contributions.

Produce a comprehensive analysis report covering:
- **Research Context**: Where this paper fits in the field, key predecessors and contemporaries
- **Novelty Assessment**: What's genuinely new vs incremental
- **Methodology Critique**: Strengths and weaknesses of the approach
- **Impact & Citations**: How the work has been received (if published)
- **Open Questions**: What the paper leaves unresolved
- **Connections**: Links to related work not cited by the authors`,
  },
  {
    id: "fact-check",
    label: "Fact Check",
    description: "Verify claims and citations against web sources",
    mode: "analyze",
    promptBuilder: (paper) =>
      `Fact-check the key claims in this paper: "${paper.title}".

Do the following:
1. Identify the paper's main empirical claims and stated results.
2. Search the web for the cited sources and verify they support what the paper claims.
3. Check if the reported baselines match what those papers actually reported.
4. Look for any retractions, errata, or contradicting results published after this paper.
5. Verify dataset descriptions and availability.

Report:
- **Verified Claims**: Claims that check out with sources
- **Unverifiable Claims**: Claims that can't be independently confirmed
- **Discrepancies**: Any mismatches between citations and what sources actually say
- **Baseline Accuracy**: Whether reported baseline numbers match original papers
- **Overall Credibility**: Your assessment of the paper's factual reliability`,
  },
  {
    id: "generate-code",
    label: "Generate Code",
    description: "Build a working codebase that replicates the paper's experiments and analyses",
    mode: "modify",
    promptBuilder: (paper, ctx) => {
      const folder = ctx?.outputFolder || "./output";
      const slug = paper.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
      const projectDir = `${folder}/${slug}`;
      const attachPath = ctx?.attachPath;

      const integrationSection = attachPath
        ? `
## Phase 5: Integrate into existing codebase
The user wants this code integrated into their project at: ${attachPath}

1. First, READ the existing project to understand its structure:
   - Look for package.json, requirements.txt, pyproject.toml, Cargo.toml, etc.
   - Understand the directory layout and conventions
   - Check what dependencies are already installed
   - Read any README or docs for conventions

2. Then ADAPT the generated code to fit:
   - Match the existing code style (naming conventions, formatting, patterns)
   - Reuse existing utilities and helpers instead of duplicating
   - Add new dependencies to the existing manifest (don't create a separate one)
   - Place files in logical locations within the existing structure
   - Create a clear integration point (e.g., a new module, a new command, a new route)

3. Write an INTEGRATION_NOTES.md in the project root explaining:
   - What files were added/modified
   - How to run the new code
   - Any new dependencies that were added
   - How the paper's code connects to the existing codebase

IMPORTANT: Do NOT overwrite existing files unless necessary. Prefer adding new files alongside existing ones.`
        : "";

      return `Your goal is to build a COMPLETE, WORKING codebase that replicates ALL experiments and analyses from this paper: "${paper.title}".

This is NOT limited to ML papers. The paper could be from any domain — pharmacology, neuroscience, economics, physics, biology, statistics, social science, etc. Adapt your approach to the paper's domain.

## Phase 1: Study the paper thoroughly
Read the full paper text (provided in the system prompt) and extract:
- **Domain & type**: What kind of paper is this? (ML model, clinical trial analysis, statistical study, simulation, survey, theoretical, etc.)
- **Core method**: The algorithm, model, statistical method, experimental protocol, or analytical framework
- **Parameters**: All hyperparameters, statistical parameters, experimental conditions, dosages, thresholds, etc.
- **Data**: Dataset names, sizes, sources, preprocessing steps, inclusion/exclusion criteria, variable descriptions
- **Pipeline**: The full experimental/analytical pipeline from raw data to final results
- **Metrics**: Evaluation metrics, statistical tests, significance thresholds, outcome measures
- **Figures & tables**: What each figure and table shows — you will recreate these
- **Implementation details**: Languages, libraries, tools, hardware, software versions mentioned

## Phase 2: Research datasets and implementations
Search the web for:
- The paper's official code repository (GitHub links, "code available at...")
- Third-party reimplementations or related implementations
- **Public datasets**: Search for the exact datasets used. Check:
  - Dataset repositories (Kaggle, UCI ML, HuggingFace, Zenodo, PhysioNet, Gene Expression Omnibus, etc.)
  - The paper's supplementary materials or data availability statement
  - Government/institutional data portals
- The specific libraries and frameworks needed for this domain
- If datasets are NOT publicly available, note this — you will generate realistic mock data

## Phase 3: Build the codebase
Write all files into: ${projectDir}/

### Determine the right language and stack
- **ML/DL papers**: Python + PyTorch/TensorFlow/JAX
- **Statistical analysis**: Python (statsmodels, scipy) or R
- **Bioinformatics**: Python (biopython, scanpy) or R (Bioconductor)
- **Neuroscience**: Python (MNE, nilearn, brian2) or MATLAB-style via Python
- **Pharma/clinical**: Python (lifelines, scipy.stats) or R
- **Physics/simulation**: Python (numpy, scipy, fenics) or Julia
- **Economics/social science**: Python (statsmodels, linearmodels) or R
- Use whatever the paper's domain conventionally uses

### Project structure (adapt names to domain):
1. \`README.md\` — overview, setup, how to run each experiment, expected outputs
2. \`requirements.txt\` (or appropriate manifest) — all dependencies with versions
3. \`config.py\` — all parameters from the paper in one place with paper references
4. Core implementation files (name appropriately for the domain):
   - For ML: model.py, train.py, evaluate.py
   - For stats: analysis.py, statistical_tests.py
   - For pharma: pharmacokinetics.py, dose_response.py
   - For neuro: signal_processing.py, analysis.py
   - etc.
5. \`data/\` directory:
   - \`download_data.py\` — script to fetch public datasets (with URLs, checksums if possible)
   - \`mock_data.py\` — generates realistic synthetic data matching the paper's description
   - \`README.md\` in data/ explaining data sources and how to obtain them
6. \`tests/\` directory:
   - \`test_core.py\` — unit tests for the core implementation (correct shapes, expected outputs on known inputs, edge cases)
   - \`test_pipeline.py\` — integration test running the full pipeline on mock data
   - \`test_mock_data.py\` — tests that mock data has expected statistical properties
7. \`figures/\` directory:
   - \`generate_figures.py\` — recreates ALL key figures from the paper using mock data
   - Each figure should be saved as PNG and match the paper's style as closely as possible
   - Use matplotlib, seaborn, plotly, or domain-appropriate visualization libraries
   - Include proper axis labels, legends, titles referencing paper figure numbers

## Phase 4: Verify quality
After writing all files:
1. Run a syntax check: \`python -m py_compile <file>\` for each Python file
2. Run the tests: \`cd ${projectDir} && pip install -r requirements.txt && python -m pytest tests/ -v\`
3. Generate figures: \`python figures/generate_figures.py\`
4. Fix any errors found
${integrationSection}

## Mock data requirements
When creating mock data, it MUST be realistic:
- Match the paper's described distributions, ranges, and scales
- Preserve correlations and relationships described in the paper
- Include the correct number of samples/subjects/observations (or a representative subset)
- For clinical data: realistic demographics, lab values, outcomes
- For scientific data: physically plausible values, correct units
- For ML: correct input shapes, label distributions, feature ranges
- Add a random seed for reproducibility
- Include comments explaining what each variable represents and its real-world source

## Figure generation requirements
- Recreate EVERY key figure from the paper (main text figures, not supplementary unless critical)
- Use mock data to populate them — they won't match the paper's exact numbers but should show similar patterns
- Match the figure's layout: subplots, axes, color schemes
- Include confidence intervals, error bars, statistical annotations where the paper shows them
- Name files as \`figure_1.png\`, \`figure_2.png\`, etc. matching paper numbering
- Save all figures to \`${projectDir}/figures/output/\`

## Test requirements
Tests should verify:
- Core functions produce correct output shapes and types
- Known-input/known-output pairs (use simple examples from the paper if available)
- Edge cases (empty data, single sample, extreme values)
- Statistical properties of mock data (means, variances within expected ranges)
- End-to-end pipeline runs without errors on mock data
- Generated figures are created and are valid image files
- Use pytest with clear test names that reference paper sections

## General requirements
- Every file must be syntactically valid and runnable
- Include docstrings that reference the paper: "Implements Eq. 3 (Section 4.1)" or "See Table 2"
- Use the paper's exact parameters as defaults in config.py
- If something is ambiguous, add a TODO comment with your best guess and reasoning
- Create the output directory first with: mkdir -p ${projectDir}

## CRITICAL
- Do NOT just output code in markdown — WRITE all files to disk
- The codebase must be runnable end-to-end: install deps → download/generate data → run analysis → produce figures
- Aim for a codebase someone could clone and reproduce the paper's methodology (if not exact numbers, at least the same analytical pipeline)`;
    },
  },
  {
    id: "improve-prompts",
    label: "Improve Prompts",
    description: "Read and improve the LLM prompt templates used for paper analysis",
    mode: "modify",
    promptBuilder: (paper) =>
      `Your task is to improve the LLM prompts used by this application for paper analysis.

Context: The user just analyzed "${paper.title}" and wants the analysis quality improved.

Steps:
1. Read the file src/lib/llm/prompts.ts — this contains all prompt templates.
2. Analyze the current prompts critically: are they specific enough? Do they miss important aspects?
3. Read the paper content provided in context to understand what kind of papers this system handles.
4. Improve the prompts based on what you learn. Focus on:
   - Making the summarize prompt produce more insightful reviews
   - Improving the categorize prompt for better tag suggestions
   - Enhancing the extract prompt for more complete metadata extraction
5. Create a git branch named "improve-prompts-{timestamp}" before making changes.
6. Edit src/lib/llm/prompts.ts with your improvements.
7. Explain what you changed and why.

IMPORTANT: Create a git branch before editing any files. Keep the same overall structure and function signatures.`,
  },
  {
    id: "improve-pipeline",
    label: "Improve Pipeline",
    description: "Optimize the auto-processing pipeline for better analysis",
    mode: "modify",
    promptBuilder: (paper) =>
      `Your task is to optimize the paper auto-processing pipeline.

Context: The user processed "${paper.title}" and wants the pipeline improved.

Steps:
1. Read src/lib/llm/auto-process.ts — this is the main processing pipeline.
2. Read src/lib/llm/prompts.ts for the prompts it uses.
3. Read src/lib/llm/provider.ts for the LLM provider setup.
4. Analyze the pipeline for:
   - Inefficiencies (unnecessary sequential calls that could be parallelized)
   - Missing error recovery
   - Quality improvements (better prompt chaining, intermediate results usage)
   - Missing processing steps that would add value
5. Create a git branch named "improve-pipeline-{timestamp}" before making changes.
6. Implement your improvements.
7. Explain what you changed and why.

IMPORTANT: Create a git branch before editing any files. Don't change the database schema.`,
  },
  {
    id: "add-data-fields",
    label: "Add Data Fields",
    description: "Extend the Prisma schema and extraction for this paper type",
    mode: "modify",
    promptBuilder: (paper) =>
      `Your task is to extend the data model to capture more information from papers like "${paper.title}".

Steps:
1. Read the paper content provided in context.
2. Read the Prisma schema at prisma/schema.prisma.
3. Read src/lib/llm/auto-process.ts and src/lib/llm/prompts.ts.
4. Identify what additional structured data would be valuable to extract from papers like this one (e.g., specific metrics, model architectures, datasets used, reproducibility info).
5. Create a git branch named "add-fields-{timestamp}" before making changes.
6. Add new fields to the Prisma schema.
7. Create a migration with: npx prisma migrate dev --name add_paper_fields
8. Update the extraction prompt and pipeline to populate the new fields.
9. Explain what you added and why.

IMPORTANT: Create a git branch before editing any files. The new fields should be optional (nullable) so existing papers aren't affected.`,
  },
  {
    id: "research-step",
    label: "Research Step",
    description: "Execute a research step with full project context",
    mode: "modify",
    promptBuilder: (paper, ctx) => {
      const folder = ctx?.outputFolder || "./output";
      const slug = paper.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
      const projectDir = `${folder}/research/${slug}`;

      return `You are executing a research step for a project investigating "${paper.title}".

Your goal is to generate code and analysis that tests the research hypotheses based on this paper's methodology.

## Instructions
1. Read the paper content (provided in context) thoroughly
2. Identify the core methodology, datasets, and experimental setup
3. Write code to replicate or test the key claims
4. Save all output to: ${projectDir}/

## Output Structure
- \`${projectDir}/README.md\` — what was done, how to run it
- \`${projectDir}/experiment.py\` — main experiment code
- \`${projectDir}/requirements.txt\` — dependencies
- \`${projectDir}/results/\` — any generated outputs

## Quality Requirements
- Code must be syntactically valid and runnable
- Include mock data generation if real data isn't available
- Reference specific paper sections in comments
- Run tests/validation before finishing

IMPORTANT: Write all files to disk, don't just output code in markdown.`;
    },
  },
];

export function getTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}
