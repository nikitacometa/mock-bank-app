# Cometa (kaspy-bank-telegram)

Минималистичный mock-необанк уровня «премиальный прод 2026»: ровно четыре demo-счёта
(два KZT, один USD и один EUR), закрытый набор из восьми поддерживаемых валют,
настраиваемая основная валюта, накопительный счёт с процентом, live reference rates,
история, мок-карты и переводы. Все банковские данные — клиентский мок.
Приложение работает как mobile-first веб-SPA и содержит Telegram Mini App adapter.
Полная спека: `docs/spec.md`
(читать ПЕРВОЙ — там архитектура, отвергнутые подходы с причинами, майлстоуны с AC).
Хендофф-статус: `docs/handoff.md`. Ресёрч-база (дайджест, red team, user-lens): `docs/research/`.

## Stack

- Vite 8 + React 19 + TypeScript (пин **TS 6.x** — typescript-eslint не поддерживает TS 7)
- Tailwind CSS v4 (`@theme` в `src/styles/tokens.css`), Zustand 5, Radix Dialog (только headless-поведение Sheet)
- Vitest; pnpm; deploy target — dedicated Irena VPS (`ssh irena`), `euphoria.bot`

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
- **Деньги — целые minor units** (`Money = number`), никаких float. Форматирование только через
  `domain/money.ts` (типографский минус «−», tabular-nums).
- **Валюты — закрытый набор**: `KZT`, `THB`, `VND`, `RUB`, `USD`, `EUR`, `IDR`, `GEL`.
  Конвертация идёт через integer/BigInt arithmetic; проведённый FX-перевод хранит immutable
  snapshot курса и не пересчитывается после refresh. IDR-баланс с hidden minor units нельзя
  округлять вверх; положительный shortfall округляется вверх до минимальной видимой рупии.
  Delayed live response не заменяет более новый snapshot: сначала сравнивается `asOf`, затем
  `fetchedAt`. Home всегда показывает эквивалент активного не-USD счёта именно в USD; выбранная
  primary currency влияет только на total всего портфеля.
- **Owner statement fixture**: `statementData.ts` хранит 369 обезличенных строк выписки
  2025-12-19…2026-06-30 и точные KZT-суммы; после неё `seed.ts` детерминированно продолжает
  историю до 2026-09-02. В tracked code запрещены ФИО/ИИН, реальные account/card/statement
  identifiers, P2P-имена и booking references. Exact dates/merchants/amounts всё равно лежат в
  публичном JS bundle — это осознанный privacy-risk, его нельзя скрывать в handoff. Pending
  transaction влияет на available ledger balance, но обязан иметь явный RU/EN badge.
- **Cross-tab mutations**: любой store action, который сохраняет whole `BankState`, обязан захватить
  `withPersistenceLock()` и перечитать persisted state внутри lock до перехода. `storage` event сам по себе
  не предотвращает lost update. First-run seed также выбирается под этим lock. После failed
  `savePersisted()` in-memory state authoritative: stale storage и cross-tab events игнорируются
  до успешной записи. Если сам Web Lock rejected до входа в callback, mutation выполняется один
  раз без lock только пока persistence namespace не сменился; смена namespace обязана дать
  `AbortError`. Ошибка уже начатого callback никогда не ретраится. `settleNow()` обязан rebase
  свежий persisted state даже в no-accrual ветке, а `setPrimaryCurrency()` — даже если валюта уже
  выбрана; foreground и persisted `pageshow` вызывают resync. Persistence parser возвращает точную
  проекцию девяти `BankState`-полей: неизвестные persisted keys не могут заменить actions/status.
- **Platform seam**: `window.Telegram` / голый `localStorage` — только внутри `src/platform/**`
  и `src/store/persistence.ts` (ESLint-гард); `env(safe-area-inset-*)` и `100vh/dvh` — только
  в `tokens.css` / `platform/` (`scripts/check-css-guards.sh`). Экраны говорят с платформой
  только через `usePlatform()` / `PrimaryAction`.
- **Без роутера** — стейт-машина `uiStore` (screen + sheet). Причина в spec.md §4.
- **Отвергнутые зависимости** (не возвращать без новых аргументов): Dexie, framer-motion/motion,
  React Router, faker в рантайме, полный shadcn/ui, Next.js. Причины — spec.md §4.
- **Идемпотентность перевода**: `clientTransferId` (ring-buffer 50) отдельно от
  `transferGroupId` (только UI-связка ног). Новый перевод возвращает `applied: true`, а own-FX
  ещё и точный `incomingAmountMinor`; повтор id = успешный no-op с `applied: false` без receipt.
  UI генерирует id через `src/ui/clientTransferId.ts`/`crypto.getRandomValues`: прямой
  `crypto.randomUUID()` запрещён, потому что real-phone HTTP preview не является SecureContext.
- **Toast delivery**: notices идут FIFO; outer live-region не размонтируется, пока modal-копия
  становится единственной active region внутри `Dialog.Content`. Одинаковые соседние сообщения
  имеют разные `id` и lifecycle визуального bubble. Передача того же toast ID из modal наружу
  сохраняет bubble, но не повторяет live announcement и entry animation.
- **Проценты** — только строками лога через `applySettle*`, календарные UTC-дни
  (`epochDayUTC`), никаких таймеров и «тикающих» display-значений. Persistence не принимает
  `accrualAnchor` раньше UTC-дня создания счёта и preflight'ит реальный settlement на load;
  runtime settlement failure логируется и не превращается в unhandled rejection.
- **Crash recovery**: ErrorBoundary reset сначала пересоздаёт bank state, затем `resetUi()`
  возвращает Home/checking и очищает sheet/toast queue до remount. Иначе sheet-specific crash
  зацикливает fallback. Crash message — единственный `role=alert`, recovery button получает focus.

## Test Discipline

- Домен-изменение → тест + **mutant-check**: мутант выбирается из НАЗВАНИЯ теста, файл обязан
  компилироваться, падает именно названный тест, остальные зелёные. Бэкапить файл перед
  мутацией (`cp` в scratchpad), восстанавливать копией, не `git checkout`.
- Прогнанные мутанты: ledger/accrual signs and overflow, idempotency, FX rounding/date integrity,
  failed persistence, bootstrap/rates races, receipt replay, future ID collision, insecure-context
  transfer ID, accrual-anchor bound/preflight, settlement containment/resync, reset live-region,
  modal toast handoff, ErrorBoundary UI reset/alert/focus, exact persistence projection,
  same-primary rebase, USD self-equivalent, statement reconciliation/schema migration,
  seeded FX chronology, pending-status propagation/validation, merchant matching, Telegram
  native-control replay, bounded bootstrap splash/retry, per-user Telegram persistence isolation,
  rejected-lock account switch, same-ID dirty recovery, initial persistence rejection containment,
  preference revision epoch, six-day Telegram
  update-sequence reset, sequential bot setup, `retry_after`, non-blocking outbox/HOL backoff,
  abortable bot shutdown, `/privacy`, completed/custom-name onboarding preservation, SQLite
  migration materialization, standalone renewal signal/crash recovery and host-worker rollback,
  legacy TLS rollback, History focus и monotonic live announcement — все убиты
  (сессии 2026-09-01/02/03).

## Design System (dark-only, фаза 1)

- Токены — только семантические CSS-переменные в `tokens.css` (`--color-bg/surface/ink/...`).
  Бренд-акценты: `--color-ivory` (CTA, тёплое на холодном) и `--color-mint` (ТОЛЬКО
  рост/накопительный/успех). `--color-coral` — только знак расхода/ошибки. В фазе 2
  `bindCssVars()` привязывает к тёмной теме хоста только нейтрали; в light host остаются
  brand-safe базовые токены. Бренд-акценты не привязываются никогда (red team №11).
- Шрифты: Geist (кириллица подтверждена по метаданным Google Fonts 2026-09-01) + Geist Mono
  на все деньги/номера (класс `.num`).
- Иконки — ТОЛЬКО кастомные из `src/ui/icons.tsx` (единый штрих 1.75). Не ставить Lucide и
  прочие стоковые наборы — это AI-slop-маркер (spec.md §5.4).
- Дисциплина: ≤3 фокальных элементов на экран; glow/акцент = состояние, не декор; сигнатура —
  след кометы (hero, карты, логотип); никакого neumorphism / indigo-градиентов / золото-люкса.
- UI-копирайт: разговорный русский, без канцелярита (глобальный russian-writing-guide
  применяется и к продуктовым текстам).

## Telegram Mini App

- `src/platform/adapter.telegram.ts` реализует тот же `platform/types.ts` contract, что web;
  экраны не знают, где запущены.
- Telegram host theme может перекрашивать нейтрали только в тёмной схеме; light host оставляет
  brand-safe базу и native chrome `#101116`. Core init имеет bounded retries 250/750/1500/3000 ms
  и visibility re-probe с restart ladder; `ready()`/viewport expand one-shot. Preference bootstrap
  держит splash минимум до identity isolation и максимум 4.5 секунды после неё, повторяет только
  retryable failures: не больше 12 стартов за rolling 5 минут, external signals имеют 30-секундный
  cooldown и coalesce последний in-flight retry. Late-mounted Main/Back controls обязаны получить
  сохранённые config/handlers, а MainButton
  нельзя hide/show на каждом изменении text/disabled. Native control считается доступным только
  после mount + config + handler, иначе остаётся DOM fallback.
- SDK: maintained `@tma.js/sdk-react` 3.0.23 (`@tma.js/sdk` 3.3.0). Legacy
  `@telegram-apps/*` packages запрещено возвращать: они unsupported. Реальный
  BotFather binding готов, signed macOS Telegram WebView pass пройден; полный bot onboarding и
  текущие Android/iOS clients ещё обязательны. Unit tests и browser emulation их не заменяют.
  Чеклист и грабли: `docs/research/digest.md`
  (линза 3).
- Web-storage и TMA-storage изолированы — состояние демо НЕ переносится, это ожидаемо. В TMA bank,
  locale и receipt лежат в отдельных namespace по canonical Telegram ID. До HMAC-verified bootstrap
  используется только ephemeral quarantine: unknown/malformed host identity не читает и не пишет
  чужой snapshot. `storage` events принимаются только из активного namespace; failed same-ID write
  остаётся in-memory authoritative до успешного retry.
- Raw `initData` валидирует только bot backend через Telegram HMAC и freshness bound. Frontend
  применяет только versioned bootstrap response с canonical `telegramId`, locale, currency,
  display name, monotonic revision и lowercase 128-bit `revisionEpoch`. Receipt v2 привязан к
  Telegram user + epoch + BankState schema; новый DB epoch имеет приоритет даже при меньшем
  revision. Смена Telegram account сначала изолирует UI, затем восстанавливает собственный snapshot
  или reseed'ит собственный mock ledger после server verification.
- Bot backend хранит Telegram/private-chat ID, locale, primary currency, display name, onboarding
  stage, revision + epoch, exact processed-update window и durable pending reply до доставки или
  окончательного отклонения. Банковские счета/ledger/карты на сервер не уходят. `/privacy`
  раскрывает эту границу на RU/EN.
- Bot profile/setup API calls выполняются последовательно; transient network/429/5xx failures имеют
  bounded retries с Telegram `retry_after`, permanent 4xx fail closed. Exact-ID dedupe не считает
  меньший случайный `update_id` старым: после шести суток без update sequence offset сбрасывается
  до следующего Telegram poll. Outbox drain идёт после успешного poll, не влияет на readiness,
  ретраит строки независимо и не блокирует остальных пользователей. Worker `AbortSignal` обязан
  отменять in-flight send/callback/menu request и retry sleep внутри 20-секундного shutdown grace.
  Callback от старой language keyboard не имеет права откатить уже завершённый onboarding.

## Deploy / Brand

- Deploy target: dedicated Irena VPS (`ssh irena`) + `euphoria.bot`; runtime root —
  `/srv/cometa-bank`. Release `20260902T233133Z` active/healthy, identical-source release
  `20260902T233104Z` is automatic previous; D→C→D rollback rehearsal and the real systemd renewal
  service passed. Legacy Hostinger remains the TLS-valid external rollback origin until Android/iOS
  acceptance. System, Cloudflare, Google and Quad9 resolvers converge on Irena.
  Перед изменением live traffic обязательны read-only preflight,
  prepared HTTP origin, точная DNS-проверка и сохранённый Hostinger rollback. Первый Irena vhost
  намеренно без HSTS; включать его можно только после полного renewal→reload→served-SNI цикла.
- Standalone deploy идёт только через `deploy/standalone/scripts/release.sh`: immutable image-ID
  manifest, serialized deploy/renew lock, health stability window и atomic `current`/`previous`.
  Bot не публикует host port; Nginx — единственный public edge на 80/443. Certificate renewal
  исполняет root-owned worker, привязанный record-файлом к immutable source release, а не к
  откатываемому `current`. Legacy migration использует persistent systemd guard + timer journal;
  pending recovery, deterministic orphan или Docker metadata error блокируют prepare/activate/
  rollback до успешного `--recover-only`. App rollback не понижает hardened renewal worker.
- Bot token принимается только через hidden TTY prompt и service-owned file boundary; token запрещён
  в `.env`, argv, shell history, docs и chat. Owner-authorized exposed token сейчас допускается только
  для test acceptance и обязан быть revoke/rotate до любого public/non-test use; не считать это
  прецедентом для следующих credentials.
- Private GitHub remote: `git@github.com:nikitacometa/mock-bank-app.git`; `main` отслеживает
  `origin/main`. Не менять visibility на public, пока fingerprintable statement fixture не заменён
  shifted/synthetic dataset и operational docs не пройдут отдельный disclosure review.
- Имя в UI — «Cometa» (`src/app/config.ts`). «Kaspy» не использовать в UI: риск Kaspi Bank +
  скам-паттерн FEMITBOT (spec.md §7). Демо-водяной знак и disclaimer не удалять.

## Task Board

Tasks in `BOARD.md`. Format: pantheon. Prefix: KBT.
