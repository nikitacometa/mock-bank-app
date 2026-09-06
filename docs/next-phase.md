# Cometa — resume point and next phase

Date: 2026-09-06. Source `5774b01` is deployed on Irena as current B `20260906T071101Z`, with
previous A `20260906T071100Z`. Both are authority-capable; Docker/Caddy hardening is complete.
Persisted ledger mode is still `local`, with zero canonical imports. Candidate `2897de5` retains
the prior lifecycle/import fixes and fixes v19's terminal cold-session guard with a red/green
compiling mutant. Full `pnpm verify` passed: 799 tests (577 web + 222 bot). Immutable browser
verification passed 5 scenarios / 19 checks; report: `/private/tmp/cometa-foreground-browser-2897de5-4ZzXID/report.json`.
V19's continuous-progress visual preference was rejected after unchanged Chrome geometry/focus
and an explicit CLAUDE invariant. The candidate is not deployed.
Original v20 did not run because of session quota. Exact Opus 5 retry finished at `10:18Z`:
`clean`, zero findings, resolved source `2897de5`. Evidence is in
`/private/tmp/claude-paired-review-final-20260906-v20-retry/report.json` and `meta.json`.
The 9 signed checks passed again at `10:05Z`; live health and LOCAL/zero imports were reconfirmed
at `10:08Z`. Final packages `20260906T095601Z`/`20260906T095602Z` were uploaded at `10:19Z`;
local/remote checksums pass and extracted source trees are identical. Strict preflights are running;
neither release is activated yet.
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
  to Cometa.
- Caddy is the only public listener/TLS owner on Irena. Docker web is loopback-only on `8080/8443`;
  the retained `8443` Nginx TLS hop is temporary bridge compatibility. Legacy Certbot units stay
  disabled/inactive. Current B and previous A are source-clean; old manually patched C/D releases
  are historical migration evidence, not active rollback slots. The new data-persistence rollback
  rehearsal remains pending.
- Production uses the exact versioned Docker daemon policy and Caddy's caddy-owned Unix admin
  socket, mode `0200`, with `persist_config off` and `h1/h2`. Trusted inner TLS and real-IP gates,
  key-only SSH, UFW `22/80/443`, `jq 1.8.1`, stable health and TLS/API smoke passed.
- Both real Telegram Old profiles, Nikita and MetaFlexer, persisted compiled marker B. Nikita's
  438 existing rows were preserved exactly; MetaFlexer's 437 became 438 only through interest.
  Do not reset these snapshots or identify either profile as John Cometa from a display name.
- Current native QA limitation: inline coordinate clicks return `-10005` in Telegram Old and the
  separately owner-authorized main Telegram.app. Nikita's Cometa chat opened through Cmd+K/Return,
  but the English click failed again at `10:07Z`. AX open Mini App works. Both Old profiles retained
  their exact 438-row snapshot hashes at `10:05Z`. The Browser plugin lists no connected browsers;
  the request to connect one via Settings → Computer use and log in to Web Telegram is unanswered.
  Callback onboarding remains unverified; main Telegram and Web are explicitly authorized.
- Two local showcase compositions are ready: actual web screenshots and an explicitly illustrative
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
2. Inspect `git status` and preserve unrelated changes. The final review for `2897de5` passed at
   `10:18Z`: exact Opus 5 v20 retry is clean, zero findings. The original quota failure is historical;
   no further review wait is needed. The full 799-test gate and immutable browser 5-scenario /
   19-check pass are green. Check package parity and existing audit/secret/diff evidence. The owner
   asked to finish the overlong task; do not start another improvement or review cycle.
3. Recheck Irena, current/previous images, containers/restarts, `ledger_mode=local`, Caddy semantics,
   exact loopback bindings, quiesced renewal units, DNS and TLS/API smoke. The Docker/Caddy bridge
   is already installed; do not rerun its host-wide migration as the next normal release step.
4. Freeze one final source tree and package it under two NEW immutable release IDs. Compare the
   extracted source trees, strict-preflight both, prepare both, then activate A and B through the
   normal hardened lifecycle while ledger mode stays `local`. Both rollback slots must contain the
   final fix before first server activation. Superseded prepared `20260906T075300Z`/`20260906T075301Z`
   from `aab2dc0` must not be used or overwritten. Uploaded `20260906T092401Z`/`20260906T092402Z`
   from `de36540` and local `20260906T094101Z`/`20260906T094102Z` from `5838c51` are also superseded:
   never prepare or activate them. The final `2897de5` pair is `20260906T095601Z`/`20260906T095602Z`;
   both were uploaded at `10:19Z`, local/remote checksums and extracted source parity pass.
   Strict preflights are running; neither release is activated yet.
   Each new activation creates its normal root-only
   SQLite backup and passes immutable-image, health and inner/outer TLS/API gates.
5. Repeat real Telegram Old foreground/reopen, native-control and snapshot-preservation checks in
   Nikita and MetaFlexer. Verify the new compiled marker in both profiles and keep the existing
   438-row snapshots intact except for legitimate time-derived settlement. The owner authorized
   deploy and QA of these own profiles, including mock-bot messages and callbacks; unrelated
   external actions are not covered by that authorization.
   Coordinate inline clicks fail with `-10005` in Old and main Telegram; AX open works. Await the
   owner's response to connect a browser through Settings → Computer use / Web Telegram login,
   then finish the real callbacks. Main Telegram and Web are explicitly authorized.
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
