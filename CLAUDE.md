# Cometa (kaspy-bank-telegram)

Минималистичный mock-необанк уровня «премиальный прод 2026»: два счёта (текущий +
накопительный с процентом), история, мок-карты, переводы. Все данные — клиентский мок.
Фаза 1 — mobile-first веб-SPA, фаза 2 — Telegram Mini App. Полная спека: `docs/spec.md`
(читать ПЕРВОЙ — там архитектура, отвергнутые подходы с причинами, майлстоуны с AC).
Хендофф-статус: `docs/handoff.md`. Ресёрч-база (дайджест, red team, user-lens): `docs/research/`.

## Stack

- Vite 8 + React 19 + TypeScript (пин **TS 6.x** — typescript-eslint не поддерживает TS 7)
- Tailwind CSS v4 (`@theme` в `src/styles/tokens.css`), Zustand 5, Radix Dialog (только headless-поведение Sheet)
- Vitest; pnpm; деплой — Cloudflare Pages (планово; wrangler ещё не подключён)

## Key Commands

```bash
pnpm dev            # dev server
pnpm verify         # lint + css-guards + tests + build — ОБЯЗАН быть зелёным перед каждым коммитом
pnpm test           # vitest
```

## Hard Rules (архитектурные инварианты из спеки — не переобсуждать без чтения spec.md §4-5)

- **Баланс — производная от лога**: баланс счёта = `balanceAfterMinor` последней строки
  `Transaction`. НИКОГДА не добавлять мутируемое поле баланса на `Account`. Инвариант
  проверяется `assertLedger` после каждой мутации (DEV-only).
- **Деньги — целые копейки** (`Money = number`), никаких float. Форматирование только через
  `domain/money.ts` (типографский минус «−», tabular-nums).
- **Platform seam**: `window.Telegram` / голый `localStorage` — только внутри `src/platform/**`
  и `src/store/persistence.ts` (ESLint-гард); `env(safe-area-inset-*)` и `100vh/dvh` — только
  в `tokens.css` / `platform/` (`scripts/check-css-guards.sh`). Экраны говорят с платформой
  только через `usePlatform()` / `PrimaryAction`.
- **Без роутера** — стейт-машина `uiStore` (screen + sheet). Причина в spec.md §4.
- **Отвергнутые зависимости** (не возвращать без новых аргументов): Dexie, framer-motion/motion,
  React Router, faker в рантайме, полный shadcn/ui, Next.js. Причины — spec.md §4.
- **Идемпотентность перевода**: `clientTransferId` (ring-buffer 50) отдельно от
  `transferGroupId` (только UI-связка ног). Повтор id = успешный no-op.
- **Проценты** — только строками лога через `applySettle*`, календарные UTC-дни
  (`epochDayUTC`), никаких таймеров и «тикающих» display-значений.

## Test Discipline

- Домен-изменение → тест + **mutant-check**: мутант выбирается из НАЗВАНИЯ теста, файл обязан
  компилироваться, падает именно названный тест, остальные зелёные. Бэкапить файл перед
  мутацией (`cp` в scratchpad), восстанавливать копией, не `git checkout`.
- Прогнанные мутанты M0/M1: знак кредит-ноги, Math.max в accrual, дроп idempotency-чека,
  знак в appendRow — все убиты (сессия 2026-09-01).

## Design System (dark-only, фаза 1)

- Токены — только семантические CSS-переменные в `tokens.css` (`--color-bg/surface/ink/...`).
  Бренд-акценты: `--color-ivory` (CTA, тёплое на холодном) и `--color-mint` (ТОЛЬКО
  рост/накопительный/успех). `--color-coral` — только знак расхода/ошибки. В фазе 2
  `bindCssVars()` привязывает К ТЕМЕ ХОСТА ТОЛЬКО нейтрали — бренд-акценты никогда (red team №11).
- Шрифты: Geist (кириллица подтверждена по метаданным Google Fonts 2026-09-01) + Geist Mono
  на все деньги/номера (класс `.num`).
- Иконки — ТОЛЬКО кастомные из `src/ui/icons.tsx` (единый штрих 1.75). Не ставить Lucide и
  прочие стоковые наборы — это AI-slop-маркер (spec.md §5.4).
- Дисциплина: ≤3 фокальных элементов на экран; glow/акцент = состояние, не декор; сигнатура —
  след кометы (hero, карты, логотип); никакого neumorphism / indigo-градиентов / золото-люкса.
- UI-копирайт: разговорный русский, без канцелярита (глобальный russian-writing-guide
  применяется и к продуктовым текстам).

## Telegram Mini App (фаза 2 — ещё не начата)

- Порт = написать `src/platform/adapter.telegram.ts` под контрактом `platform/types.ts` +
  подмена в `PlatformProvider`. Экраны не трогаются.
- SDK: `@telegram-apps/sdk-react` (3.x). Probe до старта: интеграция в Vite (все примеры на
  Next.js) + статус Android-бага self-reload (issue #86 Telegram-Mini-Apps). Чеклист и грабли:
  `docs/research/digest.md` (линза 3).
- Web-storage и TMA-storage изолированы — состояние демо НЕ переносится, это ожидаемо.

## Deploy / Brand

- Cloudflare Pages, сначала `*.pages.dev`; кастомный домен даст владелец. Vercel запрещён
  (Hobby ToS). GitHub-репо ещё не создан; при создании — аккаунт `nikitacometa`, приватный.
- Имя в UI — «Cometa» (`src/app/config.ts`). «Kaspy» не использовать в UI: риск Kaspi Bank +
  скам-паттерн FEMITBOT (spec.md §7). Демо-водяной знак и disclaimer не удалять.

## Task Board

Tasks in `BOARD.md`. Format: pantheon. Prefix: KBT.
