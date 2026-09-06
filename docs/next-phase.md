# Cometa — resume point and next phase

Date: 2026-09-07; timestamps are September 6 UTC. Current B `20260906T181102Z`, previous A
`20260906T181101Z`, both source `bd435661abea6889aef59cb9e2ab77298fd4ce8d`; CI `34050857794`
passed 815 tests. Final `pnpm verify` passed at `19:00Z`: 577 web + 238 bot = 815, lint/CSS/deploy
harness/typecheck/build. A prepared/activated `18:13:06Z`/`18:15:52Z`; B `18:14:06Z`/`18:17:35Z`.
Guarded server activation passed at `18:20:35Z`, durable marker `18:19:32Z`, ordinary 31-second
health and inner/outer TLS/API gates green. Backup is root-only `0600`:
`/srv/cometa-bank/backups/20260906T181909Z-before-ledger-mode-server.sqlite`.
Telegram is now SERVER-authoritative; standalone web remains local.

Both original Old profiles normally reopened/imported once: exactly 438 preserved rows each,
revision 1, import 1, no other operations. Real John Telegram Web bot journeys passed income,
expense, monthly backfill/pause and account add/adjust/close/restore; an overdraft attempt changed
none of the three canonical states. Both original states stayed byte-identical throughout.
John ends at revision 11, 444 rows, five accounts (four active/one closed), one paused rule;
the original 437-row prefix remains intact. Keep these QA rows/account/rule; do not reset them.

Guarded B→A→B rollback passed at `18:53:18Z`/`18:56:24Z`; all three canonical states were exactly
unchanged at `18:56:45Z`, SERVER throughout, no DB restore. Real README visuals are complete and
visually inspected. Proven real QA is one writer plus two unchanged canonical readers. Native Old inline callbacks
remain automation-blocked; owner waiver is not two native write journeys or Android/iOS acceptance.
A missing monthly preview during WebSocket 1006 recovered through a fresh normal wizard; do not
label its cause a confirmed code defect. Historical deploy failures and detailed evidence stay in
the existing audit Revision 33. The owner explicitly requested no Opus for this completion;
do not start another review attempt or improvement cycle.

## Preserved baseline

- Keep the intentional owner KZT fixture: four fresh role accounts, 436 rows before current-day
  settlement, owner-statement history, deterministic continuation and pending ChatGPT. The seven
  other base currencies use separate synthetic, market-specific fixtures with equivalent pinned
  USD economics. Do not replace these datasets without an explicit owner decision.
- The selected onboarding currency creates the fixture once. Later primary-currency changes affect
  reporting only; reset rebuilds the same fixture.
- Web stays device-local. Since the guarded activation, Telegram uses one SQLite-backed canonical
  mock ledger per verified Telegram ID, shared by the bot and Mini App through typed commands.
- The product remains fictional. It has no real money, payment rails, bank connection, KYC or AML.
- Production origin is Irena. Hostinger remains the external TLS rollback origin; Julia is unrelated
  to Cometa. `ssh -G irena` currently resolves user `irena`, uid/gid `1001`; use that live alias,
  not the old `metaflexer` login.
- Caddy is the only public listener/TLS owner on Irena. Docker web is loopback-only on `8080/8443`;
  the retained `8443` Nginx TLS hop is temporary bridge compatibility. Legacy Certbot units stay
  disabled/inactive. Active A181101/B181102 is source-clean and healthy; old patched C/D releases
  are historical migration evidence, not active rollback slots. Current B181102/A181101 passed the
  full guarded B→A→B rehearsal with exact preservation of all three canonical states.
- Production uses the exact versioned Docker daemon policy and Caddy's caddy-owned Unix admin
  socket, mode `0200`, with `persist_config off` and `h1/h2`. Trusted inner TLS and real-IP gates,
  key-only SSH, UFW `22/80/443`, `jq 1.8.1` and TLS/API gates were verified. Recovery's ordinary
  31-second health/TLS/API gates passed; polling is ready without restarts or repeated profile 429.
  Root-only same-VPS WAL-safe backups are `20260906T122958Z-before-20260906T104101Z.sqlite` and
  `20260906T123205Z-before-20260906T104102Z.sqlite` under `/srv/cometa-bank/backups`.
- Both original Old profiles, Nikita and MetaFlexer, normally reopened and imported once. Their
  exact 438-row canonical states are revision 1/import 1/no other operations, unchanged by John writes.
  Do not reset these snapshots or identify either profile as John Cometa from a display name.
- Native desktop automation still hits `-10005`/`AXError.notImplemented`; the Browser plugin has no
  bindings. At the owner's explicit request, headed Chrome uses a fresh isolated profile at
  `/private/tmp/cometa-telegram-web-qa.Mtuner/profile`, QR-authenticated by the owner. Real Web
  onboarding completed in John Cometa. Its namespace hash `b8c452f98d` is distinct from Old Nikita
  `5a39b27c62` and MetaFlexer `a98ab714e4`; do not conflate the three profiles. John has compiled
  `104102`, 437 rows/four accounts at the historical local checkpoint. John now has 444 canonical
  rows/revision 11 after real bot writes; the original 437-row prefix and both Old states are intact.
  Distinct John Web foreground/reopen and native-control QA passed;
  remaining manual native button/foreground checks were owner-waived, not tested. Phone gates remain.
- `telegram-showcase.png` is now a real 1600×1040 composition of three unmodified 390×650 Telegram
  Web captures in one row: dashboard/expense picker, paused Spotify, accounts/Current detail.
  Captured on John B181102 after rollback and visually inspected without IDs/secrets/other chats;
  source PNGs, `telegram.html` and provenance are retained. Old engine-preview JSON is historical only.
  `app-showcase.png` remains the genuine 1600×1240 baseline Home/FX/History composition. Neither
  these captures nor the owner waiver establish two native write journeys or Android/iOS acceptance.
- `nikitacometa/mock-bank-app` is public by owner decision. Exact KZT dates, merchants and amounts
  remain fingerprintable despite the removal of direct PII.

## Authority contract (live SERVER mode)

- Eight deterministic fixtures: `KZT`, `THB`, `VND`, `RUB`, `USD`, `EUR`, `IDR`, `GEL`.
- First valid device import is create-if-absent and canonical. A different second-device snapshot
  must explicitly adopt the server copy. Sticky authority receipts forbid a local-write fallback.
- Manual income/expense and monthly recurrence are available only on active checking accounts.
  UTC start year/month/day supports atomic backfill of at most 120 occurrences. No expense path may
  make a balance negative.
- Savings accepts only a current balance adjustment after interest settlement. Every correction is
  a ledger row.
- Account removal is reversible close at zero balance. History remains; restore reverses only the
  card/rule state that close changed automatically.
- TMA rate refresh is backend-only. The server owns Frankfurter parsing, a process-wide 12-hour
  cache, in-flight dedupe, a 256 KiB/64-row response cap and a shared 30-second failure cooldown;
  clients cannot submit rate snapshots. Every refresh consumes its dedicated request budget even
  when `clientMutationId` repeats.
- Strict canonical import rejects future immutable timestamps, recurrence outside the allowed UTC
  window and invalid fixture role/currency topology. Local and server reset use the same current
  savings-settlement path.
- User `telegram`/`tma` operation history is a sliding 8,192-row window per user. Exact replay works
  while retained; a fresh command transactionally replaces the oldest row without pending outbox.
  Pending delivery is protected, and import/system materialization remains outside the window.
- Mutation rate-limit exemption requires an exact operation already persisted in SQLite. Invalid,
  conflicting and crash-before-commit retries consume the shared per-user budget again; a committed
  domain failure is replayed from its stored outcome.
- Signed import and command routes also charge separate non-replayable ingress budgets immediately
  after HMAC validation and before body parsing or canonical hashing. Exact persisted replay bypasses
  only the inner mutation budget.
- Authenticated bootstrap has a separate 30-per-minute budget per Telegram ID, charged after HMAC
  validation but before any user/bank SQLite lookup, with no replay exemption.
- Canonical server reads always run `applySettleAll` before recurring materialization under the
  repository lock. Signed bootstrap and bot chat reads share this path; repeating it on one UTC day
  adds neither duplicate interest/occurrences nor a revision bump.
- Every canonical-state response carries one exact UTC `serverTime`. The client validates state
  against that value, not the phone clock; device time supplies only a 24-hour corruption bound.
  If due materialization would exceed the 4 MiB snapshot limit, bootstrap returns the last canonical
  snapshot unchanged. `reset_demo` bypasses due materialization; ordinary growth fails typed `413`.
- Each wizard step atomically stores its next session and a `conversation_replies` receipt. Delivery
  status and the processed-update bit complete independently; pending processed replies survive the
  bounded processed-ID window, while delivered orphans expire with the six-day sequence-reset
  window.
- Canonical parsing performs an exact deep projection before hashing/storage and rejects future
  account, closure, transaction, contact and recurrence metadata.
- A raw Telegram session fingerprint starts a new identity epoch before the parsed SDK user is
  trusted. Same-user foreground sync preserves valid screens/drafts/toasts; state adoption closes
  only stale account/card/transfer targets, while an actual namespace switch resets transient UI.
- Durable recurring-warning rows freeze rule, reason, counterparty, currency and overdraft amounts
  at commit time. Delayed delivery never reads a later ledger revision for message copy.
- Bridge proof is release-scoped: each known profile must persist a client-contract marker emitted
  by the exact running build before server activation. `/app/<release-id>/` is a cache-busting launch
  key; rollback-safe aliases deliberately serve the current image and its compiled release marker.
- A local-mode bridge publishes and documents only `/start`, `/settings`, `/help` and `/privacy`.
  `server --apply` writes its durable final event, restarts the current bot so startup republishes
  mutation commands, then enforces the 31-second health/TLS gate. Reconciliation retries restart and
  verify again without reversing authority.
- The completed one-time bridge ran `install-docker-perimeter.sh` dry-run and `--apply` before
  `harden-edge`. It requires Docker 28+, installs the exact three-key daemon JSON, binds the daemon only
  through systemd `-H fd://` and the pinned local Unix socket, and performs one controlled Docker
  restart under a root-only durable install/rollback journal. Exact `.pending.next` and
  `daemon.json.cometa-bank.next` states are recoverable only when ownership, mode and content are
  unambiguous; mixed or unknown state fails closed.
- `harden-edge` applies trusted inner TLS, real-IP recovery and host-wide `h1/h2`; it also moves
  Caddy admin from legacy loopback TCP to a caddy-owned Unix socket with mode `0200`, sets
  `persist_config off`, reloads through the endpoint currently live and verifies the served config.

## Resume order

1. Read `CLAUDE.md`, `docs/handoff.md`, this file and `deploy/standalone/README.md`; preserve dirty edits.
2. Preserve the completed B→A→B proof: current B181102/previous A181101, exact states/revisions/
   operations/accounts/rules across both full immutable/perimeter/31-second health/TLS/API gates.
   SERVER is one-way; never fall back to local or repeat first imports. No DB restore was used.
3. Preserve completed real Telegram Web captures, their unmodified source PNGs/HTML and provenance;
   keep old illustrative JSON historical. Final 815 verify is green; no further visual generation is pending.
4. Retain QA rows: original Old states 438 rows/revision 1/import 1, John 444 rows/revision 11,
   QA THB account closed and monthly rule paused. Real income/expense, backfill, account lifecycle
   and three-profile canonical isolation passed; native Old inline callbacks remain blocked.
5. Do not add another Opus attempt or improvement cycle: the owner explicitly requested no Opus
   for this completion. Prior access failure/cancelled retry is not a clean review.
6. Keep Android/iOS and two-native-write-journey acceptance separate. The manual-control waiver
   is not a test result. Rotate the exposed test token before non-test use; defer Hostinger/HSTS
   and inner-TLS retirement until their own gates are met.

## Deferred work

- Encrypted offsite SQLite backup, retention monitoring and an epoch-rotating restore drill.
- Before the next token rotation, fix the dormant `deploy/bot/install-secret.sh:146`
  `restorePrevious` path: uutils `0.8.0` rejects `install -o 10001 -g 10001` without NSS entries.
  Use root-owned install followed by numeric `chown` and a harmless restore probe. The normal
  installer path is unaffected and the current test token was not changed during this bridge.
- Collapse Caddy→Nginx to loopback HTTP and remove the inner certificate, Certbot volume, inactive
  units and unreachable legacy renewal lifecycle after two source-clean rollback releases exist.
- User-facing data export/delete and ordered disaster-recovery semantics.
- Budgets, merchant details and category analytics over the same fictional ledger.
- Any real-money direction requires a new threat model, KYC/AML, audit trail, payment rails and
  jurisdiction review before product UI work.

## Portable lessons

- Isolate identity before reading persistence, not after bootstrap.
- Prove rollback as `new -> old -> new` while checking persistent state and secret metadata.
- Keep public certificate ownership at the host edge; an app rollback must not mutate or replace it.
- Treat target-host shell utilities as runtime dependencies and probe non-portable flags harmlessly.
- Treat operation idempotency as an explicit bounded window: replay is exact while retained, pending
  delivery cannot be evicted, and recovery paths remain available as completed rows roll forward.
- Freeze outbox presentation context at commit time. Mutable current state is not a valid source for
  a delayed message.
- Persist a conversation transition and the prompt that announces it atomically; delivery and
  update acknowledgement are two crashable operations, not one.
- Use the raw-session epoch to isolate identity, then use the verified canonical ID to release the
  namespace. A parsed SDK user is not an identity boundary by itself.
- A deterministic fixture is a test contract, not disposable demo content.
