# Cometa — resume point and next phase

Date: 2026-09-06. Recovery is complete: current B `20260906T104102Z`, previous A
`20260906T104101Z`, both source `774f0ae`. A activated at `12:31:30Z`, B at `12:33:21Z`; both
strict preflights and `prepare --repair-bot` passed with matching source/checksums. Ordinary
31-second health/TLS/API gates passed: web/bot healthy, zero restarts, `bot_polling_ready`, no
repeated profile `429`. Full and ledger status exited 0; evidence:
`/private/tmp/cometa-104102-live-status.log`. Mode remains LOCAL with zero owner canonical imports;
expanded bank chat flows are not active. Final `pnpm verify` passed again at `13:01Z`: 815 tests,
lint/deploy guards/build.
Combined Opus review produced no accepted report because the organization disabled Claude Code
access. The owner explicitly waived missing review only for emergency recovery source `774f0ae`.
That narrow exception closes its deploy gate, not a clean review or a future-change waiver.
The earlier failed B `095602` activation and unhealthy rollback A `095601` are incident history.
Earlier candidate `2897de5` retains
the prior lifecycle/import fixes and fixes v19's terminal cold-session guard with a red/green
compiling mutant. Full `pnpm verify` passed: 799 tests (577 web + 222 bot). Immutable browser
verification passed 5 scenarios / 19 checks; report: `/private/tmp/cometa-foreground-browser-2897de5-4ZzXID/report.json`.
V19's continuous-progress visual preference was rejected after unchanged Chrome geometry/focus
and an explicit CLAUDE invariant. These checks cover the source of the failed release pair.
Original v20 did not run because of session quota. Exact Opus 5 retry finished at `10:18Z`:
`clean`, zero findings, resolved source `2897de5`. Evidence is in
`/private/tmp/claude-paired-review-final-20260906-v20-retry/report.json` and `meta.json`.
The 9 signed checks passed again at `10:05Z`; live health and LOCAL/zero imports were reconfirmed
at `10:08Z`. Final packages `20260906T095601Z`/`20260906T095602Z` were uploaded at `10:19Z`;
local/remote checksums, extracted source parity and strict preflights passed before the failed B
activation and unhealthy rollback A. Public visuals are in `51a2eb0`; latest Linux CI for `774f0ae`
passed at `12:16:08Z`, run `34032518573`. At `13:03:18Z`, both Old 438-row snapshots retained hashes
and marker `071101`, with zero imports. Real Telegram Web John Cometa independently completed
English→KZT→ready→Open Cometa→Telegram consent→embedded Mini App on compiled `104102`, with
437 rows/four accounts and no reset or mutation. At `12:58Z` ChatGPT search returned nine results
including original Pending, Received filter returned zero, RU→English and primary KZT→USD→KZT
passed with display-only currency changes. Exact transaction/account hashes stayed unchanged;
`700000 KZT` transfer was blocked with shortfall `84040.43`, no submit. Foreground/reopen passed:
draft `123 KZT` survived tab switch/back, dynamic native MainButton was enabled, native Back closed
the sheet, and close → `/help` (four LOCAL commands) → new Open Cometa button reopened the app.
Final proof at `13:03:48Z` retained identical hashes, 437 rows/four accounts, English/KZT/compiled
104102/LOCAL. Distinct John Web QA is complete; Old final-build, phone and server-mode gates remain.
The milestone is not accepted.

The deployed source passed 763 tests, 10 local web-browser checks, 9 synthetic signed real-backend
checks and clean narrow Opus v13. A separate production browser pass covered 10 checks. These
results are historical evidence, not the final candidate review or Android/iOS acceptance. Exact evidence belongs
in `docs/handoff.md`; architecture remains canonical in `docs/spec.md`.

## Preserved baseline

- Keep the intentional owner KZT fixture: four fresh role accounts, 436 rows before current-day
  settlement, owner-statement history, deterministic continuation and pending ChatGPT. The seven
  other base currencies use separate synthetic, market-specific fixtures with equivalent pinned
  USD economics. Do not replace these datasets without an explicit owner decision.
- The selected onboarding currency creates the fixture once. Later primary-currency changes affect
  reporting only; reset rebuilds the same fixture.
- Web stays device-local. After the guarded activation, Telegram uses one SQLite-backed canonical
  mock ledger per verified Telegram ID, shared by the bot and Mini App through typed commands.
- The product remains fictional. It has no real money, payment rails, bank connection, KYC or AML.
- Production origin is Irena. Hostinger remains the external TLS rollback origin; Julia is unrelated
  to Cometa. `ssh -G irena` currently resolves user `irena`, uid/gid `1001`; use that live alias,
  not the old `metaflexer` login.
- Caddy is the only public listener/TLS owner on Irena. Docker web is loopback-only on `8080/8443`;
  the retained `8443` Nginx TLS hop is temporary bridge compatibility. Legacy Certbot units stay
  disabled/inactive. Recovery A104101/B104102 is source-clean and healthy; old patched C/D releases
  are historical migration evidence, not active rollback slots. The new data-persistence rollback
  rehearsal remains pending.
- Production uses the exact versioned Docker daemon policy and Caddy's caddy-owned Unix admin
  socket, mode `0200`, with `persist_config off` and `h1/h2`. Trusted inner TLS and real-IP gates,
  key-only SSH, UFW `22/80/443`, `jq 1.8.1` and TLS/API gates were verified. Recovery's ordinary
  31-second health/TLS/API gates passed; polling is ready without restarts or repeated profile 429.
  Root-only same-VPS WAL-safe backups are `20260906T122958Z-before-20260906T104101Z.sqlite` and
  `20260906T123205Z-before-20260906T104102Z.sqlite` under `/srv/cometa-bank/backups`.
- Both real Telegram Old profiles, Nikita and MetaFlexer, persisted compiled marker B. Nikita's
  438 existing rows were preserved exactly; MetaFlexer's 437 became 438 only through interest.
  Do not reset these snapshots or identify either profile as John Cometa from a display name.
- Native desktop automation still hits `-10005`/`AXError.notImplemented`; the Browser plugin has no
  bindings. At the owner's explicit request, headed Chrome uses a fresh isolated profile at
  `/private/tmp/cometa-telegram-web-qa.Mtuner/profile`, QR-authenticated by the owner. Real Web
  onboarding completed in John Cometa. Its namespace hash `b8c452f98d` is distinct from Old Nikita
  `5a39b27c62` and MetaFlexer `a98ab714e4`; do not conflate the three profiles. John has compiled
  `104102`, 437 rows/four accounts, no resets/mutations; both Old 438-row hashes and marker `071101`
  were unchanged at `13:03:18Z`. Distinct John Web foreground/reopen and native-control QA passed;
  Old final-build and phone gates remain open.
- Two showcase compositions are published in `51a2eb0`: actual web screenshots and an explicitly illustrative
  Telegram preview using exact bot-engine copy, not native captures. Their provenance is in
  `docs/assets/showcase/README.md`; neither replaces real-profile acceptance.
- `nikitacometa/mock-bank-app` is public by owner decision. Exact KZT dates, merchants and amounts
  remain fingerprintable despite the removal of direct PII.

## Authority contract (deployed, server mode disabled)

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

1. Read `CLAUDE.md`, `docs/handoff.md`, this file and `deploy/standalone/README.md`.
2. Inspect `git status` and preserve unrelated changes. Recovery `774f0ae` is deployed under the
   explicit owner emergency waiver for its missing Opus review only. Organization access remains
   disabled; this is not clean review or permission to skip future reviews. Do not start another
   improvement/review cycle or repeat recovery. Continue the bounded acceptance already in progress.
3. Recheck Irena, current/previous images, containers/restarts, `ledger_mode=local`, Caddy semantics,
   exact loopback bindings, quiesced renewal units, DNS and TLS/API smoke. The Docker/Caddy bridge
   is already installed; do not rerun its host-wide migration as the next normal release step.
4. Keep the recovered A104101/B104102 rollback pair on `774f0ae`; do not rerun prepare/activate or
   the host migration. Both ordinary health/TLS/API gates and root-only WAL-safe backups are done.
   Older `075300`/`075301`, `092401`/`092402`, `094101`/`094102` and incident `095601`/`095602`
   are not the active rollback pair. Preserve the DB/token and LOCAL mode during remaining QA.
5. Repeat real Telegram Old foreground/reopen, native-control and snapshot-preservation checks in
   Nikita and MetaFlexer. Verify the new compiled marker in both profiles and keep the existing
   438-row snapshots intact except for legitimate time-derived settlement. The owner authorized
   deploy and QA of these own profiles, including mock-bot messages and callbacks; unrelated
   external actions are not covered by that authorization.
   Desktop automation is limited, but the owner-authenticated isolated Web profile is now available.
   Focused Web QA for distinct John Cometa is complete, including foreground/native controls and
   fresh `/help` launch with exact bank-state preservation. Do not substitute that distinct namespace
   for Old's final-build release-marker/preservation retests.
6. Only after the fix and real-profile retest, apply the one-way server-mode switch and import each
   preserved device snapshot once. Prove one-off, recurrence/backfill, overdraft rejection,
   add/adjust/close/restore, current→previous→current survival and cross-profile isolation. Use RU/EN
   journeys without reseeding existing accounts to manufacture a different base currency.
7. Capture three sanitized real Telegram screens in one README row only after the live journeys pass.
   Until then retain the two honest showcase visuals and their explicit Telegram-preview label.
   Browser emulation does not replace current Android/iOS Telegram acceptance.
8. Before non-test use, rotate the exposed test bot token through the hidden-TTY installer. Then
   decide Hostinger retirement and HSTS. Remove inner TLS/Certbot only in the separate post-bridge
   task after two compatible rollback targets exist.

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
