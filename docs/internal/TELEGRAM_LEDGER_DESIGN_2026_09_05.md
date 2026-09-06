# Telegram ledger and currency templates — анализ и план

Date: 2026-09-05. Status: Gate 1 approved; the implementation candidate is local only. Product
behavior and the prior deploy snapshot passed integrated verification and local browser QA. The
newer Docker/Caddy perimeter changes still need the final integrated gate and immutable repeat;
owner acceptance and production activation are pending.

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

The release bridge now has a separate one-time host prerequisite before `harden-edge`: bridge A
runs `install-docker-perimeter.sh` dry-run/apply, which performs one controlled Docker restart under
a root-only durable install/rollback journal. It requires Docker Engine 28+, the exact versioned
three-key daemon JSON, one systemd-activated `-H fd://` endpoint and a pinned local Unix-socket CLI.
Only exact, secure `.pending.next` and `daemon.json.cometa-bank.next` producer states can be
reconciled; ambiguous state fails closed. `harden-edge` then applies host-wide `h1/h2`, trusted inner
TLS and real-IP semantics, moves Caddy admin from legacy loopback TCP to a caddy-owned Unix socket
with mode `0200`, disables config persistence and reloads through the endpoint currently serving.
None of this candidate infrastructure has been applied to Irena.

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
64-byte limit. Каждый review получает новый opaque flow ID, поэтому старая Confirm-кнопка не может
применить отредактированный позже draft. Любой wizard можно отменить; `/start`, `/add`, `/accounts`,
`/recurring` начинают новый flow и заменяют старый draft. Draft переживает restart и истекает через
24 часа; смена языка также заменяет его новым localized dashboard.

## 2. Local implementation checkpoint

The local candidate now implements the approved contract:

- `BankState` schema 5, eight deterministic base-currency fixtures and explicit v4 migration. The
  owner KZT fixture keeps its frozen balance and ordering; later primary-currency changes affect
  reporting only.
- Shared pure commands for manual entries, monthly recurrence, account lifecycle and balance
  adjustment. Transactions and rules are checking-only; savings accepts a current adjustment after
  interest settlement.
- Atomic UTC recurrence backfill for an explicit start year, month and billing day, capped at 120
  occurrences. Expense paths reject before any row can make the account negative.
- Per-Telegram-ID SQLite authority, create-if-absent import, first-device canonical selection,
  sticky server receipts and release-scoped client-contract markers. Web remains device-local.
- Signed TMA import, command and rate-refresh endpoints. Telegram clients cannot submit provider
  rate payloads; the backend fetches Frankfurter through a bounded parser and shares a process-wide
  12-hour cache with a short outage cooldown.
- Authenticated bootstrap has its own 30-per-minute budget per canonical Telegram ID. It is charged
  after HMAC identity validation but before any user or bank-state SQLite lookup and never receives
  an idempotency replay exemption.
- Reversible account close/restore, durable chat drafts, typed operation/outbox rows, per-user
  operation retention and immutable warning delivery context. A wizard step persists its next
  session and reply receipt atomically; delivery and Telegram update processing are tracked
  separately so either crash order can resume without skipping the prompt.
- Canonical state validation projects every nested object before hashing/storage and rejects future
  account, closure, transaction, contact and recurrence metadata. Only an exact operation already
  committed in SQLite bypasses a mutation request budget; invalid or uncommitted retries are
  charged again.
- Canonical JSON normalization preserves own `__proto__` members, including nested ones, so two
  distinct JSON payloads cannot collapse to the same operation fingerprint. Signed import verifies
  identity and charges a separate ingress budget before reading its large body; a fresh import also
  passes its mutation budget before canonical hashing. Signed commands charge their own ingress
  budget before body read or hashing.
- The client treats a raw Telegram session fingerprint change as an identity epoch before trusting
  the possibly stale parsed user signal. Same-user foreground sync preserves valid navigation and
  drafts; every canonical state adoption reconciles account/card/transfer targets, while a real
  namespace change resets transient UI.
- History keeps a reversibly closed account selectable and exposes its localized `закрыт` /
  `closed` status in the account button's accessible name. The visual circle is hidden from the
  accessibility tree, and active-account names remain free of a status suffix.
- Fresh local browser QA passed on 2026-09-05 at 390×844 and 320×568: RU/EN without reload;
  Home/History/Cards/Settings/Transfer/receipt/reset; ChatGPT recurrence search; live Frankfurter
  `200`; zero horizontal overflow or console errors/warnings; fitted dialogs and visually clean
  captures. A `1,00 ₸` internal KZT transfer was reset and the original fixture restored.

This candidate has not been deployed or activated. Remaining gates are the immutable post-fix review,
two authority-capable bridge releases, the guarded one-way server switch, two-profile Telegram
acceptance and the three real README captures. Local browser QA is not Telegram/TMA acceptance.

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

Presentation is provenance-aware. Fixture-owned labels may localize, but manual transaction text
and user-created account names remain exact even when they collide with fixture copy. Own-transfer
labels resolve the paired counterparty account by `transferGroupId`, preserving that user text across
locale changes, History search and idempotent receipt replay. The UI builds the counterpart index
once in O(accounts + transactions); each rendered row performs an O(1) lookup.

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
  and selects a safe active account only on active-only screens; History may retain a selected
  closed account. Leaving History for Home or Cards, or opening the global transfer, synchronously
  selects a safe active account before the destination renders; returning to History cannot
  resurrect the closed selection. No server transition claims to mutate `activeAccountId`
  atomically.
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
Synthetic external-funding income is always typed as semantic `topup`, never inferred as a purchase
from its sign, so filtering, localization and replay keep the intended transaction meaning.

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
A chosen onboarding currency supplies `demoBaseCurrency` only before the first bank snapshot. That
fixture identity is immutable afterward. Recovery reset rebuilds only the current
`demoBaseCurrency`; it never accepts a replacement currency and preserves the reporting preference.

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

conversation_replies
  source_update_id PK, telegram_user_id FK users, chat_id
  text, reply_markup_json, status, update_processed, created_at, delivered_at
  UNIQUE pending reply per telegram_user_id

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

A non-final wizard step does not write the new session and then hope its prompt sends. The next
`conversation_sessions` row and its `conversation_replies` receipt are inserted in one
`BEGIN IMMEDIATE` transaction keyed by the source Telegram update. Sending happens afterward.
`status` records delivery, while `update_processed` records the independent processed-update
commit. If delivery wins first, the receipt stays until the update is marked processed; if update
processing wins first, a pending receipt survives processed-ID pruning and is replayed before a
later update for that user. Once both sides complete, the row is removed. Delivered orphan receipts
are retained only through the six-day update-sequence recovery window. This bounds retention while
preserving both crash orders and prevents a later wizard input from overtaking a lost prompt.

State limits: at most 24 accounts, 5,000 transactions, 64 recurring rules, a 4 MiB canonical
snapshot, bounded text fields and safe integer money. Limit errors are typed; an ordinary oversized
write returns `413 bank_state_too_large`. If read-time materialization alone would cross the limit,
bootstrap returns the stored canonical snapshot unchanged; `reset_demo` skips due materialization
and remains an escape hatch. Every JSON read
crosses the same strict validator as browser persistence, must match the authenticated
Telegram ID, and is rebuilt from an exact deep projection. Unknown nested rate/account/transaction/
card/contact/profile/rule fields therefore cannot survive into the canonical hash or SQLite
snapshot. Future account creation/closure/accrual, transaction/FX/contact and recurrence metadata
are rejected against the server clock before import or adoption.

Every payload that contains canonical state carries one captured canonical UTC `serverTime`.
Frontend parsing validates the state relative to this value rather than the device clock. The latter
is used only for a symmetric 24-hour sanity bound, which tolerates normal phone skew while rejecting
missing, non-canonical or implausibly distant response clocks. Preferences-only and
`import_required` bootstrap payloads contain no state and require no `serverTime`.

Canonical JSON sorting builds null-prototype objects at every level. An own `__proto__` member from
parsed JSON therefore remains data instead of becoming a prototype mutation or disappearing from
the serialized fingerprint; nested occurrences follow the same rule.

User-generated `telegram` and `tma` operations use a sliding window capped at 8,192 rows per
Telegram ID. Exact-key replay is checked while retained. A fresh command transactionally deletes
the oldest row without pending outbox before inserting its replacement; any later failure rolls the
deletion back. Pending delivery is protected, while create-if-absent import and `system`
materialization never consume the window. If every retained row is protected, the fresh command
fails with typed `operation_capacity` and leaves canonical state unchanged. Replay guarantees end
after a completed row leaves the bounded window.

Nginx and the app enforce separate byte ceilings for import and commands, JSON depth/field
allow-lists, Telegram init-data freshness, and bounded per-user plus coarse per-IP request budgets.
The in-process limiter retains up to 2,048 user identities, each with independent route buckets;
LRU eviction removes one whole identity rather than resetting individual hot routes.
Rate-limit rejection happens before SQLite write work and returns a retry hint; the Bot polling path
uses the same per-user command budget. Only an exact `(user, source, operation ID, command hash)`
already persisted in `bank_operations` bypasses that budget. Invalid, crashed-before-commit and
same-ID/different-payload retries are charged again. A domain failure committed as an operation is
an exact stored outcome and replays with the exemption.
Rate refresh has its own 12-per-minute user budget and charges every request because it has no
durable replay outcome; reusing `clientMutationId` cannot bypass provider protection.
Authenticated bootstrap is likewise non-replayable and capped at 30 requests per user per minute.
The limiter runs after signed identity derivation but before `ensureUser`, bank-state lookup or
materialization, so a refresh loop cannot turn reads into unbounded SQLite work.
Import follows the same fail-cheap boundary: HMAC authentication precedes content/body processing,
then a non-replayable per-user `import_ingress` budget is charged before the body is read. After the
fixed envelope is parsed, a never-seen import ID must pass the narrower import budget before the
state is canonicalized or hashed. A known ID is hashed only to distinguish an exact durable replay
from an idempotency conflict; only the exact replay bypasses the narrower budget, never ingress.
Command follows the same outer boundary with `command_ingress`: every authenticated attempt is
charged before body read, JSON parsing, canonical hashing or replay lookup. A committed exact replay
may bypass the inner command budget but never this ingress budget.

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

POST /api/tma/bank-rates
Authorization: tma <raw init data>
{ version: 1, clientMutationId: string }
→ { version: 1, updated, revisionEpoch, revision, state, warnings: [] }
```

The backend derives Telegram ID and all timestamps; caller cannot address another user. Commands
apply to the latest server state inside one SQLite transaction, so two devices do not use
last-write-wins snapshots. Import strictly validates v4, requires `profile.telegramId` to equal the
authenticated canonical ID, rejects future immutable events/rules and invalid fixture topology,
migrates server-side to v5, and succeeds only while `bank_states` is absent. Canonical fixture
topology binds primary roles to their types and base currency and forbids duplicate active checking
currencies. The first authenticated device becomes canonical. A later device with a different local
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

The adapter also exposes a non-secret fingerprint of the current raw launch session. Parsed SDK
`initData.user` may lag after a Telegram account switch, so the client treats any fingerprint change
as a new synchronization epoch: it enters ephemeral quarantine before reading a parsed-ID
namespace, discards obsolete in-flight results, and releases persistence only after HMAC-verified
bootstrap binds the new canonical ID. Raw `initData` itself is never persisted or logged.

Rate refresh is backend-only in server mode. The TMA sends only a retry identifier; it cannot inject
an exchange-rate snapshot. One process-wide provider deduplicates concurrent requests and reuses a
coherent Frankfurter snapshot for 12 hours. The streaming response body is capped at 256 KiB and 64
rows, with an eight-second timeout. Failed or regressing provider responses enter a shared 30-second
cooldown so sequential users cannot create an outage request storm. Provider errors return a typed
unavailable response without exposing upstream details, and the last canonical snapshot remains
unchanged.

All bank responses pass through one client adoption queue and the existing persistence lock. For
the same `revisionEpoch`, only a greater bank revision may replace state; equal revision requires an
equal digest. On a new epoch, the previous epoch enters a persisted retired-epoch ring, so a delayed
response from the old database generation cannot come back. Rebuild and `/delete_demo` increment the
existing row revision instead of resetting it. A manual SQLite restore must rotate the global
`revisionEpoch`, as it already does for preferences.

Canonical adoption calls one UI reconciliation boundary. It keeps the current screen, toast queue
and still-valid sheet/draft on ordinary same-user foreground sync; History may retain a closed
account selection. It closes only a target invalidated by changed account/card/contact topology and
selects a safe active account for active-only screens. A verified Telegram namespace change remains
the stronger boundary and resets all transient UI, so another profile cannot inherit a draft.

Every canonical server read materializes in one fixed order: `applySettleAll(state, nowISO)` first,
then monthly recurrence over the settled state. Savings settlement is an atomic batch. If every due
interest row does not fit under the 5,000-row cap, all rows and accrual anchors stay unchanged and
recurrence cannot consume the reserved remainder. The same transition runs under the repository
write lock for signed bootstrap and bot chat reads/dashboard paths. Repeating it on the same UTC
day is idempotent: savings settlement and occurrence keys add no duplicate rows or revision bump.
Foreground/pageshow re-sync uses the existing bootstrap ladder; no background timer promises exact
wall-clock execution while the app is closed.

### 4.6 Migration, rollback and recovery

Authority is enabled in two releases, never in the first binary that understands it:

1. Deploy bridge A with import/API/schema support but `ledgerMode=local`; no user state moves.
2. Reopen both owner Telegram profiles on bridge A and verify its persisted client-contract marker.
   The exact marker is
   `cometa.bank.tma.user.<telegram-id>.ledger-client-contract =
   {version:1,bankContractVersion:1,telegramId,releaseId}`; `releaseId` must equal the value compiled
   into the running bridge image. Set both the per-user menu URL and BotFather Main Mini App URL to
   `https://euphoria.bot/app/<release-id>/` so a new launch uses a fresh cache key. The well-formed
   versioned path deliberately resolves to the current image on rollback; the compiled marker, not
   the path text, proves which build actually ran.
3. Deploy the same authority-capable binary as bridge B, making bridge A the tested rollback target.
4. Atomically switch the DB service flag to `server`; clients import once, then store the sticky
   marker. A rollback B→A continues serving the same server ledger. Pre-bridge images refuse a DB
   whose service flag is `server`. If the final audit flush fails after the commit, rerunning
   `ledger-mode server --apply` records a durable reconciliation event and repeats health gates;
   it never reverses authority or replays ledger mutations. Local-mode bridge startup publishes
   only `start`, `settings`, `help` and `privacy`, and its help text hides mutation commands. After
   the durable final switch event, the operator restarts the current bot so startup republishes the
   server command profiles, then requires 31 continuous healthy seconds and TLS/API smoke. A
   reconciliation retry performs the same restart and gates again.
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

Recurring warnings freeze their delivery facts when the matching canonical state is committed:
`ruleId`, pause reason, counterparty, currency and, for overdraft, available/required minor units.
The durable outbox renders only this immutable context, so a delayed send after reset, restore or a
later edit cannot describe the wrong rule. Older payloads without context use generic copy instead
of reconstructing facts from current state. Signed API warnings remain the minimal typed domain
projection and do not expose the delivery snapshot.

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
| M1 — domain v5 + templates | Account/card lifecycle reasons, `demoBaseCurrency`, `fixtureId`, manual/adjustment transitions, safe recurring materializer, v4→v5 migration, eight seeds | KZT 436→437 lifecycle preserved; synthetic fixtures do not encode statement rows; pinned parity holds; savings/date/capacity contracts hold | Domain/persistence tests, named mutants, full verify | None | implemented locally; final gate pending |
| M2 — authority core | Shared bot bundle, additive SQLite tables, strict import, hashed idempotency, monotonic epoch/revision, signed bank API | Create-if-absent import preserves v4; atomic per-user commands; retry/collision/limit/restore cases typed; old DB opens | Repository/HTTP tests, migration/fallback harness, Opus money/concurrency review | Images only; service flag local | implemented locally; final gate pending |
| M3 — TMA sync | Platform command seam, sticky server receipt, ordered canonical adoption, foreground sync, web remains local | No local fallback after authority; stale response rejected; two IDs isolated; conflicting second-device import fails closed | Store/adapter tests, two-context Playwright TMA emulation, mutants | Local only | implemented locally; final gate pending |
| M4 — transaction + recurrence bot UX | `/add`, `/recurring`, durable wizard, year/month/day backfill, typed outbox, RU/EN copy | Checking income/expense/date/monthly/backfill/pause/resume/cancel work across restart and retry; expense never overdraws or partially backfills | Bot behavior tests, parser/balance boundaries, stale/foreign callbacks, two-user tests | Local only | implemented locally; final gate pending |
| M5 — accounts bot UX | `/accounts`, add, adjust, close/restore, client UI reconciliation | Zero-balance close invariant, history retained, manual freeze/pause preserved, savings settles before current adjustment | Domain/bot/UI tests, one-account and closed states, Opus focused review | Local only | implemented locally; final gate pending |
| M6 — product polish | History effective dates/notes, immutable warning context, backend-only FX, operation-cap recovery and responsive QA | RU/EN readable at 320×568/390×844; no blocked bootstrap/materialization at capacity; full local journeys pass | Playwright, accessibility/overflow, `pnpm verify`, final paired review | Local only | local web QA passed; final review pending |
| M7 — bridge release | Prepare two source-identical A/B releases; install the exact Docker daemon perimeter; harden the legacy Caddy/Nginx edge; keep authority local | Docker 28+ uses only systemd `-H fd://` and canonical daemon JSON; Caddy owns public TLS plus a `0200` Unix admin socket with persistence off, verified inner TLS and host-wide `h1/h2`; exact loopback runtime, trusted real IP and quiesced renewal hold; current/previous become source-clean | Installer dry/apply with controlled restart and durable recovery; transactional `harden-edge` dry/apply through current admin endpoint; strict A/B preflight/prepare/activate; inner/outer smoke; pinned A operator on legacy fallback | Explicit deploy confirmation; recovery/failure harnesses; two consecutive activations; no ledger import | source contract implemented locally; final gate and deploy pending |
| M8 — live acceptance + showcase | Switch service flag, import both owner profiles, feature B→bridge A→feature B mutation probe, RU/KZT and EN/GEL chat journeys, three real captures | A/B ledgers differ and survive restart/rollback; web demo unaffected; README has exactly three equal sanitized Telegram images in one row | `pnpm verify`, live API/TLS, Telegram Old Computer Use, owner Android/iOS gate, screenshot guard | Activate only after all prior gates green | not started |

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

Revision 3 фиксирует последующее owner clarification: onboarding-selected fixture immutable;
`reset_demo` не принимает currency и пересоздаёт только текущий fixture. Strict import дополнительно
проверяет checking-only manual rows, current-date savings adjustments, непрерывность monthly
occurrences, post-close write cutoff и frozen cards закрытых счетов.

Revision 4 records the local implementation hardening: TMA rate refresh is backend-only with one
12-hour process cache; user operation retention preserves exact replay and excludes import/system
materialization; warning outbox rows carry immutable delivery context; and bridge acceptance is tied
to the exact running build through a release-scoped client-contract marker. None of these local
changes is evidence of production activation.

Revision 5 records the final boundary pass: canonical imports reject future timestamps and invalid
role/currency topology; synthetic `createdAt` values are monotonic within each UTC day; web and
server reset share the same current-interest settlement path; and provider protection includes
bounded streaming, a shared failure cooldown and a non-replayable refresh budget.

Revision 6 records the post-review durability pass: mutation budgets exempt only exact operations
already persisted in SQLite, while invalid and crash-before-commit retries remain charged; wizard
session transitions and reply receipts commit atomically with independent delivery/processed bits
and bounded retention; canonical parsing uses exact deep projection plus future metadata limits;
raw-session fingerprint epochs close the parsed-identity race; canonical adoption reconciles UI
without resetting valid same-user work; release paths are rollback-safe cache-key aliases whose
compiled marker proves the running build; and a post-switch audit failure is recoverable through a
durable `server --apply` reconciliation. The candidate is still local and offsite recovery remains
deferred.

Revision 7 records the post-Opus release-boundary fixes: authenticated bootstrap is limited to 30
requests per Telegram ID per minute before SQLite lookup and has no replay bypass; canonical server
reads always settle savings before recurrence and are idempotent within the same UTC day; local-mode
bridge command publication/help expose only non-mutating commands; and the one-way switch records
its final durable event before restarting the bot to publish server profiles, followed by the
31-second health/TLS gate. Reconciliation retries repeat that restart. Integrated `pnpm verify` is
green locally, and fresh 390×844/320×568 Playwright plus visual inspection passed; immutable review
and live bridge acceptance remain pending.

Revision 8 records the independent frontend preflight fixes: active-only navigation synchronously
normalizes a closed History selection; provenance-aware formatting preserves manual transaction,
custom-account and own-transfer user text across locale, search and replay; the own-transfer
counterpart index is built once in O(n) for O(1) row lookup; and synthetic fixture income is semantic
`topup`. Named mutants are killed and integrated `pnpm verify` is green at 516 web / 189 bot tests.
A post-fix Playwright re-smoke on the final code passed at 390×844 and 320×568: History→Home and
History→Cards were visually clean, root/body widths matched each viewport, and the console had 0
errors and 0 warnings before both sessions closed. The candidate remains local; only final immutable
review and live acceptance are pending.

Revision 9 records three post-Opus P3 boundary fixes. Canonical JSON now preserves own and nested
`__proto__` keys, preventing distinct operation payloads from sharing a fingerprint. Signed import
authenticates and consumes a non-replayable ingress budget before reading the body, while a fresh
import consumes its narrower mutation budget before canonical hashing. History account buttons add
localized `закрыт` / `closed` only to the accessible name of a closed account and hide the
visual marker from assistive technology. The candidate remains local and has not been deployed;
the integrated gate is green at 516 web / 189 bot tests. Fresh 390×844/320×568 browser sessions
covered Home, History search, Cards and Settings; RU→EN changed without reload and remained EN after
reload, both viewport widths stayed exact, and the console remained clean. Final immutable review
and live two-profile acceptance remain pending.

Revision 10 extends the same fail-cheap boundary to signed commands. A non-replayable per-user
`command_ingress` budget is charged immediately after HMAC and before body read, JSON parsing,
canonical hashing or SQLite replay lookup. Exact committed replay still bypasses the inner command
budget but never ingress. The named ordering mutant is killed; the integrated gate remains green at
516 web / 189 bot tests. The candidate remains local and has not been deployed.

Revision 11 records the read-only Irena topology audit after reboot. Caddy `2.11.4`, not Docker
Nginx, owns public TCP `80/443` and public ACME; the live web container exposes only loopback
`8080/8443`, with Caddy temporarily forwarding both Hosts to the complete Nginx HTTPS policy on
`8443`. Legacy Certbot units are quiesced. Existing C/D release trees were manually port-patched, so
they are runtime-compatible but not source-clean. The candidate now encodes exact loopback bindings,
scoped Caddy semantics, quiesced-renewal guards and independent inner/outer smokes; active lifecycle
paths cannot issue certificates or enable legacy renewal. Bridge A and B must both be prepared before
A is activated and then activated consecutively while authority is local. If A recovery restores
legacy D, operators use A's pinned immutable script until the clean pair is complete. Collapsing the
redundant inner TLS hop is explicitly deferred until both rollback targets carry this contract. A
targeted adversarial pass then closed four adjacent gaps: active commands inspect exact running
web/bot bindings, activation announces the pinned operator path before any legacy fallback can occur,
Caddy route/proxy/upstream/Host/TLS/no-HSTS validation is exact, and `status` verifies both immutable
image manifests. Public-binding and extra-upstream mutants are killed; the stable deploy gate is green.

Revision 12 closes the final capacity and stale-action audit. Savings settlement now commits every
due account as one bounded batch or leaves every row and accrual anchor untouched; a deferred batch
reserves the remaining transaction slots ahead of recurrence. Exact 5,000-row server reads remain
readable and resettable, and local settlement cannot persist row 5,001. Local card freeze delegates
to the same domain command as server mode, so a stale action cannot unfreeze a closed-account card.
User mutation history is now a transactional sliding 8,192-row replay window: completed rows can
roll forward, pending outbox is protected, and failed replacements restore the evicted row. Canonical
snapshots over 4 MiB return typed `413 bank_state_too_large`. Finally, request-limit capacity means
2,048 distinct Telegram IDs with independent per-route buckets and whole-user LRU eviction. Five
focused named mutants were killed, and the combined gate is green at 519 web / 199 bot tests.

Revision 13 closes two recovery edges found after the capacity pass. Read-time materialization can
no longer brick a near-4 MiB profile: bootstrap returns the prior canonical snapshot only for the
typed state-capacity failure, while `reset_demo` bypasses due work and ordinary mutations still fail
with `413`. Canonical-state responses now carry one captured exact UTC `serverTime`; the TMA parses
state against that trusted reference and uses its phone clock only for a 24-hour sanity bound. This
accepts a one-second server lead without weakening malformed or absurd-clock rejection. Russian
account-count copy now follows `Intl.PluralRules('ru')`. Independent server/client cross-review is
clean, the new named mutants are killed, and the combined gate is green at 529 web / 203 bot tests.

Revision 14 closes the last local/server parity gap found by the fresh domain audit. Web contact and
own-account transfers previously called the low-level pure transfer helper and could persist rows
5,001/5,002 from an exact-cap valid ledger. The local store now routes transfers through the same
bounded `applyBankCommand` transition used by server authority, maps `capacity` to explicit RU/EN
copy, and performs no state or persistence write on rejection. The exact-cap contact/own regression
and its named comparison mutant are green; the combined gate is green at 530 web / 203 bot tests.

Revision 15 closes all three findings from the first final immutable Opus 5 xhigh pass. A
production-wired bot in local authority mode now keeps `/start` and language changes on their normal
launch/ready cards and exposes no bank flow. Resuming an already-active recurring rule is an exact
`applied: false` no-op, while both original and edited amount messages are normalized and bounded
before they enter a durable draft, keeping preview and canonical command validation identical. The
production-wiring and domain mutants are killed; the combined gate is green at 531 web / 206 bot
tests. The post-fix immutable repeat and live acceptance remain pending.

Revision 16 closes the adjacent amount-boundary gap found by the next immutable pass. Account
balance adjustment now applies the same NFC/Unicode-aware 64-code-point normalization as transaction
entry before persisting a draft or rendering its preview, so canonical confirmation cannot reject a
value that chat already approved. The exact padded-balance regression kills the raw-storage mutant;
the combined gate is green at 531 web / 207 bot tests. Another immutable repeat and live acceptance
remain pending.

Revision 17 closes the follow-up wizard-boundary sweep. Transaction, account and recurring reviews
rotate their opaque flow ID, binding every Confirm callback to the exact durable draft shown beside
it; the stale-confirm mutant is killed. Account and recurring confirms re-preview current canonical
state before execution and expose a dashboard recovery path if another client changed the target.
An end-to-end grouped-money test proves that a language callback already resets the active wizard,
so the alleged cross-locale reparse path is unreachable. Display names now share the canonical
Unicode normalizer and reject surrogate code points. The combined gate is green at 531 web / 210
bot tests; immutable repeat and live acceptance remain pending.

Revision 18 closes the remaining successful-drift and post-commit replay edges. Account review now
persists the displayed pre-command balance/status and rotates to a fresh review when either changes.
Recurring review fingerprints the full rule, account status/balance, UTC through-day and transaction
count, preventing stale Resume from reporting success while immediately auto-pausing. A retry of an
exact Telegram operation already committed before session cleanup skips preview drift checks and
reaches the durable service replay, so it produces one mutation and the original outbox result. Four
focused regressions kill the balance, recurrence-state, recurrence-funds and replay mutants. The
combined gate is green at 531 web / 214 bot tests; immutable repeat and live acceptance remain
pending.

Revision 19 closes the P3 from immutable Opus 5 xhigh session
`b074ca7c-23c4-4b2d-a695-44de7aea93f6`. Server bootstrap already settles interest and materializes
recurrence before returning its canonical snapshot. Client `settleNow` now mirrors those due
conditions instead of blindly sending a second command: same-day canonical state is a no-op, while
an overdue savings anchor or active due recurrence after import/UTC rollover sends exactly one
per-user single-flight request. Verified Telegram foreground sync calls the same action, preserving
bridge-local rollover; read-only mode remains fail-closed. Four named mutants cover the bootstrap,
import, concurrency and foreground branches.

Revision 20 closes the residual crash-recovery P3. A process death after atomic conversation
session/reply insertion but before `markProcessed` could leave `pending, update_processed=0`; if the
old Telegram update was no longer replayed, a new wizard reply hit the one-pending-per-user unique
index. Resume now reads the singular pending reply for that user without filtering on the processed
bit, drains it, and then accepts the newer update. The end-to-end restart regression and restored-SQL
mutant prove the boundary.

Revision 21 records immutable Opus 5 xhigh session `c6d51ebb-ebfd-4a83-aa59-dc068bbfb79f` over
all 117 candidate paths. It found one P3 at an exact 5,000-row positive-interest ceiling: the server
correctly kept the settlement atomic, but client due-state retried an impossible fresh command on
every mount and foreground. Client preflight now runs the pure bounded settlement transition first
and suppresses only `capacityReached`; a due recurrence remains eligible when interest is not the
blocking batch. The exact-capacity regression and restored guard mutant prove that no ingress or
replay-window slot is burned.

Revision 22 closes the final staged-edge audit. Sequential inner/outer probes now explicitly
propagate every profile, web, alias and API failure, with a table-driven negative harness that killed
the removed-propagation mutant. A candidate-owned, dry-run-first `harden-edge --apply` transaction
accepts only a fully legacy or fully strict edge, verifies the served inner certificate chain,
hostname and 21-day lifetime, then removes the two target Caddy bypasses, pins the TCP-only `h1/h2`
contract and installs the exact trusted real-IP block before legacy rate limiting. Unrelated Caddy
route blocks are preserved, while the shared server protocol policy deliberately becomes host-wide
`h1/h2`; bind-mounted Nginx uses a web-only force recreate, not a stale-inode reload.
Ten injected failures restore both config snapshots. Strict preflight and every lifecycle action
then enforce no UDP `443`, normal inner TLS trust and exact real-IP semantics; explicit rollback
hardens a legacy target before installing it. The expiry-gate mutant is killed and restored. The
server remains unchanged pending explicit deploy confirmation.

Revision 23 closes the independent release-core pass. Hardening verifies the current immutable image
manifest before recreating web; all OpenSSL/curl probes are time-bounded; source and runtime reject
host/container network namespaces; strict host preflight exercises the actual inner TLS endpoint.
Root-only recovery snapshots live outside process scratch and remain after a failed automatic restore.
Activation and rollback now flush separate durable intents before their two symlink writes. A retry
accepts only the before, between or complete link pair, recreates the intended runtime/config, commits
both links and audit, then retires the marker. Dynamic interrupted-lifecycle and failed-recovery
harnesses pass, and the removed host-network guard mutant is killed and restored.

Revision 24 closes the adversarial retry/perimeter follow-up (5 P2, 2 P3). Pre-runtime checks now
permit zero or one container per service so `SIGKILL` during `force-recreate` is repairable, while any
existing container and named network must already satisfy exact namespace, attachment, `bridge`,
internal and loopback rules. Strict cardinality, immutable image health and both TLS smokes run after
repair and before link commit. Edge recovery records immutable operator/current IDs plus both snapshot
hashes, flushes the pair before publishing its marker and blocks every other lifecycle action until the
recorded operator reconciles it. Each symlink rename is directory-fsynced, both rollback slots are
reverified, and OpenSSL gets TERM plus bounded KILL. Failure injection covers zero-runtime retry,
`macvlan`, extra attachment, snapshot tamper, duplicate containers and both link flush points; the
removed-first-fsync mutant fails the named lifecycle test and is restored byte-for-byte.

Revision 25 closes the extended host-perimeter pass. Rendered Compose is bound to the exact
`cometa-bank` project, and both source and runtime enforce the complete service/network graph.
Runtime network modes must name an attached network; bridge options are an exact allow-list, so
direct-routing and trusted-interface drift fail closed. Docker Engine 28 is the minimum because
older engines do not guarantee that localhost-published ports are host-only. Host preflight now
checks both web loopback bindings and the bot's empty port map. Every `ss`, `jq` and `awk` producer is
captured with a checked status before its output is trusted. Pending edge recovery allows a missing
web runtime but requires the immutable bot to remain singular and healthy before host mutation, and
rollback intent is bound to its original-current immutable operator. Dynamic harnesses cover partial
producer output, unknown cardinality, routed bridge mode, an exposed bot port, Docker 27, a third
rollback operator and the zero-runtime pre-repair versus strict post-repair boundary.

The combined gate for that Revision 25 snapshot was green at 536 web / 215 bot tests. The
rate-revision race test pins its UTC clock and passed 20 consecutive focused runs without weakening
production future-skew rejection.

Revision 26 adds the pre-edge Docker daemon perimeter and permissioned Caddy admin boundary.
`install-docker-perimeter.sh` must run from immutable bridge A before `harden-edge`: dry run first,
then `--apply`. It pins `/usr/bin/docker` to `/run/docker.sock`, requires Docker 28+, verifies the
single systemd `-H fd://` daemon endpoint, installs the exact three-key daemon JSON and performs one
controlled restart. A root-only seven-field journal records source/current/container identities and
an `install` or `rollback` phase; exact `.next` candidates are reconciled only when their ownership,
mode and content are unambiguous, while mixed state fails closed. The strict Caddy candidate uses a
caddy-owned Unix admin socket at mode `0200` with `persist_config off`; legacy-to-strict and rollback
reload through the currently live endpoint and compare the live canonical config to the installed
file. Production remains unchanged. The Revision 26 integrated gate, immutable repeat and live
acceptance are pending.
