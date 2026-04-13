# Contributing to Arcana

Thanks for your interest in contributing! Arcana is an open-source research platform and we welcome contributions of all kinds — bug fixes, new features, documentation, and ideas.

## Getting Started

```bash
git clone https://github.com/dimalik/arcana.git
cd arcana
npm install
npx prisma migrate dev
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
npm run db:migrate   # Create/apply development migrations
npm run db:deploy    # Apply checked-in migrations without creating a new one
npx prisma studio    # Browse the database
npx tsc --noEmit     # Type-check without building
npm run check:experiment-integrity  # Validate run lifecycle invariants in prisma/dev.db
npm run acceptance:superpowers -- --project <project-id>  # Run non-UI acceptance checks for superpowers contracts
npm run acceptance:credibility -- --project <project-id>  # Run claim-ledger and promotion acceptance checks
```

**Existing local DBs**

If your local `prisma/dev.db` was previously brought forward with `npx prisma db push`, adopt the catch-up migration before using `prisma migrate deploy`:

```bash
npx prisma migrate resolve --applied 20260410223000_research_platform_catchup
```

If you already tried to apply it and hit `P3018`, first mark the failed attempt as rolled back, then mark it applied:

```bash
npx prisma migrate resolve --rolled-back 20260410223000_research_platform_catchup
npx prisma migrate resolve --applied 20260410223000_research_platform_catchup
```

## Behavior Changes (Agent / Execution)

If you change agent or experiment execution behavior, include all of the following in the same PR:

1. Spec + plan docs under `docs/superpowers/specs` and `docs/superpowers/plans`.
2. User-facing doc updates (`docs/research-agent.md`, `docs/remote-execution.md`, or API docs as needed).
3. Evidence from `npm run check:experiment-integrity`.

Reference governance doc: `docs/superpowers/specs/2026-04-10-behavior-change-governance.md`.

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
