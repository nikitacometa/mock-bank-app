# Dedicated VPS deployment

This stack deploys the Cometa SPA, Telegram bot, bootstrap API, Nginx, and
Certbot on one dedicated Ubuntu 24.04 or 26.04 LTS VPS. It does not depend on the legacy
Hostinger shared proxy or any unrelated domain.

The migration deliberately has two gates: prepare the new origin first, then
change DNS and issue its trusted certificate. HTTP-01 cannot safely prove a
domain before public DNS reaches the new server.

## Runtime layout

```text
/srv/cometa-bank/
├── current -> releases/<release-id>
├── previous -> releases/<release-id>
├── backups/                 # root-only online SQLite backups
├── data/                    # UID 10001, bot SQLite database
├── deployments.jsonl        # image IDs and activation history
├── releases/<release-id>/   # immutable uploaded source
├── state/images/            # immutable release-to-image-ID manifests
├── state/renewal-bundle.release # immutable source release for the host worker
├── state/renewal-bundle.pending # crash-resumable host-worker migration journal
├── state/renewal-bundle.legacy-timer # temporary legacy timer-state journal
└── state/nginx/default.conf # atomic HTTP/HTTPS mode switch

/etc/cometa-bank/secrets/bot_token # UID 10001, mode 0600
/usr/local/sbin/cometa-bank-renew-certificates # stable host-owned entrypoint
/usr/local/libexec/cometa-bank-renew-certificates-worker # stable host-owned worker
/etc/systemd/system/cometa-bank-cert-renew.*   # stable host-owned units
/etc/systemd/system/cometa-bank-cert-renew.service.d/10-bundle-migration.conf
    # temporary fail-closed guard during the one-time legacy migration
```

Only ports 80 and 443 are published by Docker. The bot is reachable from Nginx
only through the internal Compose network. A second bridge supplies Bot API
egress; it is network isolation, not a destination allow-list. Restricting
Telegram by fixed IP would be brittle, so general bot HTTPS egress is an
explicit residual risk.

## 1. Package locally

The packager always runs the complete project verification, rejects production
token-shaped values and symlinked inputs, and emits a checksum beside the
credential-free archive.

```bash
./deploy/standalone/scripts/package-release.sh
```

Upload both generated files to the new server. Verify the SSH host fingerprint
out of band before accepting it for the first time.

```bash
scp /private/tmp/cometa-bank-<release-id>.tgz{,.sha256} <new-host>:/tmp/
```

## 2. Provision the host

Extract a temporary copy, run the provisioner with the actual SSH port, and
then extract the verified archive into its immutable release directory.
`provision-host.sh` follows Docker's official apt-repository method rather than
the convenience installer. It does not add a login user to the root-equivalent
`docker` group.

Before passing `--confirmed-key-login`, open and verify a second
key-authenticated SSH session as the intended sudo-capable login user and keep
the original session open. Confirm `sudo -n true` succeeds in that second
session. The provisioner changes the UFW policy, so the flag is an assertion
that this recovery path already works, not a request for the script to create
one.

```bash
cd /tmp
sha256sum --check cometa-bank-<release-id>.tgz.sha256
mkdir cometa-bank-bootstrap-<release-id>
tar -xzf cometa-bank-<release-id>.tgz -C cometa-bank-bootstrap-<release-id>
sudo cometa-bank-bootstrap-<release-id>/deploy/standalone/scripts/provision-host.sh \
  --apply --ssh-port 22 --confirmed-key-login
sudo install -d -m 0755 /srv/cometa-bank/releases/<release-id>
sudo tar -xzf cometa-bank-<release-id>.tgz \
  -C /srv/cometa-bank/releases/<release-id> --no-same-owner
```

After provisioning, configure OpenSSH to disable root, password, and
keyboard-interactive authentication, run `sudo sshd -t`, and reload SSH without
closing the working session. Verify one more fresh key-only login, then run:

```bash
sudo /srv/cometa-bank/releases/<release-id>/deploy/standalone/scripts/host-preflight.sh \
  --ssh-port 22
```

The preflight rejects password-capable SSH, unexpected UFW rules, unsupported
Docker/Compose versions, and any public TCP listener outside the actual SSH port
plus 80/443. The provider firewall should independently expose the same ports.

## 3. Prepare before DNS cutover

```bash
sudo /srv/cometa-bank/releases/<release-id>/deploy/standalone/scripts/release.sh prepare
curl --fail --header 'Host: euphoria.bot' http://<new-server-ip>/
```

`prepare` builds release-labelled local images with registry pulls disabled at
runtime. On the first install it starts only an HTTP SPA/ACME preview; the bot
token is not needed and the old production origin remains untouched.

## 4. Change DNS and enable TLS

Point the apex and `www` A records to the new IPv4. Remove stale AAAA records,
or point both names to the VPS IPv6 and pass it explicitly. After public DNS
converges:

```bash
sudo /srv/cometa-bank/releases/<release-id>/deploy/standalone/scripts/release.sh \
  issue-certificate \
  --no-email \
  --server-ipv4 <new-server-ip>
```

The command refuses mixed DNS, validates certificate expiry, both SANs, and the
certificate/private-key pair and trust chain before testing Nginx and switching
to HTTPS. Use `--email <acme-contact-email>` instead of `--no-email` when an ACME
contact address is available. It returns to a verified HTTP preview if the TLS
container does not become healthy.

## 5. Rotate the bot token and activate

Revoke the token previously exposed in chat and generate a new token in
BotFather. Never place it in chat, an environment variable, a command argument,
or a project file. The installer reads it from hidden TTY, validates `getMe`
against `@MyBankApp_Bot`, and writes a service-owned `0600` file.

```bash
sudo /srv/cometa-bank/releases/<release-id>/deploy/standalone/scripts/release.sh install-token
sudo /srv/cometa-bank/releases/<release-id>/deploy/standalone/scripts/release.sh activate
```

Activation verifies each release tag against its immutable image-ID manifest,
performs an online SQLite backup, and tests candidate plus rollback images
against a database copy before touching the live service. The candidate probe
forces a WAL checkpoint, then the host independently checks SQLite integrity and
matches the persisted schema contract before the rollback image can open the
copy. Both releases' immutable images are verified before that probe. Activation
then requires 31 continuous healthy seconds with zero container restarts,
verifies the SPA and the JSON bootstrap boundary locally over trusted TLS, then
commits the release links. `prepare` verifies the currently recorded host-owned
renewal bundle and rejects pending ACME recovery before upgrading it. The host
migration journal is written before file replacement, the worker is installed
before its wrapper, and the immutable source release is recorded only after the
complete bundle verifies. The first upgrade from the legacy release-local
entrypoint is allowed only when every installed legacy file still matches
`current`. It first installs a persistent systemd condition guard, journals the
timer's enablement, and disables/stops the timer and service. A process kill or
reboot therefore cannot launch the legacy worker inside the migration window;
rerunning the same `prepare` resumes the journal and restores the prior timer
state only after the stable bundle verifies. Later upgrades fail closed on any
host-file drift.
Image rollback preserves this newer hardened worker and verifies it against the
recorded release instead of downgrading it to the rollback target. The wrapper
and unchanged systemd units still match the newer release sources, so the legacy
rollback command can safely switch back to that release. Do not remove the
release named by `state/renewal-bundle.release`. Before every renewal, the
stable entrypoint independently rejects an incomplete migration and compares
its entrypoint, worker, service, and timer with that recorded immutable source.
The worker also takes its Certbot service and volume contract from the recorded
release, never from a rolled-back `current` symlink.
Image rollback also keeps the newly validated token; it never revives a
credential already revoked by BotFather.

`current` and `previous` are each replaced atomically, but Linux cannot rename
both symlinks and switch Docker runtime in one filesystem transaction. A host
power loss inside that narrow commit window can require manual reconciliation
from `deployments.jsonl`; the normal failure paths are checked and automatic.

## Operations

```bash
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh status
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh rollback
sudo /srv/cometa-bank/current/deploy/standalone/scripts/release.sh rollback --apply
sudo systemctl status cometa-bank-cert-renew.timer
sudo systemctl start cometa-bank-cert-renew.service
sudo /usr/local/sbin/cometa-bank-renew-certificates --recover-only
```

The renewal service shares the deployment lock and atomically persists the prior
Certbot lineage plus served leaf inside the existing `letsencrypt` Docker volume
at `.cometa-bank-renewal/pending-recovery` before Certbot can mutate that volume.
This keeps the already-installed host-owned unit byte-identical across image
rollback; `PrivateTmp` can discard its scratch files without discarding recovery
state. `SIGINT`, `SIGTERM`, and `SIGHUP` stop the owned Certbot containers and
roll back immediately. After `SIGKILL` or power loss, the next run reaps only
containers carrying the expected Compose project/service labels, restores and
verifies the pending lineage, and only then captures a new baseline. The bundle
is retired only after expiry, SANs, key pair, system trust, `nginx -t`, reload,
and SHA-256 served-leaf probes for both SNI hostnames pass. A corrupt or
unverifiable recovery bundle fails closed for manual repair instead of being
replaced with a new baseline.
`prepare`, certificate issuance, activation, and rollback refuse to proceed
while a deterministic Certbot container or any recovery bundle/staging path is
present. Run the `--recover-only` command shown above, inspect its result, and
then rerun the interrupted release command. Recovery-only mode never starts a
new renewal.
The first production cycle intentionally omits HSTS until rollback, renewal,
and real Android/iOS Telegram WebView acceptance have all passed.

After activation, open `/mybots` > `@MyBankApp_Bot` > `Bot Settings` >
`Configure Mini App` > `Enable Mini App` in BotFather, set the Main Mini App URL
to `https://euphoria.bot/`, and verify the photo and About/Description. Configure
the menu button with `/setmenubutton`; the bot also synchronizes it per user
after `/start`. Complete RU and EN onboarding, every currency/name branch,
opening from the menu button, preference bootstrap, and one pass each in current
Telegram Android and iOS clients before retiring the old VPS.
