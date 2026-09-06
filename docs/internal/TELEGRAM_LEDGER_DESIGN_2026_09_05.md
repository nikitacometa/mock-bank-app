# Telegram ledger and currency templates — анализ и план

Date: 2026-09-06. Gate 1 approved. Source `5774b01` is live on Irena as current B
`20260906T071101Z`, with previous A `20260906T071100Z`; both are authority-capable and the
Docker/Caddy bridge is installed. Persisted `ledger_mode` remains `local`; canonical imports and
server activation have not run. Real Telegram foreground QA exposed frontend recovery bugs in B.

Frozen runtime candidate `2897de5` passed `pnpm verify` at `09:55Z`: 799 tests (577 web + 222 bot).
Opus v19 returned two P3 findings, not clean: the terminal-cold retry defect is fixed and the
recovery-copy finding is rejected with browser evidence and the intended UX contract. All v19 items
are adjudicated. The final immutable browser replay passed five scenarios / 19 checks with zero
runtime errors; nine signed-backend browser checks also passed on `2897de5` at `10:05Z`.
The exact Opus 5 v20 retry returned clean at `10:18Z` on `2897de5`, with no findings; the original
v20 stopped before review on a session limit. The review gate is closed. Normal deploy is starting,
not yet verified complete. New archives `20260906T095601Z` and
`20260906T095602Z` are built, with identical extracted source and passing checksums.
Both were uploaded at `10:19Z`; remote checksums, source parity and strict preflights passed.
Neither is activated. Both owner snapshots still matched their 438-row parity hashes
at `10:05Z`; production was healthy and in local mode at `10:08Z`.
Uploaded `5838c51` archives
`20260906T094101Z` / `20260906T094102Z` passed source/checksum checks and both preflights but were
never prepared or activated. They and the earlier `de36540` pair `20260906T092401Z` /
`20260906T092402Z` are superseded and must not be activated. The rejected v16 rates finding retains
its evidence-backed disposition from Revision 29. Earlier browser evidence remains scoped to its
recorded snapshots. Real-profile retests, native assistive-technology checks and Android/iOS
acceptance are pending; see `docs/handoff.md` for live state.

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

The one-time release bridge completed on Irena: bridge A ran `install-docker-perimeter.sh`
dry-run/apply before `harden-edge`, including a controlled Docker restart under a root-only durable
install/rollback journal. The installed contract requires Docker Engine 28+, the exact versioned
three-key daemon JSON, one systemd-activated `-H fd://` endpoint and a pinned local Unix-socket CLI.
Only exact, secure `.pending.next` and `daemon.json.cometa-bank.next` producer states can be
reconciled; ambiguous state fails closed. `harden-edge` then applies host-wide `h1/h2`, trusted inner
TLS and real-IP semantics, moves Caddy admin from legacy loopback TCP to a caddy-owned Unix socket
with mode `0200`, disables config persistence and reloads through the endpoint currently serving.
Docker perimeter apply passed at `07:15:41Z`, Caddy hardening at `07:17:30Z`, A activation at
`07:22:17Z` and B activation at `07:23:53Z`, with stable health and inner/outer TLS/API smoke.
The next frontend release uses this hardened lifecycle; it does not repeat the one-time host migration.

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

## 2. Implementation and release checkpoint

The approved implementation contract spans the deployed bridge and the unreleased foreground fixes:

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
  namespace change resets transient UI. The candidate fixes the real-foreground self-abort and
  adds one shared bootstrap/recovery budget, durable copy-decision preservation and locked import
  cutover, plus late-first-fingerprint and in-flight progress handling; deployed B has not received
  these fixes yet. Revisions 30–32 distinguish the prior verified snapshots from committed
  `2897de5`, which also preserves terminal-cold failure after mid-attempt SDK arrival: 799 tests
  pass, final immutable browser checks pass, and all v19 items are adjudicated. The exact-model
  v20 retry returned clean with no findings at `10:18Z`; the original session-limit failure remains
  historical. The candidate's review gate is closed, not its deploy or native acceptance gates.
- History keeps a reversibly closed account selectable and exposes its localized `закрыт` /
  `closed` status in the account button's accessible name. The visual circle is hidden from the
  accessibility tree, and active-account names remain free of a status suffix.
- Fresh local browser QA passed on 2026-09-05 at 390×844 and 320×568: RU/EN without reload;
  Home/History/Cards/Settings/Transfer/receipt/reset; ChatGPT recurrence search; live Frankfurter
  `200`; zero horizontal overflow or console errors/warnings; fitted dialogs and visually clean
  captures. A `1,00 ₸` internal KZT transfer was reset and the original fixture restored.

The A/B bridge is deployed, but authority is still disabled. Both own Telegram Old profiles,
Nikita and MetaFlexer, persisted B's compiled marker; Nikita's 438 rows remained identical and
MetaFlexer's 437 gained only one interest row. Neither profile was identified as John Cometa.
Remaining gates are a verified fresh release of the reviewed candidate, real foreground/reopen
and snapshot-preservation retests, then the
one-way server switch and first imports. Mutation
journeys, rollback persistence and accepted live captures follow. Chromium with synthetic Telegram
transport does not substitute for native Telegram or Android/iOS acceptance.

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
| M1 — domain v5 + templates | Account/card lifecycle reasons, `demoBaseCurrency`, `fixtureId`, manual/adjustment transitions, safe recurring materializer, v4→v5 migration, eight seeds | KZT 436→437 lifecycle preserved; synthetic fixtures do not encode statement rows; pinned parity holds; savings/date/capacity contracts hold | Domain/persistence tests, named mutants, full verify | None | deployed in A/B; preservation checks passed |
| M2 — authority core | Shared bot bundle, additive SQLite tables, strict import, hashed idempotency, monotonic epoch/revision, signed bank API | Create-if-absent import preserves v4; atomic per-user commands; retry/collision/limit/restore cases typed; old DB opens | Repository/HTTP tests, migration/fallback harness, Opus money/concurrency review | Images only; service flag local | deployed in A/B; server mode and imports disabled |
| M3 — TMA sync | Platform command seam, sticky server receipt, ordered canonical adoption, foreground sync, web remains local | No local fallback after authority; stale response rejected; two IDs isolated; conflicting second-device import fails closed | Store/adapter tests, two-context Playwright TMA emulation, mutants | Reviewed frontend release before authority | bridge deployed; 2897de5 has 799 tests, mutant and both final browser suites green; exact v20 clean at 10:18Z; normal deploy starting, authority still local |
| M4 — transaction + recurrence bot UX | `/add`, `/recurring`, durable wizard, year/month/day backfill, typed outbox, RU/EN copy | Checking income/expense/date/monthly/backfill/pause/resume/cancel work across restart and retry; expense never overdraws or partially backfills | Bot behavior tests, parser/balance boundaries, stale/foreign callbacks, two-user tests | One-way server switch after M3 retest | deployed but disabled by local mode; live mutation QA pending |
| M5 — accounts bot UX | `/accounts`, add, adjust, close/restore, client UI reconciliation | Zero-balance close invariant, history retained, manual freeze/pause preserved, savings settles before current adjustment | Domain/bot/UI tests, one-account and closed states, Opus focused review | One-way server switch after M3 retest | deployed but disabled by local mode; live mutation QA pending |
| M6 — product polish | History effective dates/notes, immutable warning context, backend-only FX, operation-cap recovery and responsive QA | RU/EN readable at 320×568/390×844; no blocked bootstrap/materialization at capacity; full local journeys pass | Playwright, accessibility/overflow, `pnpm verify`, final paired review | Reviewed frontend release before native retest | 799 tests, five-scenario/19-check foreground replay and nine signed browser journeys green; stable geometry/focus proven; exact v20 clean, deploy/native acceptance pending |
| M7 — bridge release | Prepare two source-identical A/B releases; install the exact Docker daemon perimeter; harden the legacy Caddy/Nginx edge; keep authority local | Docker 28+ uses only systemd `-H fd://` and canonical daemon JSON; Caddy owns public TLS plus a `0200` Unix admin socket with persistence off, verified inner TLS and host-wide `h1/h2`; exact loopback runtime, trusted real IP and quiesced renewal hold; current/previous become source-clean | Installer dry/apply with controlled restart and durable recovery; transactional `harden-edge` dry/apply through current admin endpoint; strict A/B preflight/prepare/activate; inner/outer smoke; pinned A operator on legacy fallback | Owner-authorized deployment; recovery/failure harnesses; two consecutive activations; no ledger import | completed: B `20260906T071101Z` current / A `20260906T071100Z` previous, source 5774b01, ledger local |
| M8 — live acceptance + showcase | Switch service flag, import both preserved owner profiles, current→previous→current mutation probe, RU/EN chat journeys, three real captures | Profiles stay isolated and survive restart/rollback; web demo unaffected; README has exactly three equal sanitized Telegram images in one row | `pnpm verify`, live API/TLS, Telegram Old Computer Use, owner Android/iOS gate, screenshot guard | Reviewed foreground fix and real-profile retest before server switch/import | both B markers and baseline preservation verified; server/native mutation acceptance pending |

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

Revisions below retain the status of their original snapshots. The current production/candidate
boundary is recorded at the top and in the latest revision; earlier "pending" or "not deployed" statements
are historical, not instructions to repeat the completed host migration.

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
acceptance are pending for that historical snapshot.

Revision 27 closes the final product and deployment preview edges. Bank history now groups and
labels all rows on the UTC calendar and renders UTC clocks, including old rows without
`effectiveDate`. The owner fixture's Bangkok-origin timestamps remain byte-identical: its merchant
opening-hour tests explicitly use the origin timezone, not the UI timezone. The suggestion to
shift all fixture timestamps was rejected because it conflicts with the approved preservation and
UTC rules. Test timezone changes assert that the runtime actually applied the requested zone.

Docker dry-runs no longer promote or unlink valid recovery candidates. Socket inspection validates
exact ownership/PID/cardinality before canonicalizing field padding with already-required `awk`,
preventing cosmetic `ss` spacing changes from interrupting recovery. The independent Opus v10-v12
findings have concrete regression/mutant coverage; v13 is clean on `5774b01` (session
`77dde572-a114-46bb-94c7-dc10b311a275`, actual model `claude-opus-5`, requested xhigh).

Latest evidence: 541 web + 222 bot tests, complete lint/typecheck/build/deploy guards, no known
production dependency vulnerabilities, 10 web-browser checks and 9 synthetic signed authority
browser checks. The full web suite passes in UTC and New York; the 49 fixture/format/History tests
also pass in UTC+14. Three new bot cross-layer tests exercise the real SQLite repository, signed
HTTP server, domain and onboarding/flow engines. Browser emulation is not a live Telegram or phone
acceptance claim. Existing KZT balances and all 437 baseline transactions are preserved.

Revision 28 records the real Telegram foreground defect and the final recovery candidate `9e29199`.
The host bridge itself is complete: source `5774b01` runs as B `20260906T071101Z` with A
`20260906T071100Z` previous, both authority-capable. Docker/Caddy apply and A→B health/TLS gates
passed; root-only WAL-safe backups preceded both activations. Ledger mode is still `local`, with
no imports. The frontend fixes below are committed and verified locally, but not deployed.

The real MetaFlexer foreground pass exposed a self-aborting synchronization lifecycle that left
the app `read_only`. The first repair kept same-ID bridge-local drafts mounted, but independent
Opus v14 found two competing synchronization starters bypassing the shared attempt budget, loss
of the explicit server-copy decision on foreground, and a post-unmount assertion that did not
flush asynchronous listener work. Opus v15 found a genuine data-loss window: the mounted shell
could still commit locally after the sticky authority marker and before import adoption. It also
found that preserving the shell removed its incidental remount-driven exchange-rate refresh.

The final fixes use one long-lived BootstrapGate coordinator for cold launch, retry and foreground
signals, sharing the existing attempt budget, cooldown and coalescing. Raw identity changes enter
quarantine immediately rather than waiting for an HTTP retry budget; obsolete requests cannot
undo the newer isolation boundary. Verified same-ID local refresh preserves mounted drafts, and
`server_copy_confirmation_required` survives unsuccessful refresh until the user decides. The
coordinator remains alive while its shell is hidden, cleans up listeners on unmount and resumes
settlement plus freshness-aware rate refresh only after successful visible synchronization, with
abort/fingerprint/read-only checks before the rate leg.

Import cutover freezes local mutations before taking the snapshot. Under the persistence lock it
validates the active identity, persists the sticky marker and rebases from the latest durable state,
including another tab's write whose storage event has not arrived. Local mutation callbacks check
the authority boundary again inside the lock, so already-queued writes cannot reopen local mode
after cutover. A rejected namespace or failed marker persistence never uploads a stale or foreign
snapshot; the first accepted import remains canonical without merging or discarding prior writes.

Verification for frozen `9e29199`: `pnpm verify` passed 561 web + 222 bot tests (783 total). Eight
focused import-guard tests passed; removing the shared authority guard made six queued-write cases
fail, and restoring it returned all eight cases to green. Five separate coordinator mutants were
also killed. An immutable Chromium repeat passed six scenarios: cold local launch,
same-ID draft preservation, raw identity switch, failed foreground network recovery with both caches
intact, recovery from quarantined stale parsed identity, and absence of sticky markers/imports in
local mode. Evidence: `/private/tmp/cometa-foreground-browser-snapshot-5XZWgL/report.json`.
It uses the production frontend/SDK, signed HTTP and file-backed SQLite, but synthetic Telegram
identities/transport and explicit document hidden→visible events; it is not native client acceptance.
The nine signed authority-browser checks were rerun on `9e29199` and passed. A final New York
lifecycle/store pass covered 95 tests; the UTC+14 seed/recurrence/format/History pass covered 56.
A separate immutable Chromium cutover probe queued a real UI transfer behind a native Web Lock,
started import through the production store/authenticated adapter, and verified read-only rendering
before lock acquisition/upload. The queued transfer and subsequent writes added no rows; one real
HTTP import and a reload preserved all 437 original transactions, with zero runtime errors.
Evidence: `/private/tmp/cometa-foreground-browser-import-wu9RkX/report.json`. Its deterministic
store-triggered cutover is browser evidence, not a real Telegram foreground journey.

Baseline preservation remains proven separately on the real B launch: Nikita's existing 438 rows
were unchanged, MetaFlexer's 437 gained exactly one interest row, and both retained their own B
compiled marker. The intentional four-account/437-row fixture was not rewritten or reset, and no
owner snapshot was imported to the server. At this Revision 28 checkpoint, Opus v16 was running for
`9e29199`; its subsequent findings and adjudication are recorded in Revision 29. Native foreground/
reopen journeys must prove snapshots unchanged before enabling authority. Server mutation journeys,
current→previous→current persistence, accepted Telegram captures and Android/iOS remain pending.

Revision 29 records candidate `f2e04ea` and the adjudication of Opus v16. Reviewer session
`64e85be9-4d70-40b1-b444-c3d7787d9f75` used actual model `claude-opus-5`, requested `xhigh`, with
verified effort `null` (unobservable), at a reported cost of USD `4.106533`. Its verdict contained
four findings, not a clean pass. Findings 1, 3 and 4 were confirmed and fixed; finding 2 was rejected
using the runtime policy and an executable limiter probe.

- Finding 1: the first available raw fingerprint was treated as an account switch, aborting a cold
  bootstrap and sending it into the 30-second foreground cooldown. Minimal first-observation
  tracking now distinguishes first-ever SDK availability from a real identity change. It covers
  both an in-flight initial attempt and a completed `absent` result: the former keeps its short
  cold retry ladder, and the latter resumes that ladder when the first fingerprint arrives.
- Finding 3: a terminal synchronization failure left `idleRefreshAllowed` set, so later foreground
  edges kept retrying a permanent failure. The failure branch now clears that permission for
  non-retryable errors; explicit recovery and a genuine identity change retain their intended paths.
- Finding 4: a healthy foreground import switched the store to `read_only` while the gate rendered
  a connection error and a Retry button that could cancel the import. An `onPendingChange` callback
  and component-local progress state now distinguish in-flight synchronization from settled failure.
  Healthy pending work shows progress, not Retry; an explicit server-copy decision remains available.
  No new `bankStore` error code was added. Success, failure and timeout have three UI regression
  tests; the compiling render mutant failed all three, and restoring it returned the tests to green.
- Finding 2 alleged that foreground rate refresh would exhaust the authority budget. The actual
  `/bank-rates` policy is 12 requests per minute (`bot/rate-limit.ts:51`), while the shared foreground
  cooldown permits at most two starts per minute. The real limiter probe processed 120 foreground
  plus 120 manual requests over an hour with zero 429s; its positive control rejected the thirteenth
  request in one minute. Provider failure uses a 30-second retry cooldown, not the 12-hour successful
  cache (`src/services/exchangeRates.ts`); the existing failed-load recovery test passed. Skipping
  refresh merely because the snapshot is fallback/stale would suppress automatic provider recovery.
  The suggested skip was therefore not implemented; normal rate limiting remains unchanged.

`pnpm verify` passed at `08:56Z`: 570 web + 222 bot tests, 792 total, with the complete project gate.
At the Revision 29 checkpoint, Opus v17 was running; its verdict is recorded in Revision 30. Five further compiling
coordinator mutants were killed and the restored scratch passed 20 tests. The immutable `f2e04ea`
browser repeat passed six foreground/draft/isolation checks, six first-import checks and late-SDK
recovery in 1,301 ms with one bootstrap request. During the actual foreground-driven import, a
legitimate queued UI transfer completed before snapshot capture: all 437 original rows plus its
two transfer rows reached the canonical ledger and survived reload. In-flight import showed progress
without Retry; no runtime errors occurred. The separate unchanged-store probe still verifies that a
write granted after cutover is rejected. Evidence: `/private/tmp/cometa-foreground-browser-final-SZihmi/`.
The nine signed authority-browser checks were also rerun on `f2e04ea` and passed. These are synthetic
Telegram identities with real Chromium/SDK/HMAC HTTP/SQLite, not native Telegram acceptance.

A private parity baseline copied at `08:48Z` records two origin snapshots with 438 rows each, no
server imports or bank operations, and hash proofs. The evidence is retained at
`/private/tmp/cometa-canonical-parity-baseline-20260906.json`; raw Telegram IDs and ledger data are
not reproduced here. Production is unchanged: B/A still run `5774b01`, the hardened host bridge
remains healthy and `ledger_mode=local`. Candidate review, final browser checks, deploy and real
Nikita/MetaFlexer foreground retests precede server activation/import. Native mutation journeys,
rollback persistence, accepted live captures and Android/iOS acceptance remain open.

Revision 30 records the confirmed Opus v17 finding and a separate eventless cold-SDK regression.
Reviewer session `3022df31-d850-41ce-8cf6-6d652a38bb70` used actual model `claude-opus-5`, requested
`xhigh`, verified effort `null` (unobservable), at a reported cost of USD `3.484173`. Its verdict was
one P3 finding, not clean. The rates-exhaustion claim from v16 remains rejected for the limiter and
provider-recovery reasons documented in Revision 29; this follow-up does not change that decision.

The confirmed P3 was recovery-card/splash churn: each automatic retry gap rendered an error card,
then the next in-flight attempt replaced it with the splash, removing the Retry button and changing
live announcements. Component `recoveryVisible` now keeps an already-shown recovery card and the
same Retry DOM button mounted. The button is disabled while a request is pending, so it cannot
cancel healthy work. Explicit server-copy approval stays available, and a first healthy import still
shows initial progress rather than a false failure. Two App foreground regressions failed before
the fix and passed after it. A compiling render mutant removing `recoveryVisible` failed those two
cases; restoring the implementation returned them to green. The full gate passed 792 tests at
`09:12Z`, before the additional cold-SDK fix below.

The separate browser probe started with no SDK fingerprint and later supplied it without firing
visibility/pageshow/online events. Before the fix the app remained stuck after 15,007 ms with zero
HTTP bootstrap requests. A minimal result classification now treats `absent` as retryable only
while no first raw session fingerprint has ever been observed, using the existing bounded
1/3/8-second cold ladder instead of adding a polling loop or a new retry budget. Two regressions
cover this path; removing that classification in a compiling mutant failed both, with the unrelated
control still passing. The restored scratch passed 22 tests and app typecheck; focused verification
covered 35 tests with typecheck and ESLint green.

Real Chromium then recovered in 811 ms with one successful HMAC bootstrap (`200`), no injected DOM
events and no runtime errors. Evidence:
`/private/tmp/cometa-foreground-browser-noedge-BBlyWf/verification.json`. This used synthetic local
Telegram transport; native-client trigger frequency was not measured and production was not mutated.
The three-file follow-up is committed as `de36540`. Its full `pnpm verify` gate passed at `09:21Z`:
572 web + 222 bot tests (794 total), production builds, CSS and deployment guards. The known
521.55 KiB bundle-size warning is not a build failure. At this checkpoint immutable v18 was running
in `/private/tmp/claude-paired-review-final-20260906-v18`; its findings are recorded in Revision 31.
An immutable `de36540` Chromium replay passed six foreground and six first-import checks, plus
eventless late-SDK recovery in 805 ms. The import preserved all original 437 rows and both rows of
the legitimate pre-cutover UI transfer, rejected a new local writer during upload, sent exactly one
successful import and reloaded the same 439 rows. There were no runtime errors. Evidence:
`/private/tmp/cometa-foreground-browser-de36540-uQz4Aw/report.json`. The nine signed real-backend
browser journeys were also repeated successfully on `de36540` at `09:26Z`, including two-user
isolation, exact-money transfer, offline quarantine and recovery; injected network errors were
expected, not uncaught runtime failures. `pnpm audit --prod` reported no known vulnerabilities.
Both candidate archives, `20260906T092401Z` and `20260906T092402Z`, were built from a separate
immutable `de36540` worktree, each rerunning all 794 tests. Local and uploaded extracted source
trees compare identically. Both strict preflights passed; neither release was prepared or activated.
The subsequent v18 findings superseded both archives: do not activate either `20260906T092401Z`
or `20260906T092402Z`. A reviewed correction requires fresh immutable release IDs.
At `09:27Z`, a read-only comparison of both real native snapshots again matched the private
pre-deploy transaction/balance hashes: 438 rows each, with no server imports or mutation operations.
Live B `20260906T071101Z` / A `20260906T071100Z`
still run `5774b01`, with hardened host configuration, `ledger_mode=local` and zero canonical imports.
Final verification/review, deploy, native owner-profile retests and server/phone acceptance remain
open; earlier green snapshots do not prove this final follow-up accepted.

Revision 31 records the v18 verdict and the completed corrective follow-up in frozen runtime
commit `5838c51` (three source files; `CLAUDE.md` was committed separately as `ae9c65e`). Reviewer session
`79d64eb2-0a9b-4987-a4b5-510417ee3605` used actual model `claude-opus-5`, requested `xhigh`, with
verified effort `null` (unobservable), at a reported cost of USD `2.7545245`. Artifacts are
`/private/tmp/claude-paired-review-final-20260906-v18/{report,meta}.json`. All three findings were
confirmed; this was not a clean review.

- P2: after a failed attempt, latched recovery state kept saying synchronization had failed and
  nothing would change while a healthy first import was actively uploading. The correction keeps
  the stable recovery card but switches its RU/EN heading and description to truthful progress
  while pending, without false failure copy. It does not return to a splash or remove the user's
  control. Settled failure copy also stops promising that nothing can change after an uncertain
  network outcome.
- P3: the same retry kept the live-region text unchanged and put busy state on a natively disabled
  button, losing meaningful progress feedback and potentially focus. The correction retains the
  same focusable DOM button, uses `aria-disabled` plus a click guard during pending work, and updates
  the RU/EN progress text exposed by `role=status`. Explicit server-copy approval remains available;
  the initial healthy import still shows initial progress rather than a recovery error. DOM/focus
  regressions pass; native assistive-technology behavior has not been verified.
- P3: after cold absence exhausted attempts at 0/1/4/12 seconds, the first raw SDK fingerprint
  arriving at 15 seconds entered the ordinary foreground cooldown and waited until 42 seconds.
  The minimal correction targets only first-ever raw availability after absence: arrival at
  15 seconds now synchronizes at 16 seconds; arrival during the pending cold ladder at 5 seconds
  synchronizes at 6 seconds. Stale cold and external-cooldown timers are cleared. The shared
  attempt budget is unchanged; ordinary verified-session foreground behavior gains no bypass.

The two extended App foreground tests cover failure/timeout → retry → active import → Home.
They failed before the UI correction and then passed with the same DOM button/focus, no unintended
abort and exactly one legitimate second import after the failed or timed-out first attempt.
Fourteen focused UI tests, app typecheck and ESLint passed. A compiling copy mutant failed the two
specific retry/import cases while the healthy-import control passed. Removing the click guard
produced one primary failure proving an unwanted new bootstrap; the healthy control passed. The
other combined-case cascade is not counted as independent evidence. Restored source passed all
three import cases and typecheck. Two compiling first-SDK mutants each failed three specific tests
with 23 passing: restoring the old guards delayed recovery; omitting timer cancellation duplicated
requests. Restored source passed all 26 coordinator tests. Evidence is
`/private/tmp/cometa-first-sdk-mutants-nV2n8e/report.json`.

After the final copy correction, the full `pnpm verify` gate passed at `09:40Z`: 798 tests
(576 web + 222 bot), build and guards. At this checkpoint runtime source was frozen at `5838c51`
and immutable v19 was running in `/private/tmp/claude-paired-review-final-20260906-v19`; its verdict
and adjudication are recorded in Revision 32.
An immutable Chromium replay passed five scenarios / 19 behavior checks with 17 real HTTP 200
responses and two deliberately injected transport failures. The failure → retry → held import
journey preserved the same focused button, announced truthful progress, rejected a click while
pending and committed/reloaded all original rows. Eventless SDK recovery took 802 ms; first SDK
availability after 15 seconds recovered in 1,322 ms after the visibility edge. There were no runtime
errors. Evidence: `/private/tmp/cometa-foreground-browser-5838c51-u5sKXL/report.json`; the progress
screenshot was visually inspected. All probe processes closed. The separate nine signed-backend
browser journeys also passed on `5838c51` at `09:42Z`, including exact-money transfer, shared-storage
profile switching and offline recovery. Neither synthetic transport run is native Telegram acceptance.

Both uploaded `de36540` packages (`20260906T092401Z` and `20260906T092402Z`) had verified checksums,
identical extracted source and successful preflights, but neither was prepared or activated. They
are now superseded and must never be activated. New `5838c51` packages `20260906T094101Z` /
`20260906T094102Z` were built from a separate immutable source checkout, each rerunning all 798
tests. Local and remote extracted trees compare identically; both uploaded checksums and strict
host preflights passed at `09:46Z`. Neither has been prepared or activated yet.
Production remains B `20260906T071101Z` / previous
A `20260906T071100Z` on `5774b01`, with hardened host settings and `ledger_mode=local`; server
activation/imports have not run. Earlier private parity hashes and browser results remain historical
evidence, not acceptance of these corrections. Complete v19 and final browser checks before
releasing this candidate; native owner-profile, server mutation, rollback-persistence,
assistive-technology and Android/iOS acceptance remain pending.

Revision 32 records the v19 verdict, adjudication and terminal-cold correction in runtime
candidate `2897de5`. Reviewer session `23f0b096-f2d3-4d4f-899d-f2b70bf24022` used actual model
`claude-opus-5`, requested `xhigh`, with verified effort `null` (unobservable), at a reported cost
of USD `2.859691`. Artifacts are
`/private/tmp/claude-paired-review-final-20260906-v19/{report,meta}.json`. The review returned two
P3 findings, not a clean verdict; both have been adjudicated.

- Finding 2 confirmed: if the first raw SDK fingerprint appeared during a deferred cold attempt
  that then failed terminally, the first-availability path could launch another request. The fix
  adds `(retryPending || idleRefreshAllowed)` to the first-SDK guard, reusing existing state without
  new flags. The regression failed before the fix with two synchronization requests instead of
  one. Forty-one focused tests passed. Removing the guard was a compiling mutant that failed the
  specific terminal-cold regression with 26 tests passing; restored source passed all 27
  coordinator tests and typecheck. Evidence:
  `/private/tmp/cometa-terminal-cold-mutant-B8BF9e/report.json`.
- Finding 1 rejected: the source contract requires a mounted recovery card and truthful copy while
  a request is pending, not permanently unchanged messages. Progress reflects an actual request;
  failure copy during a delayed retry is truthful, and the bounded 4.5-second gap deliberately
  allows manual Retry. `CLAUDE.md` commit `c97b14e` makes this contract explicit. Adding a continuous
  retry state would change the intended control model without a demonstrated defect.

The actual Chrome probe `/private/tmp/cometa-recovery-geometry.PACwGH/run.mjs` passed: the same
button remained focused, the live region stayed mounted, and before/after button rectangles were
exactly equal (`x=144.40625`, `y=507.125`, `width=101.171875`, `height=44`). There was no remount or
layout shift. Failure → Retry → held import preserved the canonical 437 rows through reload with
zero runtime errors. The assertion that polite announcements must queue or lag is unsupported
without native assistive-technology evidence; that remains a manual check, not grounds to add
continuous state. This browser probe does not establish native screen-reader acceptance.

The full `pnpm verify` gate passed at `09:55Z`: 799 tests (577 web + 222 bot). The final immutable
`2897de5` browser replay passed all five scenarios / 19 behavior checks: 17 HTTP 200 responses,
two intentional transport failures and zero runtime errors. Evidence:
`/private/tmp/cometa-foreground-browser-2897de5-4ZzXID/report.json`.
The separate nine signed-backend browser checks were replayed on `2897de5` at `10:05Z` and passed.
At the same checkpoint both real owner snapshots still matched their private parity hashes with
438 rows each; no raw identity or account data is included here. Production health was green at
`10:08Z`, still in local mode.

Immutable v20 stopped before reviewing the candidate because of a Claude session limit, with reset
reported at 17:10 Bangkok. Evidence is
`/private/tmp/claude-paired-review-final-20260906-v20/raw.json`. This produced no review verdict.
The exact Opus 5 retry started at `10:10Z` and returned clean at `10:18Z`, with no findings.
Session `b073946a-ed7c-4ee2-8ba9-fa2b4953db59` used actual model `claude-opus-5` on resolved source
`2897de5c52d61f610e97d96f03d06bf6a34070e9`, requested `xhigh`, with verified effort `null`
(unobservable), at a reported cost of USD `2.5545275`. Evidence is
`/private/tmp/claude-paired-review-final-20260906-v20-retry/{report,meta}.json`. Residual policy/runtime
questions were not findings and requested no new probes. The final review gate is closed. The v19
terminal guard remains fixed and mutant-verified; its other UX finding retains the evidence-backed
rejection above.

Previous `5838c51` archives `20260906T094101Z` / `20260906T094102Z` were uploaded and passed
preflights but were never prepared or activated. They are superseded and must never be activated.
Fresh A `20260906T095601Z` and B `20260906T095602Z` are built from `2897de5`; extracted source
comparison (`diff -qr`) and checksum checks passed. Their respective SHA-256 values are
`d76e6c535e9e77192d66272011473fbcb221ef38ea2d0314847d0b71955dbe93` and
`547025dc4bcf77a465bacb8a89aaf8b02025fb5e0eff18eaf4d6940c0c488175`.
Both new archives were uploaded at `10:19Z`; remote checksums, source parity and strict preflights
passed. Neither is activated at this checkpoint.

The owner additionally authorized the main Telegram profile and web Telegram. The main
`Telegram.app` opened the Nikita Cometa chat via keyboard navigation, but clicking English still
returned the same Computer Use `-10005` error. Browser-plugin discovery returned no connected
browser. The request to connect the browser through Settings / Computer Use or log into web
Telegram is unanswered. These are current access blockers, not new application findings or native
acceptance evidence; unrelated external actions remain outside this QA authorization.

Production remains `5774b01`, current B `20260906T071101Z` / previous A `20260906T071100Z`, with
`ledger_mode=local` and zero canonical imports at the last verified checkpoint. Normal deploy is
starting after the clean review; completion is not yet claimed. Deploy verification,
real owner-profile preservation/reopen and server activation gates remain open. Server
mutation, rollback-persistence, native assistive-technology and Android/iOS acceptance are pending.
