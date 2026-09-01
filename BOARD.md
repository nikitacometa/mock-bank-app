# Cometa — Task Board

> Last updated: 2026-09-01

## Conventions

- **ID format**: `KBT-NNN` (sequential, never reuse)
- **Statuses**: `todo` | `in_progress` | `blocked` | `done`
- **Priorities**: `critical` | `high` | `medium` | `low`
- Next available ID: **KBT-013**

---

## Active

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-004 | Визуальная верификация всех экранов (History, Cards, шиты — рендерились только Home) | todo | critical | Playwright скриншоты [390/460/700/900], чек-лист против AI-дефолтов — spec §6 M6 |
| KBT-005 | Прогнать AC майлстоунов M2-M5 на живом приложении | todo | critical | Двойной тап перевода, battery AC из spec §6; тесты зелёные, но UI-флоу руками не проверены |
| KBT-006 | Полировка M6: движение, a11y-гейт (контраст AA — несколько раундов), копирайт-проход | todo | high | spec §6 M6; ниты из handoff §3 (щель тысяч в моно, UTC-время сида) |

## Backlog

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-007 | Деплой на Cloudflare Pages (`*.pages.dev`) | todo | high | wrangler не подключён; probe привязки домена — spec §6 M7 |
| KBT-008 | Кастомный домен | blocked | medium | Ждёт домен от владельца |
| KBT-009 | GitHub-репо (nikitacometa, private) + push | todo | medium | CI-workflow уже в репо |
| KBT-010 | Фаза 2: TMA-порт (`adapter.telegram.ts`) | todo | medium | Probe SDK-в-Vite + issue #86 ДО старта; bindCssVars только нейтрали — spec §6 M8 |
| KBT-011 | Решения владельца: бренд «Cometa» ok? акцент-минт ok? светлая тема? | blocked | medium | spec §8 — дефолты выбраны, ждут подтверждения |
| KBT-012 | Ревью-проход вторым движком по M2-M5 диффу | todo | medium | Codex-квота до 07.09 пуста; либо Claude dual-review, либо после ресета |

## Done

| ID | Task | Status | Priority | Notes |
|----|------|--------|----------|-------|
| KBT-001 | Брейншторм + финальная спека (docs/spec.md) | done | critical | Двухдвижковый ран 2026-09-01, артефакты в docs/research/ |
| KBT-002 | M0+M1: скаффолд, токены, platform-seam, домен, store, 35 тестов + 4 mutant-check | done | critical | verify зелёный, коммит b51591d |
| KBT-003 | M2-M5 первый проход: Home/History/Cards, TransferSheet + numpad + success, шиты карт/реквизитов/настроек | done | high | verify зелёный, коммит d4364a4; Home визуально проверен |
