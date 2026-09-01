# Cometa Bank

A polished mock neobank demo: checking + interest-bearing savings account, transaction
history, mock cards, transfers. Mobile-first web SPA, designed to be ported to a Telegram
Mini App. All data is client-side mock — no real money, no backend.

## Stack

Vite · React 19 · TypeScript · Tailwind CSS v4 · Zustand · Radix (headless sheet behavior)

## Commands

```bash
pnpm install
pnpm dev        # dev server
pnpm verify     # lint + css guards + tests + build (must pass before commit)
```

## Docs

- `docs/spec.md` — full specification (architecture, rejected approaches, milestones)
- `docs/handoff.md` — current status and next steps
- `docs/research/` — research pack behind the spec (sourced facts, red team, UX walkthrough)
- `CLAUDE.md` — project rules and invariants
