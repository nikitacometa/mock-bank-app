# Cometa (kaspy-bank-telegram)

Минималистичный mock-необанк уровня «премиальный прод 2026»: fresh fixture начинает с четырёх
demo-счетов, поддерживает восемь валют, настраиваемую основную валюту, накопительный счёт с
процентом, live reference rates, историю, мок-карты, переводы, ручные и recurring операции.
Обычный web хранит mock-ledger локально. Local Telegram candidate реализует server-authoritative
mock-ledger отдельно для каждого canonical Telegram ID; live release остаётся device-local до
двухрелизного bridge и explicit one-way switch. Это всё ещё вымышленное демо без реальных денег и
payment rails.
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
  проекцию двенадцати `BankState`-полей: неизвестные persisted keys не могут заменить actions/status.
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
- **Ручные и recurring операции**: income/expense и monthly rules доступны только active checking
  accounts; expense и весь historical backfill не могут увести счёт ниже нуля. Monthly anchor
  выбирается как UTC year/month/day, backfill ограничен 120 строками и применяется атомарно.
  Savings допускает только current balance adjustment после settlement; adjustment всегда новая
  ledger row, а не поле на account.
- **Canonical import and rates**: strict import rejects future immutable timestamps, recurrence
  outside its UTC window, invalid role/type/base-currency mapping and duplicate active checking
  currencies. Parser строит exact deep projection всех nested state-объектов до hash/storage;
  неизвестные nested keys не входят в canonical state. Server FX parsing caps decoded responses at 256 KiB/64 rows, shares a 12-hour cache
  plus 30-second failure cooldown, and charges every `/bank-rates` request against a dedicated
  non-replayable budget. Command/import rate-limit bypass is allowed only for an exact operation
  already persisted in SQLite; invalid, conflicting and crash-before-commit retries are charged
  again. A committed domain failure is a stored replay outcome and keeps the exemption.
  Authenticated bootstrap имеет отдельный per-ID лимит 30/min после HMAC validation, но до любого
  SQLite lookup; replay exemption для него запрещён.
- **Account lifecycle**: удаление означает reversible close при нулевом balance. История остаётся;
  связанные rules pause, cards freeze, restore возвращает только автоматически остановленные
  сущности. Fresh fixture имеет четыре role-account, после чего пользователь может add/close/restore.
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
- Web-storage и TMA-storage изолированы — состояние демо НЕ переносится, это ожидаемо. В TMA cached
  bank snapshot, locale и receipts лежат в отдельных namespace по canonical Telegram ID. До HMAC-verified bootstrap
  используется только ephemeral quarantine: unknown/malformed host identity не читает и не пишет
  чужой snapshot. `storage` events принимаются только из активного namespace; failed same-ID write
  остаётся in-memory authoritative до успешного retry.
- Смена fingerprint raw Telegram launch session открывает новый identity epoch до чтения возможно
  stale parsed SDK user. Старые in-flight sync результаты не выпускают namespace из quarantine.
  Обычный same-user foreground sync не вызывает `resetUi()`: canonical adoption сохраняет валидные
  screen/sheet/draft/toasts, но закрывает stale account/card/transfer target. Namespace switch
  остаётся полной transient-UI boundary.
- Raw `initData` валидирует только bot backend через Telegram HMAC и freshness bound. Frontend
  применяет только versioned bootstrap response с canonical `telegramId`, locale, currency,
  display name, monotonic revision и lowercase 128-bit `revisionEpoch`. Receipt v2 привязан к
  Telegram user + epoch + BankState schema; новый DB epoch имеет приоритет даже при меньшем
  revision. Смена Telegram account сначала изолирует UI, затем восстанавливает собственный snapshot
  или reseed'ит собственный mock ledger после server verification.
- После one-time create-if-absent import Telegram mock-ledger authoritative в SQLite. Bot и TMA
  отправляют typed idempotent commands; canonical server materializer всегда выполняет
  `applySettleAll` до recurring rules под repository lock, валидирует полный
  next state до commit и возвращает digest + monotonic revision. Sticky authority marker запрещает
  local-write fallback. Первый импортированный device snapshot становится canonical; отличающаяся
  локальная копия второго device требует явного `Use server copy`. Bootstrap и bot chat reads идут
  через тот же materializer; повтор в один UTC-день не дублирует строки и не повышает revision.
- Bot backend хранит Telegram/private-chat ID, locale, display name, onboarding state, server bank
  snapshot, operation/outbox records и durable conversation draft отдельно для каждого пользователя.
  Следующий wizard session и его `conversation_replies` receipt пишутся одной SQLite transaction;
  delivery status и `update_processed` завершаются независимо, а retention покрывает оба crash order.
  `/privacy` раскрывает эту границу на RU/EN. Секреты и raw initData не пишутся в SQLite/logs.
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
  `20260902T233104Z` is automatic previous; D→C→D rollback rehearsal passed before the host edge
  changed. Live source copies C/D were later manually patched to loopback ports and therefore are
  rollback-compatible but not source-clean. Caddy `2.11.4` is now the sole enabled public TLS owner
  on TCP `80/443`; Docker web binds only `127.0.0.1:8080/8443`, and Caddy temporarily proxies the
  complete Nginx HTTPS policy on `8443`. Read-only audit found the installed bridge still using a
  target TLS bypass/default HTTP/3, the legacy TCP Caddy admin endpoint and Nginx without trusted
  real-IP recovery. Docker still runs without the versioned daemon config. None of the current
  candidate infrastructure has been applied to production.
  The legacy Certbot timer is disabled/inactive and its service is static/inactive. Do not re-enable
  either unit. Legacy Hostinger remains the TLS-valid external
  rollback origin until Android/iOS acceptance. System, Cloudflare, Google and Quad9 resolvers
  converge on Irena. The first Irena vhost deliberately omits HSTS.
- Release lifecycle идёт только через `deploy/standalone/scripts/release.sh`; one-time Docker
  daemon perimeter ставится отдельным `deploy/standalone/scripts/install-docker-perimeter.sh`:
  immutable image-ID
  manifest, serialized deploy lock, health stability window и atomic `current`/`previous`. Active
  lifecycle commands require valid Caddy semantics, Caddy-owned public listeners, exact loopback
  Compose/runtime bindings and bridge-network attachments, exact trusted real-IP directives,
  TCP-only `h1/h2` and quiesced legacy
  renewal units. Inner `8443` uses normal chain/hostname verification plus a 21-day expiry floor;
  outer `443` is a separate gate. Active flows never issue certificates or install/enable the old renewal bundle;
  Caddy owns public ACME. Docker Engine 28+ and `jq` are explicit host dependencies. Runtime uses the
  exact `cometa-bank` project, attached primary networks and an allow-listed bridge option set. Bot
  never publishes a host port. Before any release lifecycle action, the one-time
  `install-docker-perimeter.sh` dry-run/apply must install the exact three-key
  `/etc/docker/daemon.json`, keep only systemd socket activation through `-H fd://`, pin the local
  Unix-socket CLI context and complete its controlled Docker restart under a root-only durable
  recovery journal. Exact `.pending.next`/`daemon.json.cometa-bank.next` candidates are recoverable
  only when their owner, mode and shape are unambiguous; any mixed or unknown state fails closed.
  Do not replace `/etc/caddy/Caddyfile` merely for byte parity: validate its scoped `euphoria.bot`
  routes because the host may serve unrelated domains.
- The first compatible release cycle is controlled: package/prepare two identical-source releases
  A and B; from extracted A run `install-docker-perimeter.sh` dry-run/apply, then target-scoped
  `harden-edge` dry-run/apply, strict-preflight both, prepare both before activating A, then activate
  them consecutively while ledger mode remains `local`. Docker installation requires Engine 28+
  and intentionally restarts only `docker.service`. Edge hardening applies host-wide `h1/h2`,
  authenticates inner TLS, moves Caddy admin from loopback TCP to a caddy-owned Unix socket with
  mode `0200`, disables persisted autosave and reloads through the endpoint that is currently live.
  Edge mutation keeps durable root-only, hash-bound recovery snapshots and globally blocks other
  lifecycle actions while its marker exists. Activation and rollback flush a link intent before the
  two symlink writes, fsync between writes and reconcile only the three valid interrupted states.
  Retry preflight permits a missing web/bot runtime only after source and any existing containers or
  named networks pass the exact perimeter; strict cardinality, image, health and TLS checks run after repair.
  Pending edge-hardening recovery permits only web absence and requires a healthy immutable bot before
  host mutation. Rollback intent is consumable only by its original-current release script.
  Until B succeeds, use A's immutable `releases/<A>/.../release.sh` as the canonical operator if a
  fallback restores legacy D; never run legacy D/C lifecycle commands. Once B is current and A is
  previous, both rollback targets are source-clean. Removing inner Nginx TLS, the Certbot volume and
  dead legacy renewal code is a later milestone, not part of this bridge.
- Server ledger включается только после двух authority-capable releases через guarded
  `release.sh ledger-mode server --apply`. Переход односторонний; после него activate/rollback на
  pre-authority image запрещён. `/app/<release-id>/` — rollback-safe cache-key alias на current web
  image; доказательством build служит compiled client-contract marker, а не текст URL. Если final
  audit flush упал уже после switch, повторный `server --apply` пишет durable reconciliation event и
  повторяет health gates без ledger mutation. Пока mode `local`, setup и `/help` публикуют только
  `start/settings/help/privacy`. После durable final event operator restart'ит current bot, startup
  публикует server command profiles, затем обязательны 31 секунд stable health и TLS/API smoke;
  reconciliation повторяет restart и gates. Authority candidate пока не deployed и live DB не
  переключён. Hostinger остаётся только static/TLS fallback и не
  может быть Telegram ledger authority. Encrypted offsite backup/restore drill отложен; локальные
  root-only SQLite backups не являются защитой от потери VPS.
- Bot token принимается только через hidden TTY prompt и service-owned file boundary; token запрещён
  в `.env`, argv, shell history, docs и chat. Owner-authorized exposed token сейчас допускается только
  для test acceptance и обязан быть revoke/rotate до любого public/non-test use; не считать это
  прецедентом для следующих credentials.
- Public GitHub remote: `git@github.com:nikitacometa/mock-bank-app.git`; `main` отслеживает
  `origin/main`. Owner-KZT fixture остаётся fingerprintable несмотря на удалённые PII; этот риск
  обязан быть явно описан и не позволяет называть dataset анонимным.
- Имя в UI — «Cometa» (`src/app/config.ts`). «Kaspy» не использовать в UI: риск Kaspi Bank +
  скам-паттерн FEMITBOT (spec.md §7). Демо-водяной знак и disclaimer не удалять.

## Task Board

Tasks in `BOARD.md`. Format: pantheon. Prefix: KBT.
