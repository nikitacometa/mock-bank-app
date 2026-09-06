# Dedicated VPS deployment

Cometa runs on one dedicated Ubuntu VPS. Caddy owns public HTTP, TLS, and ACME.
The release containers are private to the host: Nginx listens on loopback and
the bot has no host port.

The current migration topology is intentionally transitional:

```text
Internet
  -> Caddy :80/:443
  -> Nginx 127.0.0.1:8443 (HTTPS compatibility hop)
  -> SPA or bot API on the internal Compose network
```

Nginx also binds `127.0.0.1:8080`. Two source-clean rollback releases now exist,
but moving Caddy to `8080` remains a separate migration: the complete inner API
policy and rollback behavior must be preserved. Caddy verifies the retained
inner certificate and SNI through the host trust store; it also owns the public
certificate and renewal.

## Verified checkpoint — 2026-09-06

The final pair is B `20260906T181102Z` and A `20260906T181101Z`, both from
`bd43566`. A activated at `18:15:52Z`, B at `18:17:35Z`. Both passed immutable
image/perimeter checks, the 31-second stable-health window and inner/outer TLS/API
smoke. Both packages passed 815 tests and extracted-source/checksum parity;
Linux CI run `34050857794` passed. Both original Telegram Old profiles were
normally reopened and imported once, preserving each exact 438-row history and all
balances. The separate John Cometa Web profile imported its own 437-row baseline.

Ledger mode is `server`. The guarded one-way switch completed at `18:20:35Z`, including
the durable marker, command setup, bot restart, stable health and both TLS/API boundaries.
Backup: `backups/20260906T181909Z-before-ledger-mode-server.sqlite`, root-owned `0600`.
Earlier WAL and Bash/SQL-quoting failures stopped safely before activation and are fixed.
The regression executes the actual shell-parsed verifier and switch against scratch SQLite;
restoring the old quoting reproduces the exact syntax error. A separate read-only Docker
probe passed all ten checks across both runtime images using synthetic data only.

Live John Web QA passed income, expense, two monthly backfill entries, pause, account add,
adjust, close and restore. A THB 101 expense against THB 100 was rejected with all three
canonical states unchanged. The QA account is closed at zero; the QA rule is paused.
Both original profiles remain revision 1 with their exact imported histories.

The guarded B → A → B rehearsal passed at `18:53:18Z` and `18:56:24Z`.
Full canonical states, revisions, operations, balances and history hashes matched before
and after both rollbacks for all three profiles (438 / 438 / 444 rows; revisions 1 / 1 / 11).
Authority stayed `server`; no database restore was used. Current is B `181102`, previous A
`181101`. The existing secret retained UID/GID `10001` and mode `0600`.

The owner waived further Opus review for this scoped completion. This is a waiver,
not a clean independent review. Native inline controls remain inaccessible to automation;
the owner's manual-client waiver is not a tested native or Android/iOS pass.

Live SSH configuration resolves `irena` to user `irena` (UID/GID `1001`). Use
`ssh -G irena` as the source of truth. The earlier evidence below is historical.

### Earlier recovery and activation evidence

**Recovery completed:** current is B `20260906T104102Z`, previous is A
`20260906T104101Z`, both from source `774f0ae`. A activated at `12:31:30Z`, B at
`12:33:21Z`. Each passed the ordinary 31-second stable-health window, immutable
image/perimeter checks and inner/outer TLS/API smoke. Both services are healthy,
with zero container restarts and `bot_polling_ready`; repeated profile-setup `429`
no longer blocks startup. Full status and ledger-mode status exited 0 after B:
`/private/tmp/cometa-104102-live-status.log`.

Both packages passed 815 tests (577 web + 238 bot), local/remote checksum checks,
extracted source parity, strict preflight and guarded `prepare --repair-bot`.
Linux CI for `774f0ae` passed in run `34032518573` at `12:16:08Z`.
Root-only WAL-safe backups were created before A at `12:29:58Z` and before B at
`12:32:05Z`; both were verified through both bot images. They remain on the same VPS.

The owner explicitly authorized this narrow emergency recovery without the
unavailable independent Opus review. That review remains **blocked, not clean**:
Anthropic disabled the organization's Claude Code subscription access, and the
runner exited without an accepted report. Evidence:
`/private/tmp/claude-paired-review-recovery-20260906/raw.json`. The exception covers
only the `774f0ae` recovery deployment, not later changes or authority activation.

Ledger mode remains `local`. Read-only parity at `14:36:25Z` confirms both existing
Old profiles now retain compiled marker `104102`, their exact 438-row histories
and balances, and zero canonical imports. The owner accepted the outstanding
manual native-control/foreground check as an assumption, not a tested pass.
Do not reset or replace either original snapshot with a fresh browser fixture.

The owner authorized server activation, but `ledger-mode server --apply` at
`14:37:32Z` failed **before the mode switch or bot restart**. The durable backup
`backups/20260906T143732Z-before-ledger-mode-server.sqlite` is retained, root-owned
at mode `0600`, with `quick_check=ok` and mode `local`. Its WAL header prevents
the single-file, read-only container probe from opening the backup without WAL
sidecars (`SQLITE_CANTOPEN`, code 14).

A local, not-yet-deployed fix converts only the disposable `.compat` copy to
`DELETE` journal mode before both image probes. Live SQLite and the durable
backup remain WAL; all container read-only restrictions remain intact. The full
815-test gate passes, including a real-SQLite regression and conversion-failure
cases. Removing the conversion reproduces code 14; restoring it passes. A
synthetic copy also passed the exact read-only probe through both current
production images, with its original unchanged. Logs:
`/private/tmp/cometa-ledger-wal-normalization-{focused,mutant,verify}.log`.
The owner explicitly waived independent Opus review for this existing WAL operator
fix and authorized scoped completion. This is a separate exception from the earlier
`774f0ae` recovery waiver. The retry recorded in
`/private/tmp/claude-paired-review-wal-backup-retry-20260906/attempt.md` produced no
report and was stopped by the operator after ten minutes; it was not clean and did
not reconfirm the prior organization-access error. Proceed through the normal
immutable release lifecycle without another Opus attempt. Fix deployment and server
activation are not yet verified complete.

The owner logged into an explicitly requested, separate headed Chrome profile.
Real Telegram Web passed English → KZT → ready card → Open Cometa → embedded
Mini App on compiled release `104102`, with four accounts and 437 fresh rows.
Its John Cometa namespace is distinct from both previously checked Old profiles;
this does not satisfy their final-build preservation gate. Private QA artifacts:
`/private/tmp/cometa-telegram-web-qa.Mtuner/`. Never publish or export its login profile.
Focused Web QA also passed merchant search/Pending, income filtering, RU/EN,
display-only KZT → USD → KZT, overdraft prevention, draft-preserving foreground,
native Back/Main controls, `/help` and close/reopen from the new bot reply.
At `13:03:48Z`, all 437 transaction and four-account hashes still matched the
pre-test baseline; English/KZT and compiled `104102` were retained. No transfer
was submitted. The later `14:36:25Z` parity check above supersedes the Old clients'
earlier `071101` marker observations; canonical imports remain pending.
The Browser plugin still has no binding; this authorized Playwright instance is
independent of the owner's existing browser and Telegram installations.

Live SSH configuration now resolves `irena` to user `irena` (UID/GID `1001`).
Use `ssh -G irena` as the source of truth, not historical `metaflexer` examples.

The earlier checkpoints below are historical, not current health or release claims.

### Earlier release evidence

Source `5774b01` was deployed as current B `20260906T071101Z`, with previous
A `20260906T071100Z`. Both releases are authority-capable. The persisted ledger
mode is still `local`; server activation and canonical imports have not run.

- Docker perimeter apply passed at `07:15:41Z`; Caddy hardening passed at `07:17:30Z`.
- A activated at `07:22:17Z`, then B at `07:23:53Z`, with stable health and
  inner/outer TLS/API smoke. Key-only SSH, UFW `22/80/443`, loopback `8080/8443`,
  no bot host port, exact daemon policy and `jq 1.8.1` were verified.
- Caddy now uses its `0200` Unix admin socket, `persist_config off`, and `h1/h2`.
  Trusted inner TLS and client-IP recovery are active; legacy Certbot units stay quiescent.
- Root-only WAL-safe backups were created before A at `07:20:46Z` and before B at
  `07:22:22Z`, under `/srv/cometa-bank/backups` on the same VPS.
- Both own Telegram Old profiles, Nikita and MetaFlexer, persisted B's compiled
  client marker. Nikita's 438 rows were preserved exactly; MetaFlexer's 437 rows
  gained only one interest row. These profiles were not identified as John Cometa.
- Ten isolated production-browser checks passed. Real MetaFlexer foreground QA
  then exposed a lifecycle self-abort leaving the Mini App `read_only`.

Candidate `2897de5` retains those foreground/coordinator/import-cutover fixes and
resolves all three confirmed v18 findings: truthful RU/EN pending copy on the
same card, accessible focus/announcement via `aria-disabled` plus a click guard,
and first SDK discovery at 16 seconds when the SDK appears at 15 seconds after
the retry ladder is exhausted. Stale timers are cleared while request budgets
and known-identity cooldown remain intact. CLAUDE invariants were committed
separately as `ae9c65e`.

Full `pnpm verify` passed: 799 tests (577 web + 222 bot). V19's terminal cold-session
guard was fixed with a red/green compiling mutant. Its continuous-progress visual
preference was rejected after unchanged Chrome geometry/focus and an explicit
CLAUDE invariant. Immutable real-browser verification passed 5 scenarios / 19 checks:
`/private/tmp/cometa-foreground-browser-2897de5-4ZzXID/report.json`.
The candidate was later deployed in the failed pair described above. Original reviewer v20 did not run because of session quota;
`/private/tmp/claude-paired-review-final-20260906-v20/raw.json` reports reset
`17:10 Asia/Bangkok`. The exact Opus 5 retry finished at `10:18Z`: `clean`, zero
findings, resolved source `2897de5`. Evidence:
`/private/tmp/claude-paired-review-final-20260906-v20-retry/report.json` and `meta.json`.
Actual model is `claude-opus-5`; requested effort xhigh, verified effort unobservable.
Nine signed checks passed again at `10:05Z`; live health and LOCAL/zero imports
were reconfirmed at `10:08Z`.

This was not final Telegram acceptance. Subsequent releases use the already-hardened
normal lifecycle with two new identical-source releases; do not repeat the one-time
Docker/Caddy migration. Do not activate or overwrite superseded prepared releases
`20260906T075300Z`/`20260906T075301Z` from `aab2dc0`. Uploaded
`20260906T092401Z`/`20260906T092402Z` from `de36540` are also superseded: do not
prepare or activate them. The unused `5838c51` pair `20260906T094101Z`/`20260906T094102Z`
is also superseded. The final `2897de5` pair is `20260906T095601Z`/`20260906T095602Z`:
both packages were uploaded at `10:19Z`, local/remote checksum checks pass, and their
extracted source trees are identical by `diff -qr`. A package SHA-256:
`d76e6c535e9e77192d66272011473fbcb221ef38ea2d0314847d0b71955dbe93`.
B package SHA-256:
`547025dc4bcf77a465bacb8a89aaf8b02025fb5e0eff18eaf4d6940c0c488175`.
Strict preflights passed; A activated, but B activation and automatic rollback A
left the bot unhealthy. The owner-approved `774f0ae` recovery pair supersedes this
incident; do not reactivate its failed images as a fix. Keep authority local until both
rollback slots contain the final fix and both native profiles pass new compiled
markers, foreground/reopen and snapshot preservation.
The new current→previous→current data-persistence rehearsal and Android/iOS acceptance
remain open. `docs/handoff.md` is the evidence log; `docs/next-phase.md` is the resume order.

Native inline coordinate clicks return `-10005` in Telegram Old and the separately
owner-authorized main Telegram.app. Nikita's Cometa chat opened via Cmd+K/Return,
but the English click failed again at `10:07Z`. AX open Mini App works; both Old
profiles retained their exact 438-row snapshot hashes at `10:05Z`. The Browser
plugin lists no connected browsers. The later separate-browser login and real
John Cometa Web evidence supersede this earlier UI-access blocker, but do not
establish preservation for the two existing Old profile namespaces.

## Runtime layout

```text
/srv/cometa-bank/
├── current -> releases/<release-id>
├── previous -> releases/<release-id>
├── backups/                 # root-only online SQLite backups
├── data/                    # UID 10001, bot SQLite database
├── deployments.jsonl        # durable release and ledger-mode audit events
├── releases/<release-id>/   # immutable uploaded source
├── state/images/            # immutable release-to-image-ID manifests
└── state/nginx/default.conf # active loopback Nginx policy

/etc/caddy/Caddyfile                 # host-owned public edge
/var/lib/caddy/.local/share/caddy/admin.sock # caddy-owned admin socket, mode 0200
/etc/docker/daemon.json              # exact versioned local-only daemon policy
/etc/cometa-bank/secrets/bot_token  # UID 10001, mode 0600
```

The legacy `cometa-bank-cert-renew.timer` must be disabled and inactive. Its
service may remain installed only as static and inactive. Active release flows
must never issue a certificate, install the old renewal bundle, or enable those
units.

## Edge contract

`host-preflight.sh` fails unless all of these statements are true:

- Docker Engine is `28.0.0` or newer, where localhost-published ports cannot
  be reached by peers on the same L2 segment.
- Caddy is enabled, active, and the exclusive non-loopback TCP listener on
  `80` and `443`.
- The installed Caddy config has one scoped route for each of `euphoria.bot`
  and `www.euphoria.bot`, preserves `Host`, and proxies to
  `https://127.0.0.1:8443` with matching SNI and normal certificate verification.
- Caddy exposes only HTTP/1.1 and HTTP/2. UDP `443` stays closed because UFW
  intentionally allows TCP only during this bridge.
- Caddy persists no autosaved config and exposes exactly one admin listener:
  `unix//var/lib/caddy/.local/share/caddy/admin.sock|0200`, owned by
  `caddy.service`. The legacy TCP admin listener on `127.0.0.1:2019` is closed,
  and the live config read through the socket exactly matches the installed
  Caddyfile.
- Neither scoped route adds HSTS.
- rendered Compose and the running web container expose exactly
  `127.0.0.1:8080 -> 8080` and `127.0.0.1:8443 -> 8443`.
- the bot exposes no host port, SSH is key-only, UFW is default-deny, and its
  only inbound allows are SSH plus TCP `80/443`.
- the live Nginx policy restores the client address only from the loopback and
  private Docker proxy ranges before applying per-IP limits.
- the legacy renewal units are quiesced.
- Docker was started only through systemd socket activation with the single
  daemon host `-H fd://`; `/run/docker.sock` is the only API listener and has
  no non-root group members. Release commands pin `/usr/bin/docker`, the local
  socket, and a versioned empty CLI config instead of trusting shell context.
- `/etc/docker/daemon.json` is the exact versioned three-key policy:
  `allow-direct-routing=false`, `iptables=true`, `ip6tables=true`, and its
  timestamps predate the running daemon process.

The installed Caddyfile is checked semantically, not byte-for-byte. Never
replace the whole host file merely to match
`deploy/standalone/caddy/Caddyfile`; it may contain unrelated domains.

`jq` is a required host dependency because the Compose and Caddy contracts are
validated from structured output.

## Package two identical-source releases

Run the complete project gate once, then package the same clean source under
two distinct UTC release IDs. The packager runs `pnpm verify` again, rejects
credential-shaped content and symlinked inputs, and emits a checksum next to
each credential-free archive. It packages the live allowlisted source files,
not a Git commit export: freeze the source and included documentation before
creating both archives.

```bash
./deploy/standalone/scripts/package-release.sh --release-id <bridge-a>
./deploy/standalone/scripts/package-release.sh --release-id <bridge-b>
```

Both IDs use `YYYYMMDDTHHMMSSZ`. Extract the archives locally and compare their
source trees before upload. Only the build-time release marker may differ in
the resulting images.

```bash
scp /private/tmp/cometa-bank-<bridge-a>.tgz{,.sha256} irena:/tmp/
scp /private/tmp/cometa-bank-<bridge-b>.tgz{,.sha256} irena:/tmp/
```

Verify the SSH host fingerprint through the existing `irena` alias. Do not
place the bot token in an archive, environment variable, argument, log, or
documentation.

## Existing-host prerequisites

This lifecycle supports upgrades of the existing, healthy Irena runtime.
It deliberately rejects a host without `current`, a
running web container, and the installed edge contract. It is not a complete
first-install bootstrap path.

`provision-host.sh` can install base Docker, Caddy, `jq`, SQLite and UFW
dependencies on Ubuntu 24.04 or 26.04, but that alone does not create the
required application runtime. Design and test a separate bootstrap mode before
using this stack on an empty VPS. Do not weaken the migration preflight to make
an empty host pass.

For the existing Irena host, install only a missing declared dependency, then
validate the installed Caddy routes in place. Do not overwrite unrelated host
blocks. The legacy Cometa Certbot timer and service must remain quiesced.

## Install an uploaded release

For each bridge archive, verify the checksum before extracting it into its
final immutable directory:

```bash
cd /tmp
sha256sum --check cometa-bank-<release-id>.tgz.sha256
sudo install -d -m 0755 /srv/cometa-bank/releases/<release-id>
sudo tar -xzf cometa-bank-<release-id>.tgz \
  -C /srv/cometa-bank/releases/<release-id> --no-same-owner
```

During the original bridge, strict preflight intentionally failed until the
legacy trust, admin, client-IP and Docker-daemon semantics were migrated. That
one-time prerequisite is complete on Irena; later releases go directly through
strict preflight rather than repeating the migration below.

## Normal release cycle on hardened Irena

After final review, upload and checksum-verify two new identical-source archives.
Use fresh `<final-a>` and `<final-b>` directories; never overwrite an old release.
Prepare both before activating either, and keep ledger mode `local` throughout:

```bash
sudo /srv/cometa-bank/releases/<final-a>/deploy/standalone/scripts/host-preflight.sh --ssh-port 22
sudo /srv/cometa-bank/releases/<final-b>/deploy/standalone/scripts/host-preflight.sh --ssh-port 22
sudo /srv/cometa-bank/releases/<final-a>/deploy/standalone/scripts/release.sh prepare
sudo /srv/cometa-bank/releases/<final-b>/deploy/standalone/scripts/release.sh prepare
sudo /srv/cometa-bank/releases/<final-a>/deploy/standalone/scripts/release.sh activate
sudo /srv/cometa-bank/releases/<final-b>/deploy/standalone/scripts/release.sh activate
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh status
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh ledger-mode status
```

Require current B / previous A to contain the final fix, with normal activation
backups, stable health and both TLS/API boundaries passing. Repeat compiled-marker,
foreground/reopen and snapshot-preservation checks in both real profiles before
the first one-way server activation. No Docker/Caddy migration or token replacement
is part of this normal release cycle.

### Prepare a bot startup repair

If the current bot is running with its immutable image but is unhealthy or has
restarted, use the new repair release's `release.sh prepare --repair-bot`.
This explicit preparation-only flag waives only current bot health and restart
count. The existing current release, singular running bot, immutable image
manifest, healthy web, Docker/Caddy perimeter, trusted inner/outer TLS and every
unauthenticated API rejection remain mandatory. An absent bot, unknown image or
broken API boundary still blocks preparation.

Preparation builds and checks candidate images without recreating live services.
Then use ordinary `activate`; its backup, health stability, zero-restart and
TLS/API gates are unchanged. The repair flag is rejected for all other actions.

## Install the Docker daemon perimeter

Run this one-time installer from extracted bridge A before `harden-edge`. The
first command is a dry run; the second is the applying form and performs one
controlled `docker.service` restart:

```bash
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/install-docker-perimeter.sh
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/install-docker-perimeter.sh --apply
```

The installer requires Docker Engine 28 or newer and refuses Docker CLI target
overrides. It binds the daemon to the systemd-owned local Unix socket through
the single `-H fd://` host, installs the exact versioned
`deploy/standalone/docker/daemon.json`, and then proves the original web and bot
container identities, restart counts, images, networks, loopback ports, SQLite
database, and both HTTPS boundaries for 31 continuous seconds.

The restart is protected by a root-only durable journal at
`/etc/docker/.cometa-bank-perimeter.pending`. The journal records the source
hash, original current release, exact container/restart identities, whether the
config was originally absent, and an `install` or `rollback` phase. Atomic
producer candidates use the exact `.pending.next` and
`daemon.json.cometa-bank.next` paths. An applying rerun may finish or discard
only an unambiguous, root-owned, non-writable candidate; unexpected files,
owners, shapes, phases, concurrent recovery markers, or mixed state fail closed
for manual inspection. If the safe restart fails after settling, the recorded
rollback phase restores the original absent-config state and revalidates the
same application perimeter before retiring the journal.

## Controlled Irena bridge

This bridge completed on 2026-09-06 with the A/B pair recorded above. The old
C/D directories were manually patched to loopback ports and contained the old
Certbot-aware operator; they are no longer current/previous. The following
sequence documents the completed migration and its recovery rules, not the next
release task. Its replacement of both rollback slots used one maintenance cycle:

1. Extract both A and B. From A, dry-run and apply
   `install-docker-perimeter.sh`; this includes one controlled Docker restart.
2. From A, validate the legacy edge with `harden-edge`, then apply the
   target-scoped hardening only after the deploy confirmation.
3. Run strict host preflight for both releases and `prepare` both before
   activating either.
4. Keep the persisted ledger mode `local`; do not import a bank snapshot.
5. Activate A, inspect health, then activate B without an ordinary rollback or
   unrelated lifecycle operation between them.
6. Confirm B is `current`, A is `previous`, both image manifests match, and
   inner plus outer smoke pass.

```bash
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/install-docker-perimeter.sh
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/install-docker-perimeter.sh --apply
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/release.sh harden-edge
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/release.sh harden-edge --apply
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/host-preflight.sh --ssh-port 22
sudo /srv/cometa-bank/releases/<bridge-b>/deploy/standalone/scripts/host-preflight.sh --ssh-port 22
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/release.sh prepare
sudo /srv/cometa-bank/releases/<bridge-b>/deploy/standalone/scripts/release.sh prepare
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/release.sh activate
sudo /srv/cometa-bank/releases/<bridge-b>/deploy/standalone/scripts/release.sh activate
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh status
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh ledger-mode status
```

`harden-edge` first proves that both target Caddy routes are either fully legacy
or fully strict and that the Nginx real-IP block is absent or exact. It validates
both candidates before mutation, removes bypasses only inside the two Cometa
blocks, preserves unrelated host route blocks, and changes the shared Caddy
protocol policy to host-wide `h1/h2`. It also disables Caddy config persistence
and moves the admin API from legacy loopback TCP to the caddy-owned Unix socket
with mode `0200`. The transition reloads through whichever exact admin endpoint
is currently live, then requires the post-reload endpoint, listener owner, and
canonical live config to match the installed file. It recreates only the web
container because the Nginx policy is a single-file bind mount. Recovery copies
live under a root-only state directory and survive a failed automatic restore.
Their marker binds the immutable operator release, original current release and
both snapshot hashes; the snapshots are flushed before the marker is published.
While that marker exists, every other lifecycle action fails closed. Injected
apply, recovery, hash-tamper and interrupted-retry cases prove that the originals
remain recoverable. Re-running the recorded operator's `--apply` reconciles a
crash between atomic file replacement and runtime reload even if web is absent.

If A activation fails, its new script restores the prior runtime. If an explicit
A-to-legacy rollback is required, continue every operator command through A's
immutable path until A/B is restored; A hardens the legacy Nginx config before
installing it:

```bash
sudo /srv/cometa-bank/releases/<bridge-a>/deploy/standalone/scripts/release.sh status
```

Never run lifecycle commands from legacy C or D during this window: those
scripts can revive the retired renewal owner. After B succeeds, ordinary
`current`-based operations and B-to-A-to-B rollback are source-clean again.

Activation verifies immutable image IDs, creates and checks an online SQLite
backup, tests candidate and rollback images against a copy, requires 31
continuous healthy seconds with zero restarts, and probes both boundaries:

- inner Nginx at `127.0.0.1:8443` with normal hostname, chain, and expiry checks;
- outer Caddy at `127.0.0.1:443` with normal certificate verification.

Before a repair or release recreate, the script accepts zero or one running
container per service but validates every container and named network that
exists; missing networks can only be recreated from the verified source model.
Source and runtime must use the exact `bridge` topology:
`public + edge` for web, `edge + egress` for bot, and an internal `edge` only.
The Compose project is exactly `cometa-bank`; each container's primary network
must be one of its attachments, and network driver options contain only the
declared `enable_icc` value. Direct-routing and custom IPAM drift are rejected.
After recreate, the strict gate requires exactly one web and bot container with
the immutable images, exact attachments and loopback bindings; the bot port map
must remain empty. An interrupted edge-hardening retry may repair a missing web,
but refuses host mutation unless the release-pinned bot is singular and healthy.
Activation and
rollback flush the deployment directory after each symlink rename, so the
durable intent can reconcile only the recorded before, between or complete pair.

Both probes cover the SPA, release alias, bootstrap, and every authority API
route exposed by that release. A legacy release is probed only for its legacy
bootstrap endpoint.

`current` and `previous` are individually atomic symlink replacements. Before
either two-link activation or rollback commit, the operator writes and flushes a
root-only intent. A repeated `activate` or `rollback --apply` accepts only the
three possible interrupted link states, restores the intended runtime/config,
completes both links, records the audit event, and then retires the intent.
Rollback recovery is accepted only from the immutable release that was current
when its intent was armed.
Other lifecycle commands fail closed while an intent is pending.

## Bot token

The existing test token may remain for the owner-approved test cycle. Before
any non-test use, fix and test the dormant restore portability issue below,
then revoke it in BotFather and install the replacement through the hidden-TTY boundary:

```bash
sudo /srv/cometa-bank/releases/<release-id>/deploy/standalone/scripts/release.sh install-token
```

The installer validates `getMe` against the configured bot identity and
atomically writes a UID `10001`, mode `0600` regular file. Image rollback
preserves the installed file and never restores a revoked credential.

Deferred portability issue: `deploy/bot/install-secret.sh:146`, in
`restorePrevious`, uses `install -o 10001 -g 10001`. Irena's uutils `0.8.0`
rejects that form because UID/GID `10001` have no NSS entries. The normal
installer path is unaffected and the bridge did not change the current token.
Before rotation, replace that restore copy with root-owned installation followed
by numeric `chown`, and verify it on isolated scratch files without touching the
live credential.

## Operations

After the clean A/B bridge:

```bash
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh status
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh rollback
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh rollback --apply
```

Mutating lifecycle commands, `status`, and ledger-mode gates recheck the Caddy
edge, loopback runtime, quiesced legacy units, release manifests, service
health, and both HTTPS boundaries. The non-applying rollback command validates
the edge and both release source contracts, then prints its plan; the applying
form runs the full backup, image, health, and smoke gates. App rollback does not
mutate the public edge or certificate owner.

## Enable server ledger authority

This one-way transition has completed on the final identical-source pair. Both original
Old snapshots were imported normally, once each, after observing compiled marker `181102`.
John Web is a third independent profile, not a substitute for either original-device import.
The commands below document the guarded operator interface; do not repeat activation as a
routine restart and never attempt to return the live database to local authority.

```bash
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh ledger-mode status
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh ledger-mode server
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh ledger-mode server --apply
```

The dry run repeats the complete preflight. `--apply` creates a root-only,
WAL-safe SQLite backup, verifies a disposable DELETE-mode copy through both bot
images without changing the durable backup's WAL mode, fsyncs the backup
and audit journal, switches the one persisted marker in a parameterized SQLite
transaction, and restarts the current bot. Startup republishes the mutation
commands only after the durable `server` marker exists. The operator then
requires the same 31-second health window and inner/outer API smoke.

There is no command to return to `local`. A failed post-commit audit or health
gate never reverses authority. Re-running `server --apply` records a durable
reconciliation event, restarts the bot, and repeats the gates without mutating
ledger data.

## Acceptance evidence and client boundary

The live server checks now cover:

- three isolated canonical snapshots: one real Web writer and two unchanged original profiles;
- one-off income and expense, including overdraft rejection;
- monthly recurrence with UTC backfill and future pause behavior;
- add, adjust, close, and restore account flows;
- restart and B-to-A-to-B persistence;
- preservation of the original device snapshots and the separate standalone web boundary.

The owner explicitly authorized mock-bot QA in the own Nikita and MetaFlexer
profiles, including messages, callbacks and screenshots, and logged into the separate
John Web profile for real-client QA. Do not request blanket approval again for each
such step; unrelated external actions are outside that authorization. The owner waived
remaining manual native-control/foreground checks. Native inline callbacks remain
inaccessible to automation, so two completed native write journeys are not claimed.
Browser emulation does not replace Android and iOS Telegram WebView acceptance.

The root README now contains actual app screenshots and three real Telegram Web
captures in one row. Their journeys passed in the live John profile; they are not
Android/iOS screenshots. Provenance is in `docs/assets/showcase/README.md`.

The same-host SQLite backup is not disaster recovery. Encrypted offsite backup,
retention monitoring, and an epoch-rotating restore drill are deferred. A later
task will also move Caddy to loopback HTTP and delete the redundant inner
certificate, Certbot volume, inactive units, and unreachable legacy renewal
code in a separate post-bridge migration; the two clean rollback slots alone do
not authorize changing that retained API/TLS policy.
