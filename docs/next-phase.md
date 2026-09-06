# Cometa — resume point and next phase

Date: 2026-09-06. The multi-user Telegram ledger is an implemented local candidate. It has not been
deployed, activated or accepted in the live bot. The final Docker/Caddy perimeter changes also remain
local and still need the integrated gate plus immutable repeat. Current production evidence and exact
release IDs belong in `docs/handoff.md`; architecture remains canonical in `docs/spec.md`.

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
  to Cometa.
- Caddy is the only public listener/TLS owner on Irena. Docker web is loopback-only on `8080/8443`;
  the retained `8443` Nginx TLS hop is temporary bridge compatibility. Legacy Certbot units stay
  disabled/inactive. Current C/D release trees were manually port-patched and must be replaced by
  two source-clean releases before ordinary rollback is trusted again.
- Production still uses the legacy Caddy TCP admin endpoint and has no versioned Docker daemon
  config. The candidate permissioned Caddy Unix socket and Docker perimeter installer have not run.
- `nikitacometa/mock-bank-app` is public by owner decision. Exact KZT dates, merchants and amounts
  remain fingerprintable despite the removal of direct PII.

## Local candidate contract

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
- Before `harden-edge`, immutable release A must run `install-docker-perimeter.sh` dry-run and
  `--apply`. It requires Docker 28+, installs the exact three-key daemon JSON, binds the daemon only
  through systemd `-H fd://` and the pinned local Unix socket, and performs one controlled Docker
  restart under a root-only durable install/rollback journal. Exact `.pending.next` and
  `daemon.json.cometa-bank.next` states are recoverable only when ownership, mode and content are
  unambiguous; mixed or unknown state fails closed.
- `harden-edge` applies trusted inner TLS, real-IP recovery and host-wide `h1/h2`; it also moves
  Caddy admin from legacy loopback TCP to a caddy-owned Unix socket with mode `0200`, sets
  `persist_config off`, reloads through the endpoint currently live and verifies the served config.

## Resume order

1. Read `CLAUDE.md`, `docs/handoff.md`, this file and `deploy/standalone/README.md`.
2. Inspect `git status` and preserve unrelated changes. The last integrated snapshot before the
   final Docker/Caddy perimeter additions was green at 536 web / 215 bot tests; its production audit
   and secret/diff scans were also green. Re-run all of them for the current source. The prior
   full local Playwright pass plus a final-code 390×844/320×568 History→Home/History→Cards
   re-smoke are green. Browser QA is not Telegram/TMA live acceptance.
3. Run the final immutable post-fix paired-review repeat. The first two final passes found four
   concrete boundaries; the follow-up wizard review found stale callbacks/drift/replay; the closing
   pass found one redundant server settlement on boot, the next pass found impossible exact-capacity
   retries, residual triage found one unprocessed orphan reply, and the release-core pass found seven
   crash/perimeter gaps. Follow-up host-perimeter passes also closed Compose identity, Docker 28,
   exact runtime options/ports, checked producer status, pending-bot and rollback-operator boundaries.
   Due-state settlement,
   per-user single-flight, exact-capacity suppression, local foreground rollover and the orphan drain
   are covered by named mutants, but the latest behavior still needs a clean immutable verdict.
4. Recheck Irena, containers/restarts, ledger mode, Caddy semantics/listeners, exact loopback Docker
   bindings, quiesced legacy renewal units, DNS, served TLS and public smoke. Treat old memory and
   release IDs as stale until verified. After the final local review, package two credential-free,
   source-identical A/B archives locally and compare their extracted source before requesting deploy
   confirmation; this does not mutate Irena.
5. Only after explicit deploy confirmation, install missing `jq`, upload and extract both bridge A
   and B on Irena. From A, run `install-docker-perimeter.sh` dry-run and then `--apply`; disclose its controlled
   `docker.service` restart and require its root-only recovery journal to retire cleanly. Next run
   `harden-edge` dry-run and then `harden-edge --apply`: it removes only the two
   Cometa trust bypasses, keeps unrelated Caddy route blocks byte-preserved, applies host-wide
   `h1/h2` to close the unexposed HTTP/3 listener, restores client IP before legacy rate limiting,
   and migrates Caddy admin to the permissioned non-persistent Unix endpoint through the currently
   live endpoint.
   Then run strict preflight, prepare both releases,
   and activate A and B consecutively with ledger mode still local. During the A→B window, a
   legacy-D fallback must be managed only through A's pinned immutable script; never run the legacy
   current script. The edge marker is operator/current/hash-bound and blocks every other lifecycle
   action; activation/rollback retries accept zero safe containers before repair and require exact
   bridge topology plus strict cardinality after it. Pending edge hardening may repair a missing web,
   but requires the release-pinned bot to remain singular and healthy before mutating host config.
   Durable edge snapshots and activation/rollback intents must be absent after each
   successful lifecycle command. After B, prove both rollback slots source-clean and verify both
   compiled markers.
6. Apply the one-way server-mode switch, then prove one-off, recurrence/backfill, overdraft rejection,
   add/adjust/close/restore, restart/rollback survival and cross-profile isolation.
7. Capture three sanitized real Telegram screens in one README row only after the live journeys pass.
   Browser emulation does not replace current Android/iOS Telegram acceptance.
8. Before non-test use, rotate the exposed test bot token through the hidden-TTY installer. Then
   decide Hostinger retirement and HSTS. Remove inner TLS/Certbot only in the separate post-bridge
   task after two compatible rollback targets exist.

## Deferred work

- Encrypted offsite SQLite backup, retention monitoring and an epoch-rotating restore drill.
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
