# Cometa — Task Board

> Last updated: 2026-09-06. The multi-user demo candidate is local only. Its product behavior and
> prior deploy snapshot passed integrated verification and fresh web QA; the newer Docker/Caddy
> perimeter still needs the final gate and immutable repeat. Production remains on the accepted
> device-local baseline. Source-clean bridge deployment and Telegram Computer Use acceptance remain.

## Conventions

- **ID format**: `KBT-NNN` (sequential, never reuse)
- **Statuses**: `todo` | `in_progress` | `blocked` | `done`
- **Priorities**: `critical` | `high` | `medium` | `low`
- Next available ID: **KBT-031**

---

## Active

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-010 | Принять Telegram Mini App в реальном WebView | in_progress | high | Deferred by owner на pause checkpoint; BotFather binding, signed Main App bootstrap/Home/History и clean relaunch прошли в двух Telegram Old профилях macOS; остаются полный RU/EN callback-onboarding и Android/iOS acceptance |
| KBT-020 | Rotate exposed test bot token до нетестового запуска | blocked | high | Владелец явно разрешил текущий token только для теста; новый token ставить исключительно через hidden-TTY `release.sh install-token`, value не переносить через chat/argv/logs |
| KBT-023 | Eight localized currency fixtures | in_progress | critical | Local candidate preserves owner KZT and adds seven market-specific synthetic fixtures with pinned USD parity and semantic topups; the 536/215 gate and 390×844/320×568 re-smoke predate final perimeter changes; release/acceptance pending |
| KBT-024 | Server-authoritative Telegram ledger | in_progress | critical | Local candidate: per-ID canonical import, pre-body import/command ingress budgets, 30/min pre-SQLite bootstrap budget, settle-then-recur reads, due-state/single-flight client preflight with impossible exact-cap batches suppressed, deep projection, persisted-only inner replay exemption, raw-session isolation and guarded publication; not deployed |
| KBT-025 | Bot transaction and recurrence UX | in_progress | critical | Local RU/EN flow: checking-only income/expense, UTC date, explicit year/month/day, atomic 120-month backfill, no overdraft and atomic session/reply receipts; acceptance pending |
| KBT-026 | Bot account management UX | in_progress | high | Local flow: add checking, current adjustment after savings settlement, reversible zero-balance close/restore, retained History and synchronous active-screen selection normalization; acceptance pending |
| KBT-027 | Live two-profile acceptance and README showcase | todo | high | After local gates and source-clean A/B rollout, use Telegram Old Computer Use for isolated RU/KZT and EN/GEL journeys, then public Playwright and exactly three equal sanitized Telegram captures in one README row; action-time confirmation required |
| KBT-030 | Install Docker/Caddy host perimeter and source-clean bridge | in_progress | critical | Local contract only: package A/B, then after deploy confirmation run Docker installer dry/apply with controlled restart, Caddy harden-edge dry/apply, strict A/B preflight/prepare/activate while ledger remains local; current harness/final review and remote rollout pending |

## Backlog

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-011 | Решения владельца: бренд «Cometa» ok? акцент-минт ok? светлая тема? | blocked | medium | spec §8 — дефолты выбраны, ждут подтверждения |
| KBT-028 | Encrypted offsite SQLite backup and restore drill | todo | high | Explicitly deferred by owner from the demo feature gate; choose another VPS target, retention, alerting and epoch-rotating restore probe |
| KBT-029 | Collapse temporary inner TLS compatibility hop | todo | medium | After two source-clean rollback releases, proxy Caddy to loopback HTTP and remove inner certificate, Certbot volume, inactive units and unreachable legacy renewal lifecycle; preserve API/real-IP semantics and rehearse B→A→B |

## Done

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-001 | Брейншторм + финальная спека (docs/spec.md) | done | critical | Двухдвижковый ран 2026-09-01, артефакты в docs/research/ |
| KBT-002 | M0+M1: скаффолд, токены, platform-seam, домен, store, 35 тестов + 4 mutant-check | done | critical | verify зелёный, коммит b51591d |
| KBT-003 | M2-M5 первый проход: Home/History/Cards, TransferSheet + numpad + success, шиты карт/реквизитов/настроек | done | high | verify зелёный, коммит d4364a4; Home визуально проверен |
| KBT-004 | Визуальная верификация всех экранов и шитов | done | critical | Playwright [320/390/460/700/900], ErrorBoundary, reduced-motion, overflow, targets; Computer View в Chrome |
| KBT-005 | AC M2-M5 на живом приложении | done | critical | Double tap, insufficient funds, 5 переводов, freeze/reload, two-tab concurrency, History immediate |
| KBT-006 | Owner pass на реальном телефоне: «выглядит как прод» | done | high | Владелец проверил live app и подтвердил, что всё работает и выглядит шикарно; отдельный real Telegram WebView gate остаётся KBT-010 |
| KBT-007 | Deploy на Hostinger под `euphoria.bot` | done | critical | `https://euphoria.bot` live; owner-statement release `20260902T113558Z`, rollback `20260902T110137Z`; matching checksums, apex/`www` TLS, SPA/assets/headers, `nginx -t` и live Playwright зелёные |
| KBT-008 | Переключить DNS `euphoria.bot` на Hostinger | done | high | Apex и `www` подтверждены A-записями на `72.60.104.156`; deploy/TLS закрывается отдельно в KBT-007 |
| KBT-012 | Независимый Opus review полного milestone diff | done | high | Post-statement passes нашли startup/eager History/stale callbacks/final-page focus; fixes и mutants зелёные, спорный HMAC P2 отклонён по official protocol; final Opus 5 xhigh repeat `f7678b79` clean, 0 findings |
| KBT-013 | Multi-currency: 8 валют, primary currency, live rates, FX accounts/transfers | done | critical | Shipped baseline: 2 KZT + USD + EUR, persistence v4, integer/BigInt FX, frozen quotes, USD equivalent and generated badges; local v5 fixtures/account lifecycle continue in KBT-023/024 |
| KBT-014 | Migrate Telegram adapter to maintained `@tma.js/sdk-react` | done | high | Миграция на `@tma.js/sdk-react` 3.0.23 / SDK 3.3.0; legacy unsupported packages и override удалены; adapter tests/build green |
| KBT-015 | RU/EN localization с выбором языка | done | high | Полный UI/catalog, locale-aware money/date/input, отдельная web/TMA persistence и cross-tab sync без потери FIFO-toast; host/demo identity provenance; Playwright EN flows и named mutants зелёные |
| KBT-016 | Telegram bot + signed bootstrap infrastructure | done | critical | RU/EN onboarding, 8 currencies, optional name, HMAC bootstrap, SQLite, sequential setup + bounded retry, hardened Docker/Nginx, generated avatar; credential-free source `20260902T113558Z` staged, production image/edge blocked only VPS steal gate |
| KBT-017 | Активировать `@MyBankApp_Bot` | done | critical | Initial Irena activation `20260902T174028Z`: hidden-TTY token validation, TLS, polling-ready, signed bootstrap and renewal timer passed; superseded by live KBT-019 release, exposed test credential tracked separately in KBT-020 |
| KBT-018 | Импортировать owner statement и собрать реалистичную demo-history | done | critical | 369 обезличенных строк, 298 purchases, exact KZT dates/amounts, neutral closing reconciliation, pending ChatGPT hold, synthetic continuation до 2026-09-02, 18 custom merchant marks, 4-account allocation; PII удалены, public-bundle fingerprinting зафиксирован |
| KBT-021 | Harden Telegram lifecycle, preference sync и bot privacy | done | critical | Shipped baseline: 6-day update reset, revision epoch, outbox/shutdown, rolling bootstrap budget, per-ID quarantine/storage and `/privacy`; local authority hardening continues in KBT-024/025 |
| KBT-019 | Перенести `euphoria.bot` и bot runtime на Irena | done | critical | Releases `20260902T233104Z`→`20260902T233133Z` собраны из одного source, оба independently verified; D→C→D rollback rehearsal, real renewal service, public Playwright и two-profile Telegram Old smoke зелёные; Hostinger сохранён external rollback origin |
| KBT-009 | GitHub-репо (nikitacometa) + push | done | high | English product README, real-app showcase and CI published at public `nikitacometa/mock-bank-app`; `main` tracks `origin/main` |
| KBT-022 | Выбрать режим следующей фазы и спроектировать его trust boundary | done | high | Owner selected multi-user demo; server-authoritative per-Telegram-ID design approved in `docs/internal/TELEGRAM_LEDGER_DESIGN_2026_09_05.md` |
