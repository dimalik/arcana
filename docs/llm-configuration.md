# LLM Configuration

Arcana uses the Vercel AI SDK v6 to support multiple LLM providers. You need at least one provider configured.

## Providers

### OpenAI

Set the environment variable:

```env
OPENAI_API_KEY="sk-..."
```

Supports all OpenAI models (GPT-4o, GPT-4 Turbo, etc.).

### Anthropic

Set the environment variable:

```env
ANTHROPIC_API_KEY="sk-ant-..."
```

Supports Claude models (Claude 4.5/4.6 Sonnet, Opus, Haiku).

### OpenAI-compatible proxy

For services that expose an OpenAI-compatible API (OpenRouter, LiteLLM, Azure OpenAI, vLLM, Ollama, etc.):

```env
LLM_PROXY_URL="https://your-proxy.example.com/v1"
```

Some proxies require an API key in the `Authorization` header — configure this in Settings > LLM.

## Model selection

Go to **Settings > LLM** to:

- Select the default model for all operations
- Configure per-operation model overrides (e.g., use a cheaper model for categorization)
- Set temperature and other generation parameters
- Test the connection to each provider

The research agent uses the default model. Sub-agents (literature scouts) use the same model but with shorter context.

## Cost tracking

All LLM calls are instrumented for cost tracking. `src/lib/usage.ts` logs:

- Provider, model, and operation type
- Input/output token counts
- Estimated cost in USD (using a built-in cost table)
- Duration and success/failure status

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

This context can be substantial (10-30k tokens). The AI SDK handles truncation and the agent's `streamText()` loop manages conversation history across auto-continued sessions.

## Provider tips

- **For research agent sessions**: Use the most capable model you can afford. The agent benefits from strong reasoning for experiment design and critique.
- **For paper operations** (summarize, extract, categorize): Mid-tier models work well. These are shorter, more structured tasks.
- **For synthesis**: Use a capable model — synthesis requires reasoning across multiple papers.
- **For sub-agents**: These are lightweight (15 steps max). A mid-tier model is sufficient.
