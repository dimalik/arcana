# LLM Configuration

Arcana uses the Vercel AI SDK v6 to support multiple LLM providers. You need at least one provider configured.

## Providers

### OpenAI

Set the environment variable:

```env
OPENAI_API_KEY="sk-..."
```

Supports all OpenAI models (GPT-4o, GPT-4 Turbo, etc.). The research agent adapts for GPT models with condensed prompts and directive loops (see [Non-Claude model support](#non-claude-model-support)).

### Anthropic

Set the environment variable:

```env
ANTHROPIC_API_KEY="sk-ant-..."
```

Supports Claude models (Claude 4.5/4.6 Sonnet, Opus, Haiku).

### OpenAI-compatible proxy

For services that expose an OpenAI-compatible API (OpenRouter, LiteLLM, Azure OpenAI, vLLM, Ollama, etc.), configure the endpoint in **Settings → LLM → Proxy / Custom**, or set the environment variable:

```env
LLM_PROXY_URL="https://your-endpoint.example.com/v1"
```

Some endpoints require authentication — configure the auth header in Settings → LLM.

## Model selection

Go to **Settings > LLM** to:

- Select the default model for all operations
- Configure per-operation model overrides (e.g., use a cheaper model for categorization)
- Set temperature and other generation parameters
- Test the connection to each provider

The research agent uses the default model. Sub-agents (synthesizer, architect) prefer Opus-class models when available. Literature scouts and other lightweight sub-agents use the same model but with shorter context.

## Non-Claude model support

The research agent is designed for Claude but works with GPT and other models through three adaptations:

1. **Condensed system prompt** — the full ~18K token system prompt is replaced with a phase-specific condensed version covering essential rules, current phase, available tools, and environment info. Marked with `[CONDENSED]` to prevent double-condensing.

2. **Reduced tool set** — non-Claude models receive only the essential tools for the current phase instead of the full ~40 tool set. This avoids confusion from too many options.

3. **Directive loop** — GPT models emit text after each tool call, causing the SDK loop to stop after one step. Arcana compensates with an outer loop that sends phase-specific directives after each tool round (up to 15 rounds per session). Directives are context-aware: if the agent hasn't searched for papers yet, it's told to search; if it has papers but no synthesis, it's told to synthesize; etc.

## Cost tracking

All LLM calls are instrumented for cost tracking. `src/lib/usage.ts` logs:

- Provider, model, and operation type
- Input/output token counts
- Estimated cost in USD (using a built-in cost table)
- Duration and success/failure status
- Per-paper and per-project cost breakdowns

View usage stats in the **Admin** dashboard (`/admin`). Data is grouped by model, operation, and day with a 30-day rolling window.

## Context management

The research agent builds a large system prompt that includes:

- Project brief and methodology
- Paper summaries from the collection
- Remote host configuration and GPU hardware info
- Agent capabilities and custom tools
- Process memories (lessons from past experiments)
- Shared utility descriptions
- Resource preferences learned from user choices
- Structured research state (RESEARCH_STATE.md): current phase, hypotheses, approach tree, experiment results, pending jobs

This context can be substantial (10-30k tokens). The AI SDK handles truncation and the agent's `streamText()` loop manages conversation history across auto-continued sessions.

## Provider tips

- **For research agent sessions**: Use the most capable model you can afford. The agent benefits from strong reasoning for experiment design and critique. Claude models work best due to native multi-step tool calling.
- **For paper operations** (summarize, extract, categorize): Mid-tier models work well. These are shorter, more structured tasks.
- **For synthesis**: Use a capable model — synthesis requires reasoning across multiple papers.
- **For sub-agents**: Synthesizer and architect benefit from Opus-class models. Scouts are lightweight (15 steps max) and work with mid-tier models.
- **For auto-fix and metric recompute**: Standard-tier models are sufficient — these are focused, structured tasks.
- **For research chat**: Standard-tier models work well. Server-side retrieval keeps context focused.
