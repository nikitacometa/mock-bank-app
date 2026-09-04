#!/usr/bin/env bash
set -Eeuo pipefail

readonly deploy_root="${COMETA_DEPLOY_ROOT:-/srv/cometa-bank}"
readonly bot_uid='10001'
apply=false
confirmed_key_login=false
ssh_port=''
temporary_source=''

cleanup() {
  if [[ -n "${temporary_source}" && -f "${temporary_source}" ]]; then
    rm -f -- "${temporary_source}"
  fi
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

usage() {
  printf '%s\n' \
    'Usage: provision-host.sh --check' \
    '       provision-host.sh --apply --ssh-port PORT --confirmed-key-login' \
    '' \
    'The apply mode installs Docker from its official apt repository, installs' \
    'host probes, prepares /srv/cometa-bank, and enables a default-deny UFW policy.'
}

while (( $# > 0 )); do
  case "$1" in
    --check)
      apply=false
      shift
      ;;
    --apply)
      apply=true
      shift
      ;;
    --confirmed-key-login)
      confirmed_key_login=true
      shift
      ;;
    --ssh-port)
      (( $# >= 2 )) || fail '--ssh-port requires a value'
      ssh_port=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "${deploy_root}" == /* && "${deploy_root}" != '/' && "${deploy_root}" != *'..'* ]] || \
  fail 'COMETA_DEPLOY_ROOT must be a narrow absolute path without ..'
if [[ "${apply}" == true ]]; then
  (( EUID == 0 )) || fail 'run --apply through sudo'
  [[ "${ssh_port}" =~ ^[0-9]{1,5}$ ]] || fail '--ssh-port is required and must be numeric'
  (( ssh_port >= 1 && ssh_port <= 65535 )) || fail '--ssh-port must be between 1 and 65535'
  [[ "${confirmed_key_login}" == true ]] || \
    fail 'open and verify a second key-only SSH session, then pass --confirmed-key-login'
fi

test -r /etc/os-release || fail '/etc/os-release is unavailable'
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == 'ubuntu' ]] || fail 'this provisioner supports only Ubuntu'
case "${VERSION_ID:-}" in
  24.04|26.04) ;;
  *) fail 'this provisioner supports only Ubuntu 24.04 LTS or 26.04 LTS' ;;
esac
case "$(dpkg --print-architecture)" in
  amd64|arm64) ;;
  *) fail 'only amd64 and arm64 hosts are supported' ;;
esac

if [[ "${apply}" != true ]]; then
  for command_name in curl dig docker flock openssl sqlite3 ss ufw; do
    if command -v "${command_name}" >/dev/null 2>&1; then
      log "found ${command_name}"
    else
      log "missing ${command_name}"
    fi
  done
  if command -v docker >/dev/null 2>&1; then
    docker version --format 'Docker server {{.Server.Version}}' 2>/dev/null || \
      log 'Docker CLI exists but the daemon is unavailable'
    docker compose version 2>/dev/null || log 'Docker Compose plugin is unavailable'
  fi
  ss -lntup
  exit 0
fi

log 'installing host prerequisites'
apt-get update
apt-get install -y ca-certificates curl dnsutils gnupg openssl sqlite3 ufw

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  log 'installing Docker Engine from the official apt repository'
  install -d -m 0755 /etc/apt/keyrings
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --proto '=https' \
    --tlsv1.2 \
    https://download.docker.com/linux/ubuntu/gpg \
    --output /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  temporary_source="$(mktemp)"
  printf '%s\n' \
    'Types: deb' \
    'URIs: https://download.docker.com/linux/ubuntu' \
    "Suites: ${UBUNTU_CODENAME:-${VERSION_CODENAME}}" \
    'Components: stable' \
    "Architectures: $(dpkg --print-architecture)" \
    'Signed-By: /etc/apt/keyrings/docker.asc' >"${temporary_source}"
  install -m 0644 "${temporary_source}" /etc/apt/sources.list.d/docker.sources
  rm -f -- "${temporary_source}"
  temporary_source=''

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker
docker version --format 'Docker server {{.Server.Version}}'
docker compose version

log "preparing ${deploy_root}"
install -d -m 0755 -o root -g root \
  "${deploy_root}" \
  "${deploy_root}/incoming" \
  "${deploy_root}/releases" \
  "${deploy_root}/state" \
  "${deploy_root}/state/images" \
  "${deploy_root}/state/nginx"
install -d -m 0700 -o root -g root "${deploy_root}/backups"
install -d -m 0700 -o root -g root "${deploy_root}/data"
chown "${bot_uid}:${bot_uid}" "${deploy_root}/data"
install -d -m 0700 -o root -g root /etc/cometa-bank/secrets

log 'configuring default-deny host firewall'
sshd -T | awk -v expected="${ssh_port}" \
  '$1 == "port" && $2 == expected { found = 1 } END { exit(found ? 0 : 1) }' || \
  fail "sshd effective configuration does not include port ${ssh_port}"
ss -lntp | grep -Eq "LISTEN.+:${ssh_port}([^0-9]|$).+(sshd|systemd)" || \
  fail "sshd is not listening on port ${ssh_port}"
ufw default deny incoming
ufw default allow outgoing
ufw allow "${ssh_port}/tcp" comment 'SSH'
ufw allow 80/tcp comment 'Cometa HTTP and ACME'
ufw allow 443/tcp comment 'Cometa HTTPS'
ufw --force enable
ufw status verbose

if [[ -S /var/run/docker.sock ]]; then
  socket_mode="$(stat -c '%a:%U:%G' /var/run/docker.sock)"
  log "Docker socket ${socket_mode}; membership in its group is root-equivalent"
else
  fail 'Docker socket is unavailable after installation'
fi

log 'host provisioning complete; run the security preflight before deploying a release'
