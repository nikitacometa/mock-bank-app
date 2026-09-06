# Cometa

A personal multi-currency banking sandbox for the web and Telegram.

[Live demo](https://euphoria.bot) · [Telegram bot](https://t.me/MyBankApp_Bot)

<p align="center">
  <img src="docs/assets/showcase/hero.png" alt="Cometa multi-currency mock bank across home, transfer, and history screens" width="100%">
</p>

Cometa explores how a small personal finance product can feel calm, fast, and useful. It combines
realistic data, functional money flows, and a Telegram-native launch experience without connecting
to a bank or moving real money.

## Inside the demo

- Eight authentic currency fixtures with comparable USD economics
- Four starting accounts, plus reversible account creation, closing, and restoration
- Portfolio totals in KZT, THB, VND, RUB, USD, EUR, IDR, or GEL
- A dedicated USD equivalent for every active non-USD account
- Daily reference rates with a deterministic offline fallback
- Own-account FX transfers with an immutable rate snapshot
- Simulated contact transfers with retry-safe submission
- Searchable history, pending operations, and custom merchant artwork
- Mock Visa and Mastercard cards with freeze controls
- Calendar-based savings interest recorded directly in the ledger
- Manual income, expenses, and monthly recurring entries on checking accounts, with UTC backfill
- No-overdraft checks and savings corrections applied after interest settlement
- A complete Russian and English interface

## Telegram Mini App

The next release candidate turns the companion bot into a compact command center for the demo:
record an income or expense, backfill a monthly subscription, inspect recurring entries, or manage
accounts without leaving the chat. The live bot still uses the accepted device-local baseline until
the guarded two-release rollout and real-profile acceptance are complete.

In the candidate, Telegram launch data is verified by the backend. The first authenticated device
snapshot becomes canonical; after activation, bot and Mini App commands share one
server-authoritative mock ledger isolated by Telegram ID. A different pre-authority copy on another
device is never uploaded or replaced silently. Native Main Button, Back Button, viewport, theme, and
haptic behavior remain behind the same platform contract used by the web app.

<p align="center">
  <img src="docs/assets/showcase/telegram-onboarding.png" alt="Sanitized illustration of the Cometa Telegram onboarding flow" width="390">
</p>

<p align="center"><sub>Sanitized reconstruction using the bot's current production copy. No personal Telegram profile data is shown.</sub></p>

## Product screens

<p align="center">
  <a href="docs/assets/showcase/home.png"><img src="docs/assets/showcase/home.png" alt="Multi-currency account overview" width="31%"></a>
  &nbsp;
  <a href="docs/assets/showcase/history.png"><img src="docs/assets/showcase/history.png" alt="Searchable transaction history with a pending subscription" width="31%"></a>
  &nbsp;
  <a href="docs/assets/showcase/transfer.png"><img src="docs/assets/showcase/transfer.png" alt="KZT to USD transfer quote" width="31%"></a>
</p>

<p align="center">
  <a href="docs/assets/showcase/cards.png"><img src="docs/assets/showcase/cards.png" alt="Interactive mock cards" width="40%"></a>
  &nbsp;&nbsp;
  <a href="docs/assets/showcase/settings.png"><img src="docs/assets/showcase/settings.png" alt="Language, primary currency, and reference-rate settings" width="40%"></a>
</p>

## Under the surface

```text
React application
├── domain       integer money, ledger, FX, recurrence, account lifecycle
├── store        local web state and guarded Telegram authority sync
├── platform     interchangeable web and signed Telegram adapters
├── interface    mobile-first screens, sheets, and custom visuals
└── bot          Node.js, SQLite, chat flows, signed bank commands
```

Balances are derived from the transaction ledger instead of stored twice. Money uses integer minor
units, completed FX transfers retain their exact rate snapshot, and client transfer IDs make retries
idempotent. Web Locks serialize cross-tab mutations before persistence.

The browser and Telegram environments meet through a narrow platform seam. Web data stays local.
After the guarded authority switch, Telegram stores a revisioned mock snapshot and a bounded
idempotency window per authenticated profile. Balances are never written as independent account
fields.

The live SQLite database and its release-time backups currently share one VPS. Losing Irena in full
can therefore lose Telegram demo changes; encrypted offsite backup and a restore drill are the next
infrastructure milestone, not a capability claimed by this demo.

Vite · React 19 · TypeScript 6 · Tailwind CSS v4 · Zustand · Radix Dialog · `@tma.js/sdk-react` ·
Node.js 22 · SQLite · Vitest

## Data boundary

Cometa is an interactive mock. It has no real money, payment rails, bank connections, KYC, or
financial services.

The KZT fixture ships with 437 deterministic demo transactions after initial interest settlement.
Part of the fixture comes from a
sanitized personal statement: names, account details, card details, statement identifiers, and
booking references were removed, while exact dates, merchants, and amounts remain fingerprintable.
This public repository therefore contains a deliberately disclosed, fingerprintable dataset; it
must not be described as anonymous. The seven non-KZT fixtures are fully synthetic.

## Run locally

Requires Node.js 22 and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
```

Bot and VPS setup use separate secret-safe runbooks:

- [`deploy/bot/README.md`](deploy/bot/README.md)
- [`deploy/standalone/README.md`](deploy/standalone/README.md)

## Status

The web and existing Mini App baseline are live and unchanged. The eight-fixture ledger, per-profile
Telegram authority, and RU/EN transaction, recurrence, and account flows are implemented in the
next release candidate. Its product behavior passed the last integrated test snapshot; the final
Docker/Caddy perimeter changes still need the complete gate and immutable review.

Deployment remains pending. The controlled rollout installs the local-only Docker daemon perimeter,
hardens the Caddy edge, prepares and activates two rollback-compatible releases while authority stays
local, and only then enables the one-way server ledger. Real two-profile journeys, three sanitized
production chat captures, and current Android/iOS WebView acceptance remain open.
