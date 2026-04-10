# Contributing to Arcana

Thanks for your interest in contributing! Arcana is an open-source research platform and we welcome contributions of all kinds — bug fixes, new features, documentation, and ideas.

## Getting Started

```bash
git clone https://github.com/dimalik/arcana.git
cd arcana
npm install
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The onboarding wizard will walk you through LLM setup.

## Development

**Stack:** Next.js 14 (App Router), TypeScript, Tailwind, shadcn/ui, Prisma + SQLite, Vercel AI SDK v6.

**Key directories:**

| Path | What lives there |
|------|-----------------|
| `src/app/` | Next.js routes and pages |
| `src/components/` | React components |
| `src/lib/research/` | Research agent, remote execution, preflight, auto-fix |
| `src/lib/llm/` | LLM provider abstraction, proxy settings, prompts |
| `scripts/` | Remote helper (`arcana_helper.py`), utilities |
| `prisma/` | Schema and migrations |

**Useful commands:**

```bash
npm run dev          # Start dev server with Turbopack
npx prisma studio    # Browse the database
npx tsc --noEmit     # Type-check without building
```

## Submitting Changes

1. **Fork and branch** — create a feature branch from `main`.
2. **Keep it focused** — one PR per feature or fix. Don't bundle unrelated changes.
3. **Type-check** — run `npx tsc --noEmit` before pushing. CI will catch it anyway, but it's faster locally.
4. **Test your changes** — if you're touching the research agent or remote execution, test with an actual research project if possible.
5. **Write a clear PR description** — explain what changed and why. Screenshots for UI changes.

## What to Work On

Check the [issues](https://github.com/dimalik/arcana/issues) for bugs and feature requests. Issues labeled `good first issue` are a good starting point.

Some areas that could always use help:

- **Paper import** — more source support, better metadata extraction, edge cases
- **UI polish** — accessibility, mobile responsiveness, dark mode improvements
- **Documentation** — guides, examples, architecture docs
- **Testing** — the project currently has minimal test coverage

## Architecture Notes

A few things to know before diving in:

- **The research agent** (`src/lib/research/agent.ts`) is large (~5000 lines) and defines all agent tools. If you're adding a new tool, follow the patterns of existing ones.
- **The remote helper** (`scripts/arcana_helper.py`) runs on GPU hosts and must be stdlib-only Python (no pip dependencies except pyright which is lazily installed).
- **Prisma client** is generated to `src/generated/prisma/client` — import from there, not from `@prisma/client`.
- **AI SDK v6** has different APIs than v4/v5. Check existing code for patterns (`streamText` returns directly, `useChat` from `@ai-sdk/react`, etc.).

## Code Style

- TypeScript with strict mode
- Tailwind for styling, shadcn/ui components
- No unnecessary abstractions — three similar lines beat a premature helper function
- Comments only where the logic isn't self-evident

## Reporting Bugs

Open an issue with:

1. What you expected to happen
2. What actually happened
3. Steps to reproduce
4. Browser console errors if applicable

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
