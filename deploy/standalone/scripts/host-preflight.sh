#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly compose_file="${script_dir}/../compose.yaml"
readonly deploy_root="${COMETA_DEPLOY_ROOT:-/srv/cometa-bank}"
readonly minimum_docker_version='24.0.0'
readonly minimum_compose_version='2.20.0'

expected_ssh_port=''

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: host-preflight.sh --ssh-port PORT\n'
}

version_at_least() {
  local actual=$1
  local minimum=$2
  local actual_major actual_minor actual_patch
  local minimum_major minimum_minor minimum_patch

  [[ "${actual}" =~ ^v?([0-9]+)\.([0-9]+)(\.([0-9]+))? ]] || return 2
  actual_major=${BASH_REMATCH[1]}
  actual_minor=${BASH_REMATCH[2]}
  actual_patch=${BASH_REMATCH[4]:-0}

  [[ "${minimum}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 2
  minimum_major=${BASH_REMATCH[1]}
  minimum_minor=${BASH_REMATCH[2]}
  minimum_patch=${BASH_REMATCH[3]}

  (( 10#${actual_major} > 10#${minimum_major} )) && return 0
  (( 10#${actual_major} < 10#${minimum_major} )) && return 1
  (( 10#${actual_minor} > 10#${minimum_minor} )) && return 0
  (( 10#${actual_minor} < 10#${minimum_minor} )) && return 1
  (( 10#${actual_patch} >= 10#${minimum_patch} ))
}

check_ufw_allowlist() {
  local ufw_status=$1
  local ipv6_value=''
  local rule protocol port family key
  local -a incoming_allows=()
  local -A expected_rules=()
  local -A actual_rules=()

  [[ -r /etc/default/ufw ]] || fail '/etc/default/ufw is unavailable'
  ipv6_value="$(awk -F= '
    /^[[:space:]]*IPV6[[:space:]]*=/ {
      value = $2
      gsub(/[[:space:]\047\042]/, "", value)
      print tolower(value)
      exit
    }
  ' /etc/default/ufw)"
  case "${ipv6_value}" in
    yes|no) ;;
    *) fail 'cannot determine whether UFW IPv6 support is enabled' ;;
  esac

  for port in "${expected_ssh_port}" 80 443; do
    expected_rules["v4:${port}/tcp"]=1
    if [[ "${ipv6_value}" == 'yes' ]]; then
      expected_rules["v6:${port}/tcp"]=1
    fi
  done

  mapfile -t incoming_allows < <(
    awk '
      /^\[[[:space:]]*[0-9]+\]/ {
        line = $0
        sub(/^\[[[:space:]]*[0-9]+\][[:space:]]*/, "", line)
        sub(/[[:space:]]+#.*$/, "", line)
        gsub(/[[:space:]]+/, " ", line)
        sub(/^ /, "", line)
        sub(/ $/, "", line)
        if (line ~ / (ALLOW|LIMIT) IN /) {
          print line
        }
      }
    ' <<<"${ufw_status}"
  )

  for rule in "${incoming_allows[@]}"; do
    family=''
    port=''
    protocol=''
    if [[ "${rule}" =~ ^([0-9]{1,5})/(tcp)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+Anywhere$ ]]; then
      family='v4'
      port=${BASH_REMATCH[1]}
      protocol=${BASH_REMATCH[2]}
    elif [[ "${rule}" =~ ^([0-9]{1,5})/(tcp)[[:space:]]+\(v6\)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+Anywhere[[:space:]]+\(v6\)$ ]]; then
      family='v6'
      port=${BASH_REMATCH[1]}
      protocol=${BASH_REMATCH[2]}
    else
      fail "unexpected inbound UFW allow rule: ${rule}"
    fi

    key="${family}:${port}/${protocol}"
    [[ -n "${expected_rules[${key}]:-}" ]] || fail "unexpected inbound UFW allow rule: ${rule}"
    [[ -z "${actual_rules[${key}]:-}" ]] || fail "duplicate inbound UFW allow rule: ${rule}"
    actual_rules["${key}"]=1
  done

  for key in "${!expected_rules[@]}"; do
    [[ -n "${actual_rules[${key}]:-}" ]] || fail "missing inbound UFW allow rule: ${key}"
  done
}

check_tcp_listeners() {
  local state recv_q send_q local_address peer_address remainder
  local host port
  local public_ssh_listener=false

  while read -r state recv_q send_q local_address peer_address remainder; do
    [[ "${state}" == 'LISTEN' ]] || continue
    [[ "${local_address}" == *:* ]] || fail "cannot parse TCP listener address: ${local_address}"

    port=${local_address##*:}
    host=${local_address%:*}
    host=${host%%%*}
    host=${host#[}
    host=${host%]}
    [[ "${port}" =~ ^[0-9]{1,5}$ ]] || fail "cannot parse TCP listener port: ${local_address}"

    if [[ "${host}" == 127.* || "${host}" == '::1' || "${host}" == ::ffff:127.* ]]; then
      continue
    fi

    case "${port}" in
      "${expected_ssh_port}")
        [[ "${remainder}" == *'"sshd"'* || "${remainder}" == *'"systemd"'* ]] || \
          fail "expected SSH port is owned by an unexpected process: ${local_address}"
        public_ssh_listener=true
        ;;
      80|443) ;;
      *) fail "unexpected non-loopback TCP listener: ${local_address}" ;;
    esac
  done < <(ss -H -lntp)

  [[ "${public_ssh_listener}" == true ]] || \
    fail "nothing is listening publicly on expected SSH port ${expected_ssh_port}"
}

while (( $# > 0 )); do
  case "$1" in
    --ssh-port)
      (( $# >= 2 )) || fail '--ssh-port requires a value'
      expected_ssh_port=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

(( EUID == 0 )) || fail 'run this preflight through sudo'
[[ "${expected_ssh_port}" =~ ^[0-9]{1,5}$ ]] || fail '--ssh-port is required and must be numeric'
(( expected_ssh_port >= 1 && expected_ssh_port <= 65535 )) || fail 'invalid SSH port'
[[ "${deploy_root}" == /* && "${deploy_root}" != '/' && "${deploy_root}" != *'..'* ]] || \
  fail 'COMETA_DEPLOY_ROOT must be a narrow absolute path without ..'

for command_name in docker sshd ss ufw; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command not found: ${command_name}"
done

docker_engine_version="$(docker version --format '{{.Server.Version}}')" || \
  fail 'Docker daemon is unavailable'
docker_compose_version="$(docker compose version --short)" || \
  fail 'Docker Compose plugin is unavailable'
version_at_least "${docker_engine_version}" "${minimum_docker_version}" || \
  fail "Docker Engine ${minimum_docker_version} or newer is required; found ${docker_engine_version}"
version_at_least "${docker_compose_version}" "${minimum_compose_version}" || \
  fail "Docker Compose ${minimum_compose_version} or newer is required; found ${docker_compose_version}"

[[ -f "${compose_file}" ]] || fail "release compose file not found: ${compose_file}"
COMETA_RELEASE_ID='host-preflight' COMETA_DEPLOY_ROOT="${deploy_root}" \
  docker compose -f "${compose_file}" config --quiet || \
  fail "Docker Compose cannot render the extracted release: ${compose_file}"

if grep -ERiq '^[[:space:]]*Match[[:space:]]' \
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d; then
  fail 'SSH Match blocks require an explicit per-user/address security review'
fi
ssh_user="${SUDO_USER:-root}"
[[ "${ssh_user}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'cannot determine a safe SSH user context'
sshd_config="$(sshd -T -C "user=${ssh_user},addr=127.0.0.1,host=$(hostname)")"
grep -Eq '^pubkeyauthentication yes$' <<<"${sshd_config}" || fail 'SSH public-key auth is disabled'
grep -Eq '^passwordauthentication no$' <<<"${sshd_config}" || fail 'disable SSH password authentication first'
grep -Eq '^kbdinteractiveauthentication no$' <<<"${sshd_config}" || \
  fail 'disable SSH keyboard-interactive authentication first'
grep -Eq '^permitrootlogin (no|prohibit-password|without-password)$' <<<"${sshd_config}" || \
  fail 'root SSH login still permits passwords'

ufw_status="$(ufw status verbose)"
grep -Fq 'Status: active' <<<"${ufw_status}" || fail 'UFW is inactive'
grep -Eq 'Default: deny \(incoming\), allow \(outgoing\)' <<<"${ufw_status}" || \
  fail 'UFW does not use default-deny incoming policy'
ufw_numbered_status="$(ufw status numbered)"
check_ufw_allowlist "${ufw_numbered_status}"

check_tcp_listeners

printf '%s\n' \
  'Host preflight passed:' \
  "- Docker Engine ${docker_engine_version} and Compose ${docker_compose_version} meet minimum versions" \
  '- the extracted release Compose model renders successfully' \
  '- SSH is key-only' \
  '- UFW has only the expected inbound allow rules' \
  '- no unexpected non-loopback TCP listener was found'
