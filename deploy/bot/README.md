# Cometa bot service

The service runs as one Node 22 polling worker. It exposes a private host probe
on `127.0.0.1:8787`. The bot and `cometa-proxy` share the dedicated internal
`cometa_bank_edge` network; the bot is not attached to `cometa_default`, so it
cannot reach that network's MongoDB or other workloads. A separate
Compose-owned bridge provides outbound Bot API access and contains no other
service. The shared Nginx proxy routes bootstrap traffic to `POST /bootstrap`.
`GET /healthz` is intended for Docker and private service probes.

## First install

Build the immutable image before switching `bot-current`. Revoke the token that
was exposed in chat, generate a new BotFather token, and run one command from an
interactive terminal:

```bash
ssh -t hostinger \
  'sudo /home/metaflexer/euphoria.bot/bot-current/deploy/bot/activate.sh'
```

`activate.sh` derives the immutable image tag from the resolved `bot-current`
release, refuses a missing prebuilt image, creates and validates the isolated
edge network, attaches the already-running `cometa-proxy`, and prompts through
hidden `/dev/tty` only when no live token exists. Before installation, the
candidate is checked with Telegram `getMe` and must belong to
`@MyBankApp_Bot`. The token-bearing URL exists only in a root-readable temporary
curl config; it never enters argv or logs. The service is then recreated without
building and gets at most four minutes to become ready, including bounded
Telegram setup retries.

Before changing the service, activation records a running immutable image and
whether a live token exists. A failed recreate or readiness deadline restores
the previous root-only token backup when rotation occurred, recreates the
previous image, and verifies its health. The command still exits non-zero so a
deployment controller cannot mistake a rollback for a successful release.
Without a previous release, a failed first-install candidate is stopped.
Failure output contains only container state and token-redacted logs.
An exclusive host lock rejects overlapping activation or rotation commands.

The network helper is idempotent. It validates driver, `--internal`, local
scope, ownership label, and current members before attaching the proxy. It
refuses an existing lookalike network or any member other than `cometa-proxy`
and the `cometa-bank-bot` Compose service. Its manual proxy attachment is only
the first-install bridge; the declarative proxy lifecycle is described below.
Docker cannot prevent a privileged operator from attaching another container
later; rerunning activation detects that drift.

The secret helper writes the validated live token to
`/etc/cometa-bank/secrets/bot_token` with mode `0600`, owned by container UID
1000. Before replacement it copies the prior token to
`/etc/cometa-bank/secrets/bot_token.previous`, mode `0600`, owner root; that
backup is not mounted into the container. Compose bind-mounts only the live file
read-only and exposes only its path through `BOT_TOKEN_FILE`. Never put the token
in Compose, shell history, command arguments, or a project `.env` file.

Build each uploaded bot release with its immutable release ID before activation:

```bash
COMETA_BOT_IMAGE_TAG="$RELEASE_ID" \
  docker compose -f deploy/bot/compose.yaml build bot
```

Direct Compose use still accepts `COMETA_BOT_IMAGE_TAG`; when omitted it uses
the `local` tag for local validation only.

## Durable proxy edge network

An imperative `docker network connect` is lost when the shared proxy container
is recreated. After the first activation has provisioned `cometa_bank_edge`,
install `deploy/nginx/cometa-proxy.edge.compose.yaml` beside the authoritative
shared-proxy Compose file and include both files in every proxy lifecycle
command:

```bash
docker compose \
  -f /home/metaflexer/cometa/docker-compose.yml \
  -f /home/metaflexer/cometa/cometa-proxy.edge.compose.yaml \
  config --quiet

docker compose \
  -f /home/metaflexer/cometa/docker-compose.yml \
  -f /home/metaflexer/cometa/cometa-proxy.edge.compose.yaml \
  up -d proxy
```

The override adds the existing external bridge to `services.proxy` without
replacing its current `default`, `aisatisfy`, or `fairground` networks. Running
the base Compose file alone can still detach the edge on recreate; either merge
the override into that authoritative file or update every wrapper/service that
owns proxy lifecycle before treating the attachment as durable.

## Verification and rotation

```bash
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
docker compose -f deploy/bot/compose.yaml ps
docker compose -f deploy/bot/compose.yaml logs --tail=100 bot
```

Normal image activation reuses the existing token and does not prompt. Rotate a
token only through the guarded activation path so candidate validation and
token-plus-image rollback remain coupled:

```bash
ssh -t hostinger \
  'sudo /home/metaflexer/euphoria.bot/bot-current/deploy/bot/activate.sh --rotate-token'
```

The helper retains one previous token for automatic rollback. BotFather rotation
normally revokes the old credential, so recovery can still fail after a real
revocation; the helper reports that as a failed rollback instead of claiming
success. A normal image release, where the token is unchanged, rolls back the
image without touching the credential.

Manual image rollback remains the break-glass fallback. It keeps the data
volume and starts an image built under an earlier release ID; verify health
immediately:

```bash
COMETA_BOT_IMAGE_TAG="$PREVIOUS_RELEASE_ID" \
  docker compose -f deploy/bot/compose.yaml up -d --no-build --force-recreate bot
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
```

The startup sequence checks `getWebhookInfo`, removes an existing webhook with
`drop_pending_updates=false`, verifies that it is gone, configures the profile,
commands, and Web App menu with serialized writes, then starts long polling.
Transient network, 429, and 5xx failures use bounded retries and honor Telegram
`retry_after`; permanent 4xx responses fail closed. A failed step keeps `/healthz`
unready.

The Nginx location resolves the container alias through Docker DNS on each
request (10-second cache), so token rotation, recreate, and rollback do not
need a proxy reload. A stopped bot degrades only this bootstrap endpoint to
`502`; it does not invalidate the shared proxy configuration. App-scoped
Nginx zones cap one source address at 20 requests/second with a burst of 100
and 40 concurrent bootstrap requests. The deliberately generous limits avoid
punishing many Telegram users behind one carrier NAT.
