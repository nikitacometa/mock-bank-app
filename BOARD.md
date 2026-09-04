# Cometa — Task Board

> Last updated: 2026-09-04. Development paused by owner; resume order is in `docs/next-phase.md`.

## Conventions

- **ID format**: `KBT-NNN` (sequential, never reuse)
- **Statuses**: `todo` | `in_progress` | `blocked` | `done`
- **Priorities**: `critical` | `high` | `medium` | `low`
- Next available ID: **KBT-023**

---

## Active

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-010 | Принять Telegram Mini App в реальном WebView | in_progress | high | Deferred by owner на pause checkpoint; BotFather binding, signed Main App bootstrap/Home/History и clean relaunch прошли в двух Telegram Old профилях macOS; остаются полный RU/EN callback-onboarding и Android/iOS acceptance |
| KBT-020 | Rotate exposed test bot token до нетестового запуска | blocked | high | Владелец явно разрешил текущий token только для теста; новый token ставить исключительно через hidden-TTY `release.sh install-token`, value не переносить через chat/argv/logs |

## Backlog

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-011 | Решения владельца: бренд «Cometa» ok? акцент-минт ok? светлая тема? | blocked | medium | spec §8 — дефолты выбраны, ждут подтверждения |
| KBT-022 | Выбрать режим следующей фазы и спроектировать его trust boundary | todo | high | Personal mock vs multi-user demo vs real financial product; до решения не смешивать client-only ledger с real-money claims, детали в `docs/next-phase.md` |

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
| KBT-013 | Multi-currency: 8 валют, primary currency, live rates, FX accounts/transfers | done | critical | Ровно 4 demo-счёта: 2 KZT + USD + EUR; закрытый набор 8 валют; Integer/BigInt FX, exact frozen base quotes, USD-эквивалент активного счёта, IDR hidden-minor safety, persistence v4, последний полный same-date Frankfurter set из bounded range, fallback/cache, generated badges; все whole-state mutators rebased под Web Lock |
| KBT-014 | Migrate Telegram adapter to maintained `@tma.js/sdk-react` | done | high | Миграция на `@tma.js/sdk-react` 3.0.23 / SDK 3.3.0; legacy unsupported packages и override удалены; adapter tests/build green |
| KBT-015 | RU/EN localization с выбором языка | done | high | Полный UI/catalog, locale-aware money/date/input, отдельная web/TMA persistence и cross-tab sync без потери FIFO-toast; host/demo identity provenance; Playwright EN flows и named mutants зелёные |
| KBT-016 | Telegram bot + signed bootstrap infrastructure | done | critical | RU/EN onboarding, 8 currencies, optional name, HMAC bootstrap, SQLite, sequential setup + bounded retry, hardened Docker/Nginx, generated avatar; credential-free source `20260902T113558Z` staged, production image/edge blocked only VPS steal gate |
| KBT-017 | Активировать `@MyBankApp_Bot` | done | critical | Initial Irena activation `20260902T174028Z`: hidden-TTY token validation, TLS, polling-ready, signed bootstrap and renewal timer passed; superseded by live KBT-019 release, exposed test credential tracked separately in KBT-020 |
| KBT-018 | Импортировать owner statement и собрать реалистичную demo-history | done | critical | 369 обезличенных строк, 298 purchases, exact KZT dates/amounts, neutral closing reconciliation, pending ChatGPT hold, synthetic continuation до 2026-09-02, 18 custom merchant marks, 4-account allocation; PII удалены, public-bundle fingerprinting зафиксирован |
| KBT-021 | Harden Telegram lifecycle, preference sync и bot privacy | done | critical | 6-day update reset, revision epoch, outbox/shutdown, rolling bootstrap budget, per-ID quarantine/storage, `/privacy`; 374 web + 102 bot tests, renewal harnesses и named mutants зелёные |
| KBT-019 | Перенести `euphoria.bot` и bot runtime на Irena | done | critical | Releases `20260902T233104Z`→`20260902T233133Z` собраны из одного source, оба independently verified; D→C→D rollback rehearsal, real renewal service, public Playwright и two-profile Telegram Old smoke зелёные; Hostinger сохранён external rollback origin |
| KBT-009 | GitHub-репо (nikitacometa, private) + push | done | high | Полный milestone, English product README, real-app showcase и CI опубликованы в private `nikitacometa/mock-bank-app`; `main` отслеживает `origin/main` |
