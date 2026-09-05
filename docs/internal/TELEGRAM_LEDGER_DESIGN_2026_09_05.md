# Telegram ledger and currency templates — анализ и план

Дата: 2026-09-05. Статус: Gate 1 approved владельцем; implementation in progress.

## TL;DR

Выбран режим **multi-user demo**: в Telegram сервер становится authoritative для mock-ledger
конкретного Telegram ID, а обычный web-demo остаётся локальным. Это единственный вариант, при
котором добавленная в chat операция, recurring rule и account correction одинаково видны после
перезапуска и не протекают другому пользователю. Баланс по-прежнему выводится только из ledger;
«исправить сумму» означает добавить adjustment row, а «удалить счёт» — безопасно закрыть его без
удаления истории. Fresh demo строится для любой из восьми primary currencies из одной USD-value
модели; KZT сохраняет текущий 436→437 lifecycle, остальные получают эквивалентные суммы и
country-specific merchants. Telegram UX состоит из короткого dashboard и двух wizard flows:
transaction/recurrence и accounts. Rollout требует additive SQLite extension, backward-compatible
signed bootstrap extension, one-time import текущего TMA v4 snapshot, sticky server-mode cutover,
real two-profile acceptance и новый README-row из трёх Telegram
screenshots.

## 1. Что строим и зачем

Нужны три связанные возможности:

1. Восемь deterministic demo templates: KZT, THB, VND, RUB, USD, EUR, IDR и GEL. Их итоговая
   стоимость и каждая базовая операция совпадают по USD-value с KZT-эталоном в пределах округления
   валюты, но merchants и подписи выглядят локально правдоподобно.
2. В Telegram chat пользователь добавляет income/expense на выбранный счёт, указывает
   counterparty, optional note, дату и optional monthly recurrence. Данные появляются в Mini App.
3. В Telegram chat пользователь видит счета, добавляет новый currency account, корректирует его
   баланс и закрывает/восстанавливает счёт без разрушения ledger history.

Это остаётся mock-продуктом: команды записывают fictional ledger entries и ничего не платят.

### UX-направление

Тон: refined, calm, Telegram-native. Один экран сообщения — одно решение; ввод раскрывается
постепенно. Ни длинных форм, ни reply-keyboard, ни потока из одинаковых «карточек».

Завершённый `/start` становится dashboard:

```text
Cometa · Никита
≈ $24,021 · 4 active accounts
Next: Spotify · Sep 19

[ Open Cometa ]
[ + Add transaction ] [ Accounts ]
[ Recurring ]         [ Settings ]
```

Transaction wizard:

```text
Expense / Income
→ Account
→ Amount in that account's currency
→ Merchant or sender
→ Optional note
→ Once: Today / Yesterday / YYYY-MM-DD
→ Monthly: start year → month → billing day, including historical backfill
→ Exact review and explicit “Add expense/income”
```

Account manager:

```text
Accounts → account detail → Adjust balance / Close account
         → Add account → currency → zero-balance account
         → Closed accounts → Restore
```

Кнопки callbacks содержат короткий opaque flow/account ID и всегда укладываются в Telegram
64-byte limit. Любой wizard можно отменить; `/start`, `/add`, `/accounts`, `/recurring` начинают
новый flow и заменяют старый draft. Draft переживает restart и истекает через 24 часа.

## 2. Готовность кода

### Что уже переиспользуем

- `Account`, `Transaction` и `BankState` определены централизованно
  (`src/domain/types.ts:22`, `src/domain/types.ts:64`, `src/domain/types.ts:114`).
- `balanceOf()` и `appendRow()` уже закрепляют ledger-derived balance и safe integer arithmetic
  (`src/domain/ledger.ts:8`, `src/domain/ledger.ts:24`).
- Все browser mutations идут через lock/rebase/commit (`src/store/bankStore.ts:163`,
  `src/store/bankStore.ts:182`).
- Persistence имеет строгую exact projection, referential checks и ledger validation
  (`src/store/persistence.ts:471`), но сейчас schema version равна 4
  (`src/store/persistence.ts:37`).
- TMA bootstrap уже HMAC-проверяет canonical Telegram ID, но возвращает только preferences
  (`bot/http-server.ts:126`, `bot/http-server.ts:155`; `src/platform/types.ts:26`).
- Bot engine уже имеет RU/EN callbacks, commands, persistent preferences и retry-safe custom-name
  outbox (`bot/onboarding.ts:92`, `bot/onboarding.ts:344`, `bot/repository.ts:277`).
- Poller ретраит handler до `markProcessed`, поэтому новый financial mutation обязан иметь
  собственный idempotency key (`bot/poller.ts:126`, `bot/poller.ts:146`).
- Current seed централизован в `buildSeed()` (`src/domain/seed.ts:261`), но accounts и amounts
  жёстко KZT (`src/domain/seed.ts:273`).

### Что меняется

- Browser `BankState` schema 4 → 5 с explicit v4→v5 migration без reseed.
- Telegram trust boundary расширяется: SQLite хранит mock bank snapshot, recurring rules,
  conversation drafts и typed outbox отдельно для каждого canonical Telegram ID.
- Existing per-ID TMA v4 snapshots проходят authenticated create-if-absent import; сервер не
  подменяет их fresh seed.
- Bot build должен переиспользовать pure domain code. Для этого Node bundle собирается отдельным
  Vite SSR config; browser и bot больше не дублируют money/ledger transitions.
- Bootstrap сохраняет top-level contract version 1 и additive возвращает authoritative bank
  snapshot + bank revision. Это оставляет старый cached client и rollback image совместимыми.
- TMA mutations отправляются как signed typed commands; web adapter продолжает выполнять те же
  transitions локально.
- После successful import клиент записывает irreversible `ledgerMode=server` marker. Отсутствие
  bank API после этого означает read-only upgrade screen, а не client-only fallback.
- Privacy/disclaimer/README перестают утверждать, что TMA ledger живёт только на устройстве.

### Baseline-находка

На 2026-09-05 полный `pnpm verify` обнаружил time-sensitive test fixture: live-cache test менял
`fetchedAt`, но оставлял `asOf=2026-08-28`, поэтому после семидневной границы snapshot закономерно
стал stale. Fixture исправлен так, чтобы `asOf` и `fetchedAt` описывали один текущий snapshot;
focused test зелёный. Product logic не менялась.

## 3. Варианты — сравнение

| Вариант | Механизм | Плюсы | Риски/стоимость | Вердикт |
|---|---|---|---|---|
| A. Bot command overlay | Bot хранит только новые events, client накладывает их на local seed | Самый маленький diff | Bot и Mini App расходятся после client transfer; account balance зависит от устройства; conflict semantics неразрешимы | Отклонён |
| B. Server-authoritative `BankState` + typed commands | SQLite snapshot per Telegram ID; server применяет общие pure transitions; bootstrap возвращает state | Один ledger для chat и TMA, atomic recurrence, точная isolation, простая backup/restore | Меняется trust boundary и build; нужен schema/API migration | **Выбран** |
| C. Полностью normalized SQL ledger | Accounts/transactions/rules отдельными relational tables | Лучший query/audit фундамент | Дублирует client domain, много migration/query surface для маленького demo | Отклонён до реального backend-продукта |
| D. Forms только внутри Mini App | Bot лишь открывает deep-linked sheet | Не нужен server ledger | Не выполняет запрос на Telegram-chat UX и не даёт screenshots bot management | Отклонён |

## 4. Архитектура

### 4.1 Domain model

```ts
interface Account {
  // existing fields
  role: 'primary-checking' | 'primary-savings' | 'companion-1' | 'companion-2' | 'custom';
  status: 'active' | 'closed';
  closedAt?: string;
}

interface Card {
  // existing fields
  freezeReason?: 'manual' | 'account_closed';
}

type TransactionKind =
  | ExistingKinds
  | 'manual_income'
  | 'manual_expense'
  | 'balance_adjustment';

interface Transaction {
  // existing fields
  note?: string;                 // NFC, 0..120 code points, no control/bidi chars
  effectiveDate?: string;        // YYYY-MM-DD; append order stays in seq/createdAt
  recurringRuleId?: string;
  occurrenceKey?: string;        // `${ruleId}:${YYYY-MM}`, unique in one BankState
}

interface RecurringRule {
  id: string;
  accountId: string;
  direction: 'income' | 'expense';
  amountMinor: Money;            // positive magnitude
  counterparty: string;
  note?: string;
  category: string;
  cadence: 'monthly';
  anchorDay: number;             // original 1..31, never drifts after February
  startsOn: string;
  nextOccurrence: string;
  status: 'active' | 'paused';
  pauseReason?: 'manual' | 'account_closed' | 'capacity' | 'overflow' | 'insufficient_funds';
  createdAt: string;
}

interface BankState {
  // existing fields
  demoBaseCurrency: Currency;     // fixture identity; not the reporting preference
  fixtureId: DemoFixtureId;       // versioned identity of the generated dataset
  recurringRules: RecurringRule[];
}
```

`effectiveDate` controls History grouping, while `createdAt` remains the immutable append instant.
Backdated insertion therefore never rewrites earlier `balanceAfterMinor` snapshots. History sorts by
effective date, then `seq`; ledger integrity sorts only by `seq`.

Manual and recurring expenses may never take an account below zero. The complete command, including
a requested historical backfill, preflights every chronological prefix and fails atomically with the
available and required amount if any row would overdraw. Transfers retain the existing
insufficient-funds rule. Balance correction accepts a target `>= 0`; it appends exactly
`target - balanceOf(account)` and never mutates prior rows. Equal target is a successful no-op.

Version 1 records manual and recurring income/expense only on active `checking` accounts. A savings
balance correction is allowed only at server `now`: pending interest settles first, then the
adjustment row is appended. Backdated savings activity is rejected because the current interest
model accrues the whole unsettled period against one principal; pretending otherwise would silently
misstate interest. Chronological time-sliced accrual is deferred.

Monthly recurrence uses UTC calendar dates because Telegram exposes no trustworthy user timezone.
The wizard explicitly selects start year, start month and billing day. It previews the number and
total of historical rows from that month through today before confirmation; at most 120 occurrences
may be created. The initial backfill and rule creation are one atomic command. Day 29–31 clamps to
month end without changing `anchorDay`; March returns to the original day. The first occurrence after
today becomes `nextOccurrence`. Replaying the same command or later materialization produces no
duplicate because every occurrence has a stable `${ruleId}:${YYYY-MM}` key and the cursor advances in
the same transition.

Materialization preflights capacity, safe integers and expense balance before append. One invalid
rule is atomically paused with `capacity`, `overflow` or `insufficient_funds`; no partial month batch
is written, other rules continue, and bootstrap returns the last valid snapshot plus a typed warning.
Reaching a limit can never prevent opening `/recurring` or the confirmed demo reset needed to recover.

Money enters the domain only as a string through the shared `parseAmountInput()` contract. RU accepts
an ungrouped comma decimal, EN accepts an ungrouped dot or valid comma thousands; both reject signs,
exponents, ambiguous separators, zero and excess precision. VND accepts whole dong; IDR also accepts
whole visible rupiah and converts it to an internal amount divisible by 100 minor units. The backend
reparses the raw string instead of trusting a client-produced number and applies a documented
per-command USD-equivalent ceiling before the safe-integer ceiling.

The backend owns `createdAt`. User input supplies only an exact Gregorian `effectiveDate`, from ten
years ago through server today in UTC; future one-off rows are rejected. Bot buttons offer Today,
Yesterday and Enter date, with a currency- and locale-specific amount example on the same step.

### 4.2 Account lifecycle

- New accounts are `checking`, start at zero through one `seed` row and use a generated mock
  number. Custom savings/APY creation is deliberately deferred.
- Closing is a reversible archive, not deletion. It requires zero balance and at least one other
  active account; active linked recurring rules pause with `account_closed` and active cards freeze
  with the same reason. Ledger and account remain referentially valid. Restore reverses only those
  automatic reasons; a manually paused rule or manually frozen card stays that way.
- Closed accounts disappear from Home, Transfer and active Cards, remain available under
  `Closed accounts`, and can be restored.
- `uiStore` is not server state. After canonical state adoption, the client closes any invalid sheet
  and selects the first active account before releasing its synchronization gate; no server
  transition claims to mutate `activeAccountId` atomically.
- Own transfer is unavailable with fewer than two active accounts.

### 4.3 Currency templates

`buildSeed(nowISO, demoBaseCurrency = 'KZT')` generates four accounts:

- current + savings in `demoBaseCurrency`;
- two travel/reserve currencies selected deterministically; KZT keeps USD + EUR exactly;
- USD/EUR templates avoid duplicate currency accounts by filling with KZT.

The current `owner-kzt-v1` fixture remains byte-for-byte in amounts and ordering: `buildSeed()`
yields its existing 436 rows at the frozen data cutoff, and the existing initial interest settlement
brings the live baseline to 437. Seven public synthetic fixtures do **not** mechanically convert the
fingerprintable owner statement. They share a separate canonical schedule of integer USD cents,
semantic categories and date cadence, then choose a merchant from the relevant market profile and
convert each event through pinned `SEED_RATES_V1` using integer/BigInt helpers. Opening balances are
calibrated after the schedule is built so every account role reaches the same USD target. Every
projected amount is replayed into a running ledger; `balanceAfterMinor` is never converted
independently.

New synthetic fixtures use `effectiveDate` for the local banking date and deterministic UTC-noon
`createdAt` timestamps. They never call the current device timezone. The existing KZT fixture keeps
its current timestamps during v4→v5 migration; fresh KZT construction is frozen by fixture version.
This makes the same `fixtureId` byte-stable on Bangkok, Berlin and Telegram server hosts.

Acceptance tolerances:

- exactly 436 pre-settlement rows and four accounts for every template; exactly 437 rows after the
  initial current-date settlement at the acceptance clock;
- final portfolio is calibrated to the pinned KZT baseline of USD 24,021.28; each role and the total
  differ by at most USD 0.01 under `SEED_RATES_V1`;
- each synthetic transaction differs from its canonical USD magnitude by at most one visible minor
  unit of the target currency after the market denomination step;
- no unsafe integer, orphan, duplicate ID or invalid FX snapshot.

For non-KZT templates, a deterministic category/merchant catalog uses synthetic dates and amounts;
the owner statement is neither copied nor reversibly converted. Examples:

| Currency | Merchant texture |
|---|---|
| KZT | Magnum, Coffee Boom, Qazaq Oil, Yandex Go |
| THB | 7-Eleven, Grab, LINE MAN, Café Amazon, BTS/Rabbit |
| VND | Highlands Coffee, WinMart, Grab, ShopeeFood, Be |
| RUB | Пятёрочка, Самокат, ВкусВилл, Ozon, Яндекс Go |
| USD | Trader Joe's, Whole Foods, Uber, DoorDash, Apple |
| EUR | Lidl, Carrefour, Wolt, Bolt, Deutsche Bahn |
| IDR | Gojek, GoPay, Tokopedia, Indomaret, Alfamart |
| GEL | Wolt, Bolt, SPAR, Carrefour, Magniti, Magti |

The catalog was cross-checked against current merchant surfaces, including
[Magnum](https://www.magnum.kz/), [Yandex Go](https://go.yandex/ru_ru),
[Highlands Coffee](https://www.highlandscoffee.com.vn/),
[Gojek](https://www.gojek.com/id-id/merchant), and
[Wolt Georgia](https://wolt.com/en/geo). It is a design fixture, not market-share research.

`primaryCurrency` remains display-only. `demoBaseCurrency` plus `fixtureId` record which template
produced the ledger, so selecting another reporting currency never destroys or silently converts
existing data.
A chosen onboarding currency supplies `demoBaseCurrency` only before the first bank snapshot. In web
demo, an explicit “Rebuild demo in {currency}” action is the only way to replace the template; the
destructive choice names the currency and remains user-initiated.

### 4.4 Telegram server storage

Additive SQLite tables are created while `PRAGMA user_version` stays at 2 for one bridge release.
The old image ignores them and still opens a migrated DB copy, preserving the existing
candidate→fallback activation gate.

```text
bank_states
  telegram_user_id PK/FK users
  state_json NULLABLE, status, revision, updated_at

conversation_sessions
  telegram_user_id PK/FK users
  flow_id, flow_kind, step, draft_json, expires_at, updated_at

bank_operations
  id INTEGER PK
  telegram_user_id FK users, source_kind, operation_id, command_hash
  operation_kind, outcome_json, bank_revision, created_at
  UNIQUE(telegram_user_id, source_kind, operation_id)

bank_outbox
  bank_operation_id UNIQUE/FK bank_operations
  telegram_user_id, chat_id, message_kind, payload_json, created_at
```

Every bot confirmation executes `BEGIN IMMEDIATE`: load latest state → materialize due rules →
apply pure command → validate complete state → update snapshot and monotonic revision → insert the
typed operation → queue typed reply → commit. Telegram uses its update ID; TMA uses
`clientMutationId`. The same key and canonical command hash replays the stored outcome; the same key
with another payload returns `409 idempotency_conflict`. A retry only redelivers its outbox. No
message failure can duplicate money.

State limits: at most 24 accounts, 5,000 transactions, 64 recurring rules, bounded text fields and
safe integer money. Limit errors are typed and leave management/reset routes available. Every JSON
read crosses the same strict validator as browser persistence and must match the authenticated
Telegram ID.

Nginx and the app enforce separate byte ceilings for import and commands, JSON depth/field
allow-lists, Telegram init-data freshness, and bounded per-user plus coarse per-IP request budgets.
Rate-limit rejection happens before SQLite write work and returns a retry hint; the Bot polling path
uses the same per-user command budget without treating legitimate Telegram retries as new mutations.

### 4.5 Signed API and TMA synchronization

```ts
POST /api/tma/bootstrap {}
→ {
    version: 1,                    // existing top-level projection stays compatible
    revisionEpoch, revision, locale, primaryCurrency, displayName, telegramId,
    onboardingComplete,
    bank?:
      | { contractVersion: 1, mode: 'import_required' }
      | { contractVersion: 1, mode: 'server', revisionEpoch, revision, state, warnings }
  }

POST /api/tma/bank-import
Authorization: tma <raw init data>
{ version: 1, importId: string, stateVersion: 4 | 5, state: unknown }
→ { version: 1, mode: 'server', revisionEpoch, revision, imported, state, warnings }

POST /api/tma/bank-command
Authorization: tma <raw init data>
{
  version: 1,
  clientMutationId: string,       // lowercase 128-bit, retry key
  command: BankCommand
}
→ { version: 1, applied, revisionEpoch, revision, state, warnings }
```

The backend derives Telegram ID and all timestamps; caller cannot address another user. Commands
apply to the latest server state inside one SQLite transaction, so two devices do not use
last-write-wins snapshots. Import strictly validates v4, requires `profile.telegramId` to equal the
authenticated canonical ID, migrates server-side to v5, and succeeds only while `bank_states` is
absent. The first authenticated device becomes canonical. A later device with a different local
digest is never auto-uploaded or silently merged; it receives a conflict/export screen and must
explicitly adopt the server copy.

The bootstrap extension remains additive only during the bridge release. After import, the client
persists `ledgerMode=server`; from then on, missing/unsupported bank responses show a read-only
upgrade/retry screen and can never reactivate local mutations. The Telegram adapter owns raw init
data and exposes `loadLaunchState()` / `importBankState()` / `executeBankCommand()` through the
platform contract. `bankStore` applies transitions locally on web and delegates the same typed
command on TMA, then persists the canonical response in that user's local namespace. Network
failure fails closed with a recoverable error; it never leaves a local-only mutation that the bot
cannot see.

All bank responses pass through one client adoption queue and the existing persistence lock. For
the same `revisionEpoch`, only a greater bank revision may replace state; equal revision requires an
equal digest. On a new epoch, the previous epoch enters a persisted retired-epoch ring, so a delayed
response from the old database generation cannot come back. Rebuild and `/delete_demo` increment the
existing row revision instead of resetting it. A manual SQLite restore must rotate the global
`revisionEpoch`, as it already does for preferences.

Bootstrap materializes due recurring rules before returning state. Foreground/pageshow re-sync uses
the existing bootstrap ladder; no background timer promises exact wall-clock execution while the app
is closed.

### 4.6 Migration, rollback and recovery

Authority is enabled in two releases, never in the first binary that understands it:

1. Deploy bridge A with import/API/schema support but `ledgerMode=local`; no user state moves.
2. Reopen both owner Telegram profiles on bridge A and verify its persisted client-contract marker.
   Version the Bot menu URL so new launches cannot reuse the old entry document.
3. Deploy the same authority-capable binary as bridge B, making bridge A the tested rollback target.
4. Atomically switch the DB service flag to `server`; clients import once, then store the sticky
   marker. A rollback B→A continues serving the same server ledger. Pre-bridge images refuse a DB
   whose service flag is `server`.
5. Prove server mutation → rollback → second mutation → roll-forward with one unchanged ledger and
   no duplicate operation before enabling chat shortcuts for everyone.

An already-open pre-bridge offline WebView cannot be remotely rewritten. For this test deployment,
activation therefore requires both known profiles to close/reopen after the versioned URL switch;
that residual migration boundary is documented rather than disguised as protocol safety.

The existing WAL-safe local pre-release backup and rollback checks remain mandatory. Encrypted
scheduled offsite backup, retention monitoring and a restore drill are explicitly deferred to the
next infrastructure milestone by owner decision; this demo release must leave a tracked follow-up
and must not claim disaster recovery it does not yet have.

### 4.7 UX copy and privacy

New bot copy is fully RU/EN. Visible labels describe recording, not payment:

- RU: `Записать расход`, `Записать поступление`, `Повторять ежемесячно`.
- EN: `Record expense`, `Record income`, `Repeat monthly`.

Errors name the fix: amount format with a currency example, expired flow with restart action, closed
account with restore action. Confirmation names direction, account, amount, counterparty, note, date
and recurrence; button is `Добавить расход`/`Add expense`, never `OK`.

`/privacy`, app disclaimer, README and handoff will say that Telegram mode stores fictional
accounts, ledger entries and recurrence rules on the Cometa server per Telegram ID. Web-only state
continues to remain on the device. Data deletion/export are not silently implied. After explicit
confirmation, `/delete_demo` removes that user's snapshot, drafts, outcomes and outbox, while
retaining only a minimal revision tombstone so stale responses cannot resurrect the ledger.
Telegram identity/preferences retention remains described until a broader account-deletion flow
exists.

## 5. Что НЕ делаем

- Не подключаем реальные bank/payment APIs, KYC, cards, webhooks или money movement.
- Не нормализуем 437 rows в SQL; snapshot + strict typed commands достаточно для demo scale.
- Не добавляем weekly/custom recurrence, timezone setup, split transactions или category editor.
- Не создаём custom savings/APY через bot в первой версии; новый account всегда checking.
- Не удаляем исторические rows и accounts физически.
- Не обещаем background execution по минутам: due rows появляются при bootstrap или bot activity.
- Не синхронизируем anonymous web users на сервер и не смешиваем web/TMA namespaces.
- Не генерируем fake Telegram chrome для acceptance; README assets строятся из проверенной copy и
  реальных captures, затем очищаются от profile/device metadata.
- Не считаем public-repo privacy решённой: `owner-kzt-v1` по-прежнему fingerprintable. Он остаётся
  только по явному решению владельца; synthetic templates не копируют его, а README не публикует
  raw statement details или infrastructure secrets.
- Не запускаем второй long-polling bot с тем же token для staging. До cutover все UX/transport
  проверки локальные; real screenshots снимаются только после единственного live activation.

## 6. Майлстоуны

| Milestone | Scope | Definition of Done | Проверка | Deploy gate | Статус |
|---|---|---|---|---|---|
| M0 — baseline + design | Time-safe rate fixture, code audit, design and adversarial revision | Full baseline green; revised plan approved | `pnpm verify`, `git diff --check` | Нет | done |
| M1 — domain v5 + templates | Account/card lifecycle reasons, `demoBaseCurrency`, `fixtureId`, manual/adjustment transitions, safe recurring materializer, v4→v5 migration, eight seeds | KZT 436→437 lifecycle preserved; synthetic fixtures do not encode statement rows; pinned parity holds; savings/date/capacity contracts hold | Domain/persistence tests, named mutants, full verify | Нет | todo |
| M2 — authority core | Shared bot bundle, additive SQLite tables, strict import, hashed idempotency, monotonic epoch/revision, signed bank API | Create-if-absent import preserves v4; atomic per-user commands; retry/collision/limit/restore cases typed; old DB opens | Repository/HTTP tests, migration/fallback harness, Opus money/concurrency review | Images only, service flag local | todo |
| M3 — TMA sync | Platform command seam, sticky server receipt, ordered canonical adoption, foreground sync, web remains local | No local fallback after authority; stale response rejected; two IDs isolated; conflicting second-device import fails closed | Store/adapter tests, two-context Playwright TMA emulation, mutants | Local only | todo |
| M4 — transaction + recurrence bot UX | `/add`, `/recurring`, durable wizard, year/month/day backfill, typed outbox, RU/EN copy | Checking income/expense/date/monthly/backfill/pause/resume/cancel work across restart and retry; expense never overdraws or partially backfills | Bot behavior tests, parser/balance boundaries, stale/foreign callbacks, two-user tests | Local only | todo |
| M5 — accounts bot UX | `/accounts`, add, adjust, close/restore, client UI reconciliation | Zero-balance close invariant, history retained, manual freeze/pause preserved, savings settles before current adjustment | Domain/bot/UI tests, one-account and closed states, Opus focused review | Local only | todo |
| M6 — product polish | History effective dates/notes, warnings/recovery states, currency precision and responsive QA | RU/EN readable at 320×568/390×844; no blocked bootstrap at capacity; full local journeys pass | Playwright, accessibility/overflow, `pnpm verify`, final paired review | Local only | todo |
| M7 — bridge release | Bridge A/B releases with authority flag local; retain current local backup/rollback safety | Current and previous images are both authority-capable; pre-bridge image refuses server-mode DB | Public smoke, local-mode rollback, existing SQLite backup guards | Two bridge activations; no ledger import | todo |
| M8 — live acceptance + showcase | Switch service flag, import both owner profiles, feature B→bridge A→feature B mutation probe, RU/KZT and EN/GEL chat journeys, three real captures | A/B ledgers differ and survive restart/rollback; web demo unaffected; README has exactly three equal sanitized Telegram images in one row | `pnpm verify`, live API/TLS, Telegram Old Computer Use, owner Android/iOS gate, screenshot guard | Activate only after all prior gates green | todo |

Sensitive milestones M1–M5 receive an independent money/concurrency review immediately after focused
tests. Final diff receives Codex review plus read-only Claude Opus 5 xhigh; every concrete finding is
reproduced or rejected with a probe before release. README captures are dashboard, transaction
review and account manager, all from the live bot after M8 activation; one centered row uses three
equal 390×844 assets at 31% width.

## 7. Открытые вопросы

Реализацию можно начать с выбранных defaults, но эти product semantics должны быть явными:

1. **Template switching:** выбран default «onboarding currency initializes `demoBaseCurrency` only
   before the first snapshot; later primary-currency changes affect reporting only». Альтернатива —
   destructive reseed on every currency change; она отклонена из-за потери user-created data.
2. **Expense overdraft:** approved default — manual, backfilled and due recurring expenses are
   rejected atomically before balance becomes negative; the error names available and required sum.
3. **Account removal:** выбран reversible close only at zero balance. Hard delete отклонён из-за
   orphan history/cards.
4. **Timezone and backfill:** approved UTC semantics. Monthly setup chooses start year, month and
   billing day, previews up to 120 historical occurrences, then writes the batch atomically.
5. **Savings:** transaction/recurrence wizard показывает только checking accounts; savings можно
   корректировать текущим adjustment после settlement, но нельзя backdate.
6. **Existing TMA state:** первый прошедший strict import device становится canonical; другой
   отличающийся local snapshot не перезаписывает сервер автоматически.
7. **Recovery:** owner deferred encrypted offsite backup/restore to the next task. Existing local
   release backup remains; README/handoff must describe the residual single-VPS loss risk.

## 8. Ревизия 2026-09-05

Fresh-eyes audit отклонил первую редакцию: она допускала client-only fallback после authority,
теряла существующий per-user v4 snapshot при первом server bootstrap, не защищала bank state от
out-of-order responses, не связывала TMA idempotency key с payload, разрешала несовместимый backdate
на savings, могла brick'нуть bootstrap переполненной recurrence и не имела offsite recovery gate.

Revision 2 добавляет strict create-if-absent import, sticky `ledgerMode=server`, bridge A/B cutover,
epoch/revision adoption queue, scoped operation key + command hash, checking-only recurring entries,
capacity/overflow auto-pause и encrypted offsite restore milestone. Дополнительно исправлены
`uiStore` ownership, manual-vs-account freeze reasons, locale money/date parsing и порядок live
captures. Повторный adversarial review подтвердил, что все 10 исходных findings закрыты на уровне
дизайна. Владелец approved Gate 1 и затем изменил product semantics: no overdraft, explicit
year/month/day backfill up to 120 occurrences, and offsite recovery deferred without a release gate.
