# Hostinger deployment

Target layout:

```text
/home/metaflexer/euphoria.bot/
├── current -> releases/<release-id>
├── previous -> releases/<previous-release-id>
└── releases/<release-id>/
```

The shared `cometa-proxy` must mount the host directory read-only at
`/var/www/euphoria.bot`. Use `nginx/euphoria.bot.bootstrap.conf` only while the
apex + `www` ACME certificate is being issued. Once the certificate exists,
`nginx/euphoria.bot.maintenance.conf` is the first TLS-valid rollback target;
only then replace it with `nginx/euphoria.bot.conf`.

## Packaging

Build the archive without macOS AppleDouble metadata and reject it before upload
if any `._*` or `.DS_Store` entry slipped through:

```bash
set -Eeuo pipefail

release_id='REPLACE_WITH_RELEASE_ID'
archive="/private/tmp/cometa-bank-${release_id}.tgz"

COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --exclude='._*' \
  --exclude='*/._*' \
  --exclude='.DS_Store' \
  --exclude='*/.DS_Store' \
  -czf "$archive" \
  -C dist .

archive_listing="$(tar -tzf "$archive")"
if grep -Eq '(^|/)\._|(^|/)\.DS_Store$' <<<"$archive_listing"; then
  printf 'ERROR: macOS metadata found in %s\n' "$archive" >&2
  exit 1
fi
```

Inspect the listing and checksums before upload. Extract only into a fresh
`releases/<release-id>` directory; never unpack over `current`.

DNS for both apex and `www` already points at Hostinger. Keep each previous release
for rollback. The original Namecheap redirect is not a safe rollback target;
rollback must keep a TLS-valid Hostinger vhost and repoint `current`.

## Release switch and rollback

Extract and verify the new build under `releases/<release-id>` before changing
either live symlink. Both symlinks use relative `releases/...` targets. Run the
switch from one fail-fast SSH shell after replacing `<release-id>` with the exact
new release ID:

```bash
set -Eeuo pipefail

deployment_root=/home/metaflexer/euphoria.bot
release_id='REPLACE_WITH_RELEASE_ID'
new_target="releases/${release_id}"
current_target="$(readlink "${deployment_root}/current")"

[[ "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ "${current_target}" =~ ^releases/[0-9]{8}T[0-9]{6}Z$ ]]
test -d "${deployment_root}/${current_target}"
test -f "${deployment_root}/${current_target}/index.html"
test -d "${deployment_root}/${new_target}"
test -f "${deployment_root}/${new_target}/index.html"
test "${current_target}" != "${new_target}"

ln -sfnT "${current_target}" "${deployment_root}/previous.next"
ln -sfnT "${new_target}" "${deployment_root}/current.next"
mv -Tf "${deployment_root}/previous.next" "${deployment_root}/previous"
mv -Tf "${deployment_root}/current.next" "${deployment_root}/current"

test "$(readlink "${deployment_root}/previous")" = "${current_target}"
test "$(readlink "${deployment_root}/current")" = "${new_target}"
```

Each `mv -Tf` is an atomic rename in the symlink directory. Updating `previous`
before `current` keeps the served release unchanged if the sequence stops early;
the prepared `current.next` remains enough to inspect or finish the switch. This
is an ordered pair of atomic renames, not a false claim that two pathnames change
in one filesystem transaction.

Rollback swaps the two validated targets with the same mechanism. Prepare both
temporary links before moving either one, update `previous` first, and switch
live traffic by replacing `current` last:

```bash
set -Eeuo pipefail

deployment_root=/home/metaflexer/euphoria.bot
current_target="$(readlink "${deployment_root}/current")"
rollback_target="$(readlink "${deployment_root}/previous")"

[[ "${current_target}" =~ ^releases/[0-9]{8}T[0-9]{6}Z$ ]]
[[ "${rollback_target}" =~ ^releases/[0-9]{8}T[0-9]{6}Z$ ]]
test "${current_target}" != "${rollback_target}"
test -f "${deployment_root}/${current_target}/index.html"
test -f "${deployment_root}/${rollback_target}/index.html"

ln -sfnT "${current_target}" "${deployment_root}/previous.next"
ln -sfnT "${rollback_target}" "${deployment_root}/current.next"
mv -Tf "${deployment_root}/previous.next" "${deployment_root}/previous"
mv -Tf "${deployment_root}/current.next" "${deployment_root}/current"

test "$(readlink "${deployment_root}/previous")" = "${current_target}"
test "$(readlink "${deployment_root}/current")" = "${rollback_target}"
```

After either operation, compare the host and container `index.html` checksums,
run `docker exec cometa-proxy nginx -t`, and probe the public apex, `www`
redirect, SPA fallback, and a content-hashed asset. Do not delete either release
until those checks pass.

After ACME has created `/etc/letsencrypt/live/euphoria.bot/`, stage the final
vhost and run `docker exec cometa-proxy nginx -t` again before any reload. Never
replace the shared proxy container to bypass a failed config test: it fronts
multiple live domains.

Certificate renewal is not complete until the proxy has reloaded and the served
SNI certificate has been checked. The live Hostinger setup uses the user systemd
timer below as the single renewal owner; it validates the `euphoria.bot` lineage,
reloads `cometa-proxy` only after `nginx -t`, and probes every served SNI certificate.
Before Certbot can mutate the shared volume, the renewal script snapshots every
`live/` lineage symlink and maps each served hostname to its current leaf. It then
validates every referenced candidate's minimum lifetime, hostname coverage, key
pair, and trust chain through the full minimum-validity window before `nginx -t`
and reload. The rollback bundle is atomically persisted under the service state
directory before renewal; the next run recovers it after a crash or reboot before
starting Certbot. Any Certbot, validation,
reload, or served-SNI failure restores all prior symlink targets, reloads the
proxy, and verifies the exact previous leaf for every hostname. Signal cleanup
first stops the exact per-run Certbot container so an orphaned writer cannot
race the restore.

The legacy shared host still cannot order this user service ahead of Docker's
automatic proxy start. A reboot in the narrow interval after Certbot changes the
live symlinks but before commit can therefore load that candidate until the next
renewal invocation performs recovery. Eliminating that window requires renewal
in a separate staging volume or a boot unit ordered before the proxy. This source
hardening is not installed on Hostinger in the Irena release cycle.

The durable lifecycle is tracked in `scripts/renew-certificates.sh` and
`systemd/cometa-cert-renew.{service,timer}`. Install them for the `metaflexer`
user at `~/bin/cometa-cert-renew` and `~/.config/systemd/user/`, then use
`systemctl --user enable --now cometa-cert-renew.timer` only after the euphoria
lineage and final TLS vhost are live. Hostinger has lingering enabled for this
user, so the timer survives logout and reboot without root.
Disable the two legacy Compose renewal loops and remove the older
`reload-nginx-on-cert-change.sh` user-cron entry before enabling the timer: one
user service owns the shared certificate volumes, serializes with `flock`, always
runs `nginx -t`, and reloads the proxy only after that test passes. It validates
both apex and `www` in the euphoria lineage, then probes the actually served SNI
certificate and trust chain for every hostname on the shared proxy. One invalid
referenced lineage blocks the shared reload; a partial Certbot renewal is rolled
back to the previous served set, and the failed unit remains visible for alerting.

The live vhost deliberately omits HSTS. Keep it disabled until certificate renewal,
proxy reload, served-SNI validation, and a TLS-valid rollback have survived a full
release cycle **and** the owner has completed real-device acceptance and explicitly
approved the public launch. A successful release cycle is necessary, not sufficient.
Stable font and currency-badge URLs use revalidation rather than a multi-day immutable
cache; only Vite's content-hashed JS/CSS receive one-year caching.

## Bot edge network and activation

The bot never joins the existing `cometa_default` network. Before first bot
activation, `deploy/bot/activate.sh` idempotently creates the internal
`cometa_bank_edge` bridge and attaches only `cometa-proxy`; Compose then joins
the bot under the `cometa-bank-bot` alias. Bot API egress uses a separate
Compose-owned bridge. See `bot/README.md` for the single interactive activation
command, immutable image prebuild, verification, rotation, and rollback.

The production vhost declares its own bootstrap rate/connection zones at the
top of `nginx/euphoria.bot.conf`, which is included from Nginx's `http` context.
Do not copy those `limit_*_zone` directives into a `server` or `location`
block. The endpoint keeps dynamic Docker DNS resolution, so a stopped or
recreated bot cannot make `nginx -t` depend on the container's current IP.
