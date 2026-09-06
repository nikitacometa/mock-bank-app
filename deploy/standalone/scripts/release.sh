#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly deploy_root="${COMETA_DEPLOY_ROOT:-/srv/cometa-bank}"
readonly bot_uid='10001'
readonly token_path='/etc/cometa-bank/secrets/bot_token'
readonly domain='euphoria.bot'
readonly www_domain='www.euphoria.bot'
readonly certbot_image='certbot/certbot:v5.3.1@sha256:8be9c9f10232e223acd84acdacc26858fcd46e8194c6dcdf99b2ddd231a362fe'
readonly health_attempts='105'
readonly health_stability_seconds='31'
readonly deploy_lock='/run/lock/cometa-bank.deploy.lock'
readonly image_manifest_root="${deploy_root}/state/images"
readonly live_database_path="${deploy_root}/data/cometa-bank.sqlite"
readonly database_backup_root="${deploy_root}/backups"
readonly host_renewal_entrypoint='/usr/local/sbin/cometa-bank-renew-certificates'
readonly host_renewal_worker='/usr/local/libexec/cometa-bank-renew-certificates-worker'
readonly host_renewal_service='/etc/systemd/system/cometa-bank-cert-renew.service'
readonly host_renewal_timer='/etc/systemd/system/cometa-bank-cert-renew.timer'
readonly host_renewal_record="${deploy_root}/state/renewal-bundle.release"
readonly host_renewal_pending_record="${deploy_root}/state/renewal-bundle.pending"
readonly host_renewal_legacy_timer_journal="${deploy_root}/state/renewal-bundle.legacy-timer"
readonly host_renewal_guard_directory='/etc/systemd/system/cometa-bank-cert-renew.service.d'
readonly host_renewal_guard="${host_renewal_guard_directory}/10-bundle-migration.conf"
readonly renewal_service_unit='cometa-bank-cert-renew.service'
readonly renewal_timer_unit='cometa-bank-cert-renew.timer'
readonly renewal_container='cometa-bank-certbot-renew'
readonly recovery_helper_container='cometa-bank-certbot-recovery'
readonly letsencrypt_volume='cometa-bank_letsencrypt'
readonly recovery_volume_root='/etc/letsencrypt/.cometa-bank-renewal'
readonly renewal_recovery_instruction='sudo /usr/local/sbin/cometa-bank-renew-certificates --recover-only'
readonly caddy_service='caddy.service'
readonly installed_caddy_config='/etc/caddy/Caddyfile'
readonly caddy_admin_socket='/var/lib/caddy/.local/share/caddy/admin.sock'
readonly caddy_admin_listen="unix/${caddy_admin_socket}|0200"
readonly caddy_admin_address="unix/${caddy_admin_socket}"
readonly legacy_caddy_admin_address='127.0.0.1:2019'
readonly tls_probe_connect_timeout='5'
readonly tls_probe_max_time='15'
readonly tls_handshake_timeout='15s'
readonly tls_handshake_kill_after='2s'
readonly edge_recovery_root="${deploy_root}/state/edge-hardening-recovery"
readonly edge_recovery_marker="${edge_recovery_root}/pending"
readonly edge_recovery_caddy="${edge_recovery_root}/Caddyfile.original"
readonly edge_recovery_nginx="${edge_recovery_root}/nginx.original.conf"
readonly edge_recovery_marker_next="${edge_recovery_marker}.next"
readonly edge_recovery_caddy_next="${edge_recovery_caddy}.next"
readonly edge_recovery_nginx_next="${edge_recovery_nginx}.next"
readonly rollback_intent_root="${deploy_root}/state/rollback-recovery"
readonly rollback_intent_path="${rollback_intent_root}/pending"
readonly rollback_intent_next="${rollback_intent_path}.next"
readonly activation_intent_root="${deploy_root}/state/activation-recovery"
readonly activation_intent_path="${activation_intent_root}/pending"
readonly activation_intent_next="${activation_intent_path}.next"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
release_root="$(cd -- "${script_directory}/../../.." && pwd -P)"
readonly release_root
release_id="$(basename -- "${release_root}")"
readonly release_id
readonly compose_relative='deploy/standalone/compose.yaml'
readonly tracked_caddy_config="${release_root}/deploy/standalone/caddy/Caddyfile"
readonly http_config="${release_root}/deploy/standalone/nginx/http.conf"
readonly https_config="${release_root}/deploy/standalone/nginx/https.conf"
readonly live_config="${deploy_root}/state/nginx/default.conf"

action="${1:-}"
if (( $# > 0 )); then
  shift
fi
email=''
without_email=false
server_ipv4=''
server_ipv6=''
apply_rollback=false
repair_bot=false
ledger_mode_command=''
compat_copy=''
scratch_directory=''

cleanup() {
  if [[ -n "${compat_copy}" && -f "${compat_copy}" ]]; then
    rm -f -- "${compat_copy}"
  fi
  if [[ -n "${scratch_directory}" && -d "${scratch_directory}" ]]; then
    rm -rf -- "${scratch_directory}"
  fi
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

# shellcheck source=deploy/standalone/scripts/docker-daemon-perimeter.sh
source "${script_directory}/docker-daemon-perimeter.sh"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

usage() {
  printf '%s\n' \
    'Usage: release.sh prepare [--repair-bot]' \
    '       release.sh harden-edge [--apply]' \
    '       release.sh install-token' \
    '       release.sh activate' \
    '       release.sh rollback --apply' \
    '       release.sh ledger-mode status' \
    '       release.sh ledger-mode server [--apply]' \
    '       release.sh status' \
    '' \
    'Run from /srv/cometa-bank/releases/YYYYMMDDTHHMMSSZ through sudo.'
}

while (( $# > 0 )); do
  case "$1" in
    --email)
      (( $# >= 2 )) || fail '--email requires a value'
      email=$2
      shift 2
      ;;
    --no-email)
      without_email=true
      shift
      ;;
    --server-ipv4)
      (( $# >= 2 )) || fail '--server-ipv4 requires a value'
      server_ipv4=$2
      shift 2
      ;;
    --server-ipv6)
      (( $# >= 2 )) || fail '--server-ipv6 requires a value'
      server_ipv6=$2
      shift 2
      ;;
    --apply)
      apply_rollback=true
      shift
      ;;
    --repair-bot)
      repair_bot=true
      shift
      ;;
    status|server)
      [[ "${action}" == 'ledger-mode' && -z "${ledger_mode_command}" ]] || \
        fail "unexpected positional argument: $1"
      ledger_mode_command=$1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

if [[ "${action}" == '--help' || "${action}" == '-h' || -z "${action}" ]]; then
  usage
  [[ -n "${action}" ]] && exit 0
  exit 1
fi
[[ "${repair_bot}" != true || "${action}" == 'prepare' ]] || \
  fail '--repair-bot is only valid for prepare'

[[ "${deploy_root}" == /* && "${deploy_root}" != '/' && "${deploy_root}" != *'..'* ]] || \
  fail 'COMETA_DEPLOY_ROOT must be a narrow absolute path without ..'
(( EUID == 0 )) || fail 'run this release command through sudo'
[[ "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
  fail 'release directory must use UTC format YYYYMMDDTHHMMSSZ'
[[ "${release_root}" == "${deploy_root}/releases/${release_id}" ]] || \
  fail "release must live under ${deploy_root}/releases"
test -f "${release_root}/${compose_relative}" || fail 'standalone Compose file is missing'

for command_name in awk caddy chmod chown cmp curl date dig dirname docker dockerd env flock getent grep head install jq mktemp mv openssl readlink sed sha256sum sqlite3 ss stat sync systemctl systemd-analyze timeout tr unlink wc; do
  command -v "${command_name}" >/dev/null 2>&1 || \
    fail "required command not found: ${command_name}"
done
exec 9>"${deploy_lock}"
flock --nonblock 9 || fail 'another Cometa deployment command is running'
scratch_directory="$(mktemp -d)"
chmod 0700 "${scratch_directory}"
assert_docker_cli_local_contract
assert_no_pending_docker_perimeter_recovery

compose_release() {
  local -r target_release=$1
  shift
  local -r target_root="${deploy_root}/releases/${target_release}"
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  test -f "${target_root}/${compose_relative}" || return 1
  COMETA_RELEASE_ID="${target_release}" \
    COMETA_DEPLOY_ROOT="${deploy_root}" \
    docker compose -f "${target_root}/${compose_relative}" "$@"
}

verify_release_compose_edge_contract() {
  local -r target_release=$1
  local -r target_root="${deploy_root}/releases/${target_release}"
  local -r target_compose="${target_root}/${compose_relative}"
  local -r rendered_config="${scratch_directory}/compose-edge-${target_release}.json"
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  [[ -f "${target_compose}" && ! -L "${target_compose}" ]] || \
    fail "Compose file for ${target_release} is missing or symlinked"
  COMETA_RELEASE_ID="${target_release}" \
    COMETA_DEPLOY_ROOT="${deploy_root}" \
    docker compose -f "${target_compose}" --profile tools config --format json \
      >"${rendered_config}" || \
    fail "Compose file for ${target_release} could not be rendered"
  jq --exit-status '
    def normalized_port:
      {
        hostIp: (.host_ip // ""),
        published: (.published | tostring),
        target: (.target | tostring),
        protocol: (.protocol // "tcp")
      };
    ([.services.web.ports[]? | normalized_port] | sort_by(.published))
      == [
        {hostIp: "127.0.0.1", published: "8080", target: "8080", protocol: "tcp"},
        {hostIp: "127.0.0.1", published: "8443", target: "8443", protocol: "tcp"}
      ]
    and (
      [.services | to_entries[] | select(.key != "web") | .value.ports[]?]
      | length == 0
    )
    and (
      [.services | to_entries[] | select((.value.network_mode // "") != "")]
      | length == 0
    )
    and (.name == "cometa-bank")
    and ((.services | keys | sort) == ["bot", "certbot", "web"])
    and ((.services.web.networks | keys | sort) == ["edge", "public"])
    and ((.services.bot.networks | keys | sort) == ["edge", "egress"])
    and ((.services.certbot.networks | keys | sort) == ["egress"])
    and ((.networks | keys | sort) == ["edge", "egress", "public"])
    and (.networks.edge.name == "cometa-bank_edge")
    and (.networks.egress.name == "cometa-bank_egress")
    and (.networks.public.name == "cometa-bank_public")
    and all(.networks[];
      .driver == "bridge"
      and ((.external // false) == false)
      and ((.attachable // false) == false)
      and (if has("enable_ipv4") then .enable_ipv4 == true else true end)
      and (if has("enable_ipv6") then .enable_ipv6 == false else true end)
      and ((.ipam // {}) == {}))
    and (.networks.edge.internal == true)
    and ((.networks.egress.internal // false) == false)
    and ((.networks.public.internal // false) == false)
    and (.networks.edge.driver_opts == {"com.docker.network.bridge.enable_icc":"true"})
    and (.networks.egress.driver_opts == {"com.docker.network.bridge.enable_icc":"false"})
    and (.networks.public.driver_opts == {"com.docker.network.bridge.enable_icc":"false"})
    and all(.networks[]; ((.ipam.config // []) | length) == 0)
  ' "${rendered_config}" >/dev/null || \
    fail "release ${target_release} does not preserve the loopback-only Caddy upstream and bridge-network contract"
}

read_release_link() {
  local -r link_name=$1
  local -r link_path="${deploy_root}/${link_name}"
  local target
  if [[ ! -e "${link_path}" && ! -L "${link_path}" ]]; then
    return 0
  fi
  [[ -L "${link_path}" ]] || fail "${link_path} is not a symlink"
  target="$(readlink -- "${link_path}")"
  [[ "${target}" =~ ^releases/([0-9]{8}T[0-9]{6}Z)$ ]] || \
    fail "${link_path} has an unsafe target"
  test -d "${deploy_root}/${target}" || fail "${link_path} target is missing"
  printf '%s\n' "${BASH_REMATCH[1]}"
}

recovery_candidate_file_is_safe() {
  local -r candidate_root=$1
  local -r candidate_path=$2
  local root_metadata file_metadata mode uid gid
  [[ -d "${candidate_root}" && ! -L "${candidate_root}" ]] || return 1
  root_metadata="$(stat -c '%a:%u:%g' -- "${candidate_root}")" || return 1
  [[ "${root_metadata}" == '700:0:0' ]] || return 1
  [[ -f "${candidate_path}" && ! -L "${candidate_path}" ]] || return 1
  file_metadata="$(stat -c '%a:%u:%g' -- "${candidate_path}")" || return 1
  IFS=: read -r mode uid gid <<<"${file_metadata}"
  [[ "${uid}:${gid}" == '0:0' && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 022) == 0 && (8#${mode} & 0400) != 0 ))
}

recovery_candidate_relation() {
  local -r candidate_root=$1
  local -r candidate_path=$2
  local -r expected_path=$3
  local candidate_size expected_size prefix_path comparison_status=0
  recovery_candidate_file_is_safe "${candidate_root}" "${candidate_path}" || return 1
  [[ -f "${expected_path}" && ! -L "${expected_path}" ]] || return 1
  candidate_size="$(stat -c '%s' -- "${candidate_path}")" || return 1
  expected_size="$(stat -c '%s' -- "${expected_path}")" || return 1
  [[ "${candidate_size}" =~ ^[0-9]+$ && "${expected_size}" =~ ^[0-9]+$ ]] || return 1
  (( candidate_size <= expected_size )) || return 1
  prefix_path="$(mktemp "${scratch_directory}/recovery-prefix.XXXXXX")" || return 1
  head -c "${candidate_size}" -- "${expected_path}" >"${prefix_path}" || return 1
  cmp -- "${candidate_path}" "${prefix_path}" >/dev/null 2>&1 || comparison_status=$?
  unlink -- "${prefix_path}" || return 1
  (( comparison_status == 0 )) || return 1
  if (( candidate_size == expected_size )); then
    printf 'exact\n'
  else
    printf 'prefix\n'
  fi
}

promote_recovery_candidate() {
  local -r candidate_root=$1
  local -r candidate_path=$2
  local -r committed_path=$3
  local -r destination_policy=$4
  recovery_candidate_file_is_safe "${candidate_root}" "${candidate_path}" || return 1
  case "${destination_policy}" in
    must-be-absent)
      [[ ! -e "${committed_path}" && ! -L "${committed_path}" ]] || return 1
      ;;
    replace-safe-snapshot)
      if [[ -e "${committed_path}" || -L "${committed_path}" ]]; then
        recovery_candidate_file_is_safe "${candidate_root}" "${committed_path}" || return 1
      fi
      ;;
    *) return 1 ;;
  esac
  chmod 0600 -- "${candidate_path}" || return 1
  sync -f "${candidate_path}" || return 1
  mv -fT -- "${candidate_path}" "${committed_path}" || return 1
  sync -f "${candidate_root}" || return 1
}

discard_partial_recovery_candidate() {
  local -r candidate_root=$1
  local -r candidate_path=$2
  recovery_candidate_file_is_safe "${candidate_root}" "${candidate_path}" || return 1
  unlink -- "${candidate_path}" || return 1
  sync -f "${candidate_root}" || return 1
}

install_live_config() {
  local -r source_config=$1
  local -r next_config="${deploy_root}/state/nginx/default.conf.next"
  test -f "${source_config}" || fail "Nginx config is missing: ${source_config}"
  test ! -L "${live_config}" || fail 'refusing a symlinked live Nginx config'
  install -m 0644 -o root -g root -- "${source_config}" "${next_config}" || return 1
  sync -f "${next_config}" || return 1
  mv -fT -- "${next_config}" "${live_config}" || return 1
  sync -f "$(dirname -- "${live_config}")" || return 1
}

verify_image() {
  local -r image=$1
  local -r expected_release=$2
  local label
  docker image inspect "${image}" >/dev/null 2>&1 || fail "image is missing: ${image}"
  label="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "${image}")"
  [[ "${label}" == "${expected_release}" ]] || \
    fail "image ${image} has release label ${label:-missing}; expected ${expected_release}"
}

image_manifest_path() {
  local -r target_release=$1
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  printf '%s/%s.sha256\n' "${image_manifest_root}" "${target_release}"
}

record_image_manifest() {
  local -r target_release=$1
  local manifest next_manifest web_id bot_id
  manifest="$(image_manifest_path "${target_release}")"
  next_manifest="${manifest}.next"
  test ! -e "${manifest}" || fail "image manifest already exists for ${target_release}"
  test ! -L "${image_manifest_root}" || fail 'refusing a symlinked image manifest directory'
  install -d -m 0700 -o root -g root "${image_manifest_root}"
  web_id="$(docker image inspect --format '{{.Id}}' "cometa-bank-web:${target_release}")"
  bot_id="$(docker image inspect --format '{{.Id}}' "cometa-bank-bot:${target_release}")"
  [[ "${web_id}" =~ ^sha256:[a-f0-9]{64}$ && "${bot_id}" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail 'Docker returned an unexpected image ID'
  printf 'web %s\nbot %s\n' "${web_id}" "${bot_id}" >"${next_manifest}"
  chmod 0600 "${next_manifest}"
  mv -fT -- "${next_manifest}" "${manifest}"
}

verify_release_images() {
  local -r target_release=$1
  local manifest web_id bot_id bot_manifest_line line_count
  manifest="$(image_manifest_path "${target_release}")"
  [[ -f "${manifest}" && ! -L "${manifest}" ]] || \
    fail "immutable image manifest is missing for ${target_release}"
  line_count="$(wc -l <"${manifest}")"
  [[ "${line_count//[[:space:]]/}" == '2' ]] || \
    fail "image manifest must contain exactly two lines for ${target_release}"
  read -r _ web_id <"${manifest}" || fail "cannot read image manifest for ${target_release}"
  bot_manifest_line="$(sed -n '2p' "${manifest}")" || \
    fail "cannot read bot image manifest entry for ${target_release}"
  read -r _ bot_id <<<"${bot_manifest_line}" || \
    fail "cannot read bot image ID for ${target_release}"
  grep -Eq '^web sha256:[a-f0-9]{64}$' "${manifest}" || fail 'invalid web image manifest entry'
  grep -Eq '^bot sha256:[a-f0-9]{64}$' "${manifest}" || fail 'invalid bot image manifest entry'
  verify_image "cometa-bank-web:${target_release}" "${target_release}"
  verify_image "cometa-bank-bot:${target_release}" "${target_release}"
  [[ "$(docker image inspect --format '{{.Id}}' "cometa-bank-web:${target_release}")" == "${web_id}" ]] || \
    fail "web image tag no longer matches the immutable manifest for ${target_release}"
  [[ "$(docker image inspect --format '{{.Id}}' "cometa-bank-bot:${target_release}")" == "${bot_id}" ]] || \
    fail "bot image tag no longer matches the immutable manifest for ${target_release}"
}

service_health() {
  local -r target_release=$1
  local -r service=$2
  local container_id status container_image expected_image restart_count
  container_id="$(compose_release "${target_release}" ps -q "${service}")"
  [[ -n "${container_id}" ]] || return 1
  container_image="$(docker inspect --format '{{.Image}}' "${container_id}")"
  expected_image="$(docker image inspect --format '{{.Id}}' "cometa-bank-${service}:${target_release}")"
  [[ "${container_image}" == "${expected_image}" ]] || return 1
  restart_count="$(docker inspect --format '{{.RestartCount}}' "${container_id}")"
  [[ "${restart_count}" == '0' ]] || return 1
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
  [[ "${status}" == 'healthy' ]]
}

wait_for_services() {
  local -r target_release=$1
  shift
  local healthy_since=0 now attempt service all_healthy
  for (( attempt = 1; attempt <= health_attempts; attempt += 1 )); do
    all_healthy=true
    for service in "$@"; do
      if ! service_health "${target_release}" "${service}"; then
        all_healthy=false
        break
      fi
    done
    if [[ "${all_healthy}" == true ]]; then
      now="$(date +%s)"
      if (( healthy_since == 0 )); then
        healthy_since=${now}
      fi
      if (( now - healthy_since >= health_stability_seconds )); then
        return 0
      fi
    else
      healthy_since=0
    fi
    sleep 2
  done
  return 1
}

verify_caddy_config_contract() {
  local -r config_path=$1
  local -r config_name=$2
  local -r trust_mode=${3:-secure}
  local adapted_config expected_domain
  [[ "${config_name}" == 'tracked' || "${config_name}" == 'installed' || \
    "${config_name}" == 'candidate' ]] || return 1
  [[ "${trust_mode}" == 'secure' || "${trust_mode}" == 'legacy' ]] || return 1
  [[ -f "${config_path}" && ! -L "${config_path}" ]] || \
    fail "${config_name} Caddy config is missing or symlinked"
  caddy validate --config "${config_path}" --adapter caddyfile >/dev/null || \
    fail "${config_name} Caddy config is invalid"
  adapted_config="${scratch_directory}/caddy-${config_name}.json"
  caddy adapt --config "${config_path}" --adapter caddyfile >"${adapted_config}" || \
    fail "${config_name} Caddy config could not be adapted"
  for expected_domain in "${domain}" "${www_domain}"; do
    jq --exit-status \
      --arg domain "${expected_domain}" \
      --arg upstream '127.0.0.1:8443' \
      --arg trust_mode "${trust_mode}" '
        def routes_for($hostname):
          [.apps.http.servers[]?.routes[]?
            | select(any(.match[]?.host[]?; . == $hostname))];
        def proxies_for($route):
          [$route | .. | objects | select(.handler? == "reverse_proxy")];
        def no_hsts($route):
          ([$route | .. | objects | to_entries[]
            | select((.key | ascii_downcase) == "strict-transport-security")] | length) == 0;
        routes_for($domain) as $routes
        | ($routes | length) == 1
          and (proxies_for($routes[0]) as $proxies
            | ($proxies | length) == 1
              and ($proxies[0].upstreams == [{"dial":$upstream}])
              and ($proxies[0].headers.request.set.Host == ["{http.request.host}"])
              and ($proxies[0].transport.protocol == "http")
              and ($proxies[0].transport.tls.server_name == $domain)
              and (if $trust_mode == "secure" then
                (($proxies[0].transport.tls.insecure_skip_verify // false) == false)
              else
                ($proxies[0].transport.tls.insecure_skip_verify == true)
              end)
              and no_hsts($routes[0]))
      ' "${adapted_config}" >/dev/null || \
      fail "${config_name} Caddy config does not preserve the exact ${expected_domain} HTTPS loopback route"
  done
  if [[ "${trust_mode}" == 'secure' ]]; then
    jq --exit-status --arg admin_listen "${caddy_admin_listen}" '
      [.apps.http.servers[]?] as $servers
      | ($servers | length) > 0
        and all($servers[]; .protocols == ["h1", "h2"])
        and .admin.listen == $admin_listen
        and .admin.config.persist == false
    ' "${adapted_config}" >/dev/null || \
      fail "${config_name} Caddy config must use h1/h2 and the permissioned non-persistent admin socket"
  else
    jq --exit-status '((.admin // {}) | length) == 0' "${adapted_config}" >/dev/null || \
      fail "${config_name} legacy Caddy config has an unexpected admin endpoint override"
  fi
}

verify_nginx_real_ip_contract() {
  local -r config_path=$1
  local directive_count required_line
  [[ -f "${config_path}" && ! -L "${config_path}" ]] || return 1
  directive_count="$(awk '
    $1 == "set_real_ip_from" || $1 == "real_ip_header" || $1 == "real_ip_recursive" {
      count += 1
    }
    END { print count + 0 }
  ' "${config_path}")" || return 1
  [[ "${directive_count}" == '6' ]] || return 1
  for required_line in \
    'set_real_ip_from 127.0.0.1;' \
    'set_real_ip_from 10.0.0.0/8;' \
    'set_real_ip_from 172.16.0.0/12;' \
    'set_real_ip_from 192.168.0.0/16;' \
    'real_ip_header X-Forwarded-For;' \
    'real_ip_recursive on;'; do
    [[ "$(grep -Fxc -- "${required_line}" "${config_path}")" == '1' ]] || return 1
  done
}

prepare_hardened_nginx_config() {
  local -r source_config=$1
  local -r destination=$2
  local directive_count
  [[ -f "${source_config}" && ! -L "${source_config}" ]] || return 1
  if verify_nginx_real_ip_contract "${source_config}"; then
    install -m 0600 -- "${source_config}" "${destination}" || return 1
    return 0
  fi
  directive_count="$(awk '
    $1 == "set_real_ip_from" || $1 == "real_ip_header" || $1 == "real_ip_recursive" {
      count += 1
    }
    END { print count + 0 }
  ' "${source_config}")" || return 1
  [[ "${directive_count}" == '0' ]] || return 1
  [[ "$(grep -Fxc 'server_tokens off;' "${source_config}")" == '1' ]] || return 1
  awk '
    {
      print
      if ($0 == "server_tokens off;") {
        print ""
        print "# Host ports are loopback-only and host Caddy overwrites X-Forwarded-For. Docker"
        print "# may SNAT the local hop through a private bridge gateway; recover the real IP."
        print "set_real_ip_from 127.0.0.1;"
        print "set_real_ip_from 10.0.0.0/8;"
        print "set_real_ip_from 172.16.0.0/12;"
        print "set_real_ip_from 192.168.0.0/16;"
        print "real_ip_header X-Forwarded-For;"
        print "real_ip_recursive on;"
      }
    }
  ' "${source_config}" >"${destination}" || return 1
  chmod 0600 "${destination}" || return 1
  verify_nginx_real_ip_contract "${destination}"
}

prepare_hardened_caddy_config() {
  local -r source_config=$1
  local -r destination=$2
  [[ -f "${source_config}" && ! -L "${source_config}" ]] || return 1
  if (verify_caddy_config_contract "${source_config}" installed secure >/dev/null 2>&1); then
    install -m 0600 -- "${source_config}" "${destination}" || return 1
    return 0
  fi
  (verify_caddy_config_contract "${source_config}" installed legacy >/dev/null 2>&1) || return 1
  awk -v apex="${domain}" -v www="${www_domain}" '
    function brace_delta(value, opened, closed, copy) {
      copy = value
      opened = gsub(/{/, "{", copy)
      copy = value
      closed = gsub(/}/, "}", copy)
      return opened - closed
    }
    BEGIN {
      print "{"
      print "\tadmin unix//var/lib/caddy/.local/share/caddy/admin.sock|0200"
      print "\tpersist_config off"
      print "\tservers {"
      print "\t\tprotocols h1 h2"
      print "\t}"
      print "}"
      print ""
    }
    {
      if (!in_target && ($0 == apex " {" || $0 == www " {")) {
        in_target = 1
        target_depth = 0
        target_count += 1
      }
      delta = brace_delta($0)
      if (in_target && $0 ~ /^[[:space:]]*tls_insecure_skip_verify[[:space:]]*$/) {
        removed_count += 1
        target_depth += delta
        if (target_depth == 0) in_target = 0
        next
      }
      print
      if (in_target) {
        target_depth += delta
        if (target_depth == 0) in_target = 0
      }
    }
    END {
      if (target_count != 2 || removed_count != 2 || in_target) exit 1
    }
  ' "${source_config}" >"${destination}" || return 1
  chmod 0600 "${destination}" || return 1
  verify_caddy_config_contract "${destination}" candidate secure
}

legacy_unit_is_quiesced() {
  local -r unit_name=$1
  local enablement='' active_state=''
  if ! enablement="$(systemctl is-enabled "${unit_name}" 2>/dev/null)"; then
    :
  fi
  case "${unit_name}:${enablement}" in
    "${renewal_timer_unit}:disabled"|"${renewal_timer_unit}:masked"|\
    "${renewal_timer_unit}:not-found"|"${renewal_service_unit}:static"|\
    "${renewal_service_unit}:disabled"|"${renewal_service_unit}:masked"|\
    "${renewal_service_unit}:not-found") ;;
    *) return 1 ;;
  esac
  if ! active_state="$(systemctl show --property ActiveState --value "${unit_name}" 2>/dev/null)"; then
    [[ "${enablement}" == 'not-found' ]] || return 1
    active_state='inactive'
  fi
  [[ "${active_state}" == 'inactive' ]]
}

assert_legacy_certbot_units_quiesced() {
  legacy_unit_is_quiesced "${renewal_timer_unit}" || \
    fail "legacy ${renewal_timer_unit} must be disabled and inactive"
  legacy_unit_is_quiesced "${renewal_service_unit}" || \
    fail "legacy ${renewal_service_unit} must be non-enabled and inactive"
}

assert_public_tcp_listener_owned_by_caddy() {
  local -r port=$1
  local listeners listener local_socket local_address service_pid confirmed_service_pid
  local has_non_loopback_listener=false
  [[ "${port}" == '80' || "${port}" == '443' ]] || return 1
  service_pid="$(caddy_service_pid)" || \
    fail 'could not bind public Caddy listeners to caddy.service'
  listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s \
    ss -H -ltnp "sport = :${port}")" || \
    fail "could not inspect public TCP port ${port}"
  [[ -n "${listeners}" ]] || fail "public TCP port ${port} has no listener"
  while IFS= read -r listener; do
    validate_caddy_listener_owner "${listener}" "${service_pid}" || \
      fail "public TCP port ${port} is not owned exclusively by Caddy"
    local_socket="$(awk '{print $4}' <<<"${listener}")" || \
      fail "could not parse the Caddy listener on public TCP port ${port}"
    [[ "${local_socket}" == *":${port}" ]] || \
      fail "Caddy listener has an unexpected local socket for public TCP port ${port}"
    local_address=${local_socket%:"${port}"}
    case "${local_address}" in
      127.*|'[::1]'|::1|'[::ffff:127.'*']') ;;
      *) has_non_loopback_listener=true ;;
    esac
  done <<<"${listeners}"
  [[ "${has_non_loopback_listener}" == true ]] || \
    fail "Caddy has no non-loopback listener on public TCP port ${port}"
  confirmed_service_pid="$(caddy_service_pid)" || \
    fail 'could not recheck caddy.service after public listener enumeration'
  [[ "${confirmed_service_pid}" == "${service_pid}" ]] || \
    fail 'caddy.service changed while public listeners were being inspected'
}

caddy_service_pid() {
  local pid comm
  pid="$(timeout --foreground --signal=TERM --kill-after=2s 8s \
    systemctl show --property MainPID --value "${caddy_service}")" || return 1
  [[ "${pid}" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  comm="$(tr -d '\n' <"/proc/${pid}/comm")" || return 1
  [[ "${comm}" == caddy ]] || return 1
  printf '%s\n' "${pid}"
}

caddy_admin_parent_is_private() {
  local path metadata owner group mode
  for path in \
    /var/lib/caddy \
    /var/lib/caddy/.local \
    /var/lib/caddy/.local/share \
    /var/lib/caddy/.local/share/caddy; do
    [[ -d "${path}" && ! -L "${path}" ]] || return 1
    metadata="$(stat -c '%U:%G:%a' -- "${path}")" || return 1
    IFS=: read -r owner group mode <<<"${metadata}"
    [[ "${owner}" == caddy && "${group}" == caddy && "${mode}" =~ ^[0-7]{3,4}$ ]] || \
      return 1
    (( (8#${mode} & 022) == 0 )) || return 1
  done
}

validate_caddy_listener_owner() {
  local line=$1
  local expected_pid=$2
  [[ "${line}" == *'users:(("caddy",pid='* ]] || return 1
  awk -v expected_pid="${expected_pid}" '
    {
      remaining = $0
      count = 0
      while (match(remaining, /pid=[0-9]+/)) {
        value = substr(remaining, RSTART + 4, RLENGTH - 4)
        if (value != expected_pid) exit 1
        count += 1
        remaining = substr(remaining, RSTART + RLENGTH)
      }
      exit(count == 1 ? 0 : 1)
    }
  ' <<<"${line}"
}

assert_permissioned_caddy_admin_socket() {
  local pid confirmed_pid metadata listeners matching count line tcp_admin_listeners
  pid="$(caddy_service_pid)" || fail 'could not bind the Caddy admin socket to caddy.service'
  caddy_admin_parent_is_private || fail 'Caddy admin socket parent chain is not private to caddy'
  [[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]] || \
    fail 'permissioned Caddy admin Unix socket is missing or symlinked'
  metadata="$(stat -c '%U:%G:%a' -- "${caddy_admin_socket}")" || \
    fail 'could not inspect Caddy admin Unix socket metadata'
  [[ "${metadata}" == 'caddy:caddy:200' || "${metadata}" == 'caddy:caddy:0200' ]] || \
    fail 'Caddy admin Unix socket must be caddy-owned with mode 0200'
  listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s ss -H -lxnp)" || \
    fail 'could not inspect Unix listeners for Caddy admin'
  matching="$(awk -v expected="${caddy_admin_socket}" '
    $1 == "u_str" && $2 == "LISTEN" {
      for (field = 1; field <= NF; field += 1) {
        if ($field == expected) print
      }
    }
  ' <<<"${listeners}")" || fail 'could not parse the Caddy admin Unix listener'
  count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"${matching}")" || \
    fail 'could not count Caddy admin Unix listeners'
  [[ "${count}" == '1' ]] || fail 'expected exactly one Caddy admin Unix listener'
  line="$(awk 'NF { print; exit }' <<<"${matching}")"
  validate_caddy_listener_owner "${line}" "${pid}" || \
    fail 'Caddy admin Unix listener is not owned by caddy.service'
  tcp_admin_listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s \
    ss -H -ltnp 'sport = :2019')" || \
    fail 'could not inspect the legacy Caddy TCP admin listener'
  [[ -z "${tcp_admin_listeners}" ]] || \
    fail 'legacy Caddy TCP admin listener must be closed'
  confirmed_pid="$(caddy_service_pid)" || \
    fail 'could not recheck caddy.service after admin listener enumeration'
  [[ "${confirmed_pid}" == "${pid}" ]] || \
    fail 'caddy.service changed while its admin listener was being inspected'
}

assert_legacy_caddy_admin_runtime() {
  local pid confirmed_pid listeners count line local_socket
  pid="$(caddy_service_pid)" || fail 'could not bind the legacy Caddy admin listener to caddy.service'
  listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s \
    ss -H -ltnp 'sport = :2019')" || fail 'could not inspect legacy Caddy admin listener'
  count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"${listeners}")"
  [[ "${count}" == '1' ]] || fail 'legacy Caddy must expose exactly one loopback admin listener'
  line="$(awk 'NF { print; exit }' <<<"${listeners}")"
  local_socket="$(awk '{print $4}' <<<"${line}")"
  [[ "${local_socket}" == "${legacy_caddy_admin_address}" ]] && \
    validate_caddy_listener_owner "${line}" "${pid}" || \
    fail 'legacy Caddy admin listener has an unexpected address or owner'
  confirmed_pid="$(caddy_service_pid)" || \
    fail 'could not recheck caddy.service after legacy admin enumeration'
  [[ "${confirmed_pid}" == "${pid}" ]] || \
    fail 'caddy.service changed while its legacy admin listener was being inspected'
}

assert_legacy_caddy_admin_listener() {
  [[ ! -e "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]] || \
    fail 'legacy Caddy runtime has a stale strict admin socket'
  assert_legacy_caddy_admin_runtime
}

caddy_stale_admin_socket_is_safe() {
  local metadata listeners matching
  caddy_admin_parent_is_private || return 1
  [[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]] || return 1
  metadata="$(stat -c '%U:%G:%a' -- "${caddy_admin_socket}")" || return 1
  [[ "${metadata}" == 'caddy:caddy:200' || "${metadata}" == 'caddy:caddy:0200' ]] || \
    return 1
  (assert_legacy_caddy_admin_runtime >/dev/null 2>&1) || return 1
  listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s ss -H -lxnp)" || \
    return 1
  matching="$(awk -v expected="${caddy_admin_socket}" '
    {
      for (field = 1; field <= NF; field += 1) {
        if ($field == expected) print
      }
    }
  ' <<<"${listeners}")" || return 1
  [[ -z "${matching}" ]]
}

reconcile_stale_caddy_admin_socket() {
  if [[ ! -e "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]]; then
    return 0
  fi
  [[ "${apply_rollback}" == true ]] || return 1
  verify_edge_recovery_snapshots >/dev/null 2>&1 || return 1
  if (assert_permissioned_caddy_admin_socket >/dev/null 2>&1); then
    return 0
  fi
  caddy_stale_admin_socket_is_safe || return 1
  unlink -- "${caddy_admin_socket}" || return 1
  sync -f "$(dirname -- "${caddy_admin_socket}")" || return 1
  (assert_legacy_caddy_admin_listener >/dev/null 2>&1)
}

detect_caddy_admin_address() {
  if [[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]]; then
    if (assert_permissioned_caddy_admin_socket >/dev/null 2>&1); then
      printf '%s\n' "${caddy_admin_address}"
      return 0
    fi
    if (caddy_stale_admin_socket_is_safe); then
      printf '%s\n' "${legacy_caddy_admin_address}"
      return 0
    fi
    return 1
  fi
  assert_legacy_caddy_admin_listener >/dev/null 2>&1 || return 1
  printf '%s\n' "${legacy_caddy_admin_address}"
}

assert_caddy_live_config_matches_file() {
  local expected live
  assert_permissioned_caddy_admin_socket
  expected="$(caddy adapt --config "${installed_caddy_config}" --adapter caddyfile | jq -cS .)" || \
    fail 'could not canonicalize the installed Caddy config'
  live="$(curl --disable --fail --silent --show-error --noproxy '*' \
    --connect-timeout 5 --max-time 10 --unix-socket "${caddy_admin_socket}" \
    'http://localhost/config/' | jq -cS .)" || \
    fail 'could not read the live Caddy config through its permissioned admin socket'
  [[ "${live}" == "${expected}" ]] || \
    fail 'live Caddy config differs from the installed Caddyfile'
}

assert_no_public_udp_listener() {
  local -r port=$1
  local listeners
  [[ "${port}" == '443' ]] || return 1
  listeners="$(ss -H -lunp "sport = :${port}")" || \
    fail "could not inspect public UDP port ${port}"
  [[ -z "${listeners}" ]] || \
    fail "public UDP port ${port} must stay closed while UFW exposes TCP only"
}

running_compose_service_container_id() {
  local -r service_name=$1
  local -r cardinality_mode=${2:-strict}
  local container_output container_count container_id
  [[ "${service_name}" == 'web' || "${service_name}" == 'bot' ]] || return 1
  [[ "${cardinality_mode}" == 'strict' || "${cardinality_mode}" == 'allow-zero' ]] || \
    return 1
  container_output="$(docker ps \
    --filter 'label=com.docker.compose.project=cometa-bank' \
    --filter "label=com.docker.compose.service=${service_name}" \
    --filter 'status=running' \
    --format '{{.ID}}')" || \
    fail "could not enumerate running cometa-bank ${service_name} containers"
  container_count="$(awk 'NF { count += 1 } END { print count + 0 }' \
    <<<"${container_output}")" || \
    fail "could not count running cometa-bank ${service_name} containers"
  [[ "${container_count}" =~ ^[0-9]+$ ]] || \
    fail "running cometa-bank ${service_name} container count is invalid"
  if [[ "${cardinality_mode}" == 'strict' ]]; then
    [[ "${container_count}" == '1' ]] || \
      fail "expected exactly one running cometa-bank ${service_name} container; found ${container_count}"
  else
    (( container_count <= 1 )) || \
      fail "expected at most one running cometa-bank ${service_name} container during repair; found ${container_count}"
    (( container_count == 1 )) || return 0
  fi
  container_id="$(awk 'NF { print; exit }' <<<"${container_output}")"
  [[ "${container_id}" =~ ^[a-f0-9]{12,64}$ ]] || \
    fail "running cometa-bank ${service_name} container has an invalid ID"
  printf '%s\n' "${container_id}"
}

assert_docker_network_contract() {
  local -r network_name=$1
  local -r existence_mode=${2:-required}
  local network_names network_count network_contract
  [[ "${network_name}" == 'cometa-bank_edge' || \
    "${network_name}" == 'cometa-bank_egress' || \
    "${network_name}" == 'cometa-bank_public' ]] || return 1
  [[ "${existence_mode}" == 'required' || "${existence_mode}" == 'allow-missing' ]] || \
    return 1
  network_names="$(docker network ls --format '{{.Name}}')" || \
    fail 'could not enumerate Docker networks'
  network_count="$(awk -v expected="${network_name}" \
    '$0 == expected { count += 1 } END { print count + 0 }' <<<"${network_names}")"
  if [[ "${network_count}" == '0' && "${existence_mode}" == 'allow-missing' ]]; then
    return 0
  fi
  [[ "${network_count}" == '1' ]] || \
    fail "expected exactly one Docker network named ${network_name}; found ${network_count}"
  network_contract="$(docker network inspect --format '{{json .}}' \
    "${network_name}")" || \
    fail "could not inspect Docker network ${network_name}"
  jq --exit-status --arg network_name "${network_name}" '
    def expected_logical:
      if $network_name == "cometa-bank_edge" then "edge"
      elif $network_name == "cometa-bank_egress" then "egress"
      elif $network_name == "cometa-bank_public" then "public"
      else null
      end;
    expected_logical as $logical
    | $logical != null
      and .Name == $network_name
      and .Driver == "bridge"
      and .Scope == "local"
      and .Ingress == false
      and .Attachable == false
      and ((.ConfigOnly // false) == false)
      and ((.ConfigFrom.Network // "") == "")
      and .EnableIPv4 == true
      and .EnableIPv6 == false
      and .IPAM.Driver == "default"
      and ((.IPAM.Options // {}) == {})
      and (.IPAM.Config | type == "array" and length == 1)
      and (.IPAM.Config[0] | keys | sort) == ["Gateway", "Subnet"]
      and (.IPAM.Config[0].Subnet | test(
        "^(10([.][0-9]{1,3}){3}/(8|9|[12][0-9]|3[0-2])"
        + "|172[.](1[6-9]|2[0-9]|3[01])([.][0-9]{1,3}){2}/(1[2-9]|2[0-9]|3[0-2])"
        + "|192[.]168([.][0-9]{1,3}){2}/(1[6-9]|2[0-9]|3[0-2]))$"
      ))
      and (.IPAM.Config[0].Gateway | test("^(10[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|192[.]168[.])"))
      and .Internal == ($logical == "edge")
      and .Labels["com.docker.compose.project"] == "cometa-bank"
      and .Labels["com.docker.compose.network"] == $logical
      and .Options == {
        "com.docker.network.bridge.enable_icc":
          (if $logical == "edge" then "true" else "false" end)
      }
  ' <<<"${network_contract}" >/dev/null || \
    fail "Docker network ${network_name} does not match the isolated bridge topology"
}

assert_running_compose_service_bindings() {
  local -r service_name=$1
  local -r cardinality_mode=${2:-strict}
  local container_id bindings_json network_mode networks_json network_name network_names
  container_id="$(running_compose_service_container_id \
    "${service_name}" "${cardinality_mode}")" || \
    fail "could not resolve running cometa-bank ${service_name} container cardinality"
  [[ -n "${container_id}" ]] || return 0
  network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' \
    "${container_id}")" || \
    fail "could not inspect running cometa-bank ${service_name} network mode"
  [[ -n "${network_mode}" && "${network_mode}" != 'host' && \
    "${network_mode}" != container:* ]] || \
    fail "running cometa-bank ${service_name} must use an isolated Docker network namespace"
  networks_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
    "${container_id}")" || \
    fail "could not inspect running cometa-bank ${service_name} network attachments"
  case "${service_name}" in
    web)
      jq --exit-status \
        '(keys | sort) == ["cometa-bank_edge", "cometa-bank_public"]' \
        <<<"${networks_json}" >/dev/null || \
        fail 'running web container has an unexpected Docker network attachment'
      ;;
    bot)
      jq --exit-status \
        '(keys | sort) == ["cometa-bank_edge", "cometa-bank_egress"]' \
        <<<"${networks_json}" >/dev/null || \
        fail 'running bot container has an unexpected Docker network attachment'
      ;;
    *) return 1 ;;
  esac
  jq --exit-status --arg network_mode "${network_mode}" 'has($network_mode)' \
    <<<"${networks_json}" >/dev/null || \
    fail "running cometa-bank ${service_name} primary network mode is not an attached network"
  network_names="$(jq -r 'keys[]' <<<"${networks_json}")" || \
    fail "could not enumerate running cometa-bank ${service_name} network attachments"
  while IFS= read -r network_name; do
    [[ -n "${network_name}" ]] || continue
    assert_docker_network_contract "${network_name}"
  done <<<"${network_names}"
  bindings_json="$(docker inspect --format '{{json .HostConfig.PortBindings}}' \
    "${container_id}")" || \
    fail "could not inspect running cometa-bank ${service_name} port bindings"
  case "${service_name}" in
    web)
      jq --exit-status '
        (keys | sort) == ["8080/tcp", "8443/tcp"]
        and .["8080/tcp"] == [{"HostIp":"127.0.0.1","HostPort":"8080"}]
        and .["8443/tcp"] == [{"HostIp":"127.0.0.1","HostPort":"8443"}]
      ' <<<"${bindings_json}" >/dev/null || \
        fail 'running web container does not use the exact loopback-only 8080/8443 bindings'
      ;;
    bot)
      jq --exit-status '(. // {}) | type == "object" and length == 0' \
        <<<"${bindings_json}" >/dev/null || \
        fail 'running bot container must not publish a host port'
      ;;
    *) return 1 ;;
  esac
}

assert_no_pending_link_intent() {
  if [[ -e "${activation_intent_path}" || -L "${activation_intent_path}" || \
    -e "${activation_intent_next}" || -L "${activation_intent_next}" ]]; then
    fail "an activation transaction is pending at ${activation_intent_path}; rerun activate through its source-clean release"
  fi
  if [[ -e "${rollback_intent_path}" || -L "${rollback_intent_path}" || \
    -e "${rollback_intent_next}" || -L "${rollback_intent_next}" ]]; then
    fail "a rollback transaction is pending at ${rollback_intent_path}; rerun rollback --apply through its source-clean release"
  fi
}

assert_no_pending_edge_recovery() {
  if [[ -e "${edge_recovery_marker}" || -L "${edge_recovery_marker}" || \
    -e "${edge_recovery_marker_next}" || -L "${edge_recovery_marker_next}" || \
    -e "${edge_recovery_caddy_next}" || -L "${edge_recovery_caddy_next}" || \
    -e "${edge_recovery_nginx_next}" || -L "${edge_recovery_nginx_next}" ]]; then
    fail "edge hardening recovery is pending at ${edge_recovery_marker}; rerun harden-edge --apply through its recorded operator release"
  fi
}

assert_action_link_intent_contract() {
  local -r action_name=$1
  case "${action_name}" in
    activate)
      if [[ -e "${rollback_intent_path}" || -L "${rollback_intent_path}" || \
        -e "${rollback_intent_next}" || -L "${rollback_intent_next}" ]]; then
        fail "a rollback transaction is pending at ${rollback_intent_path}; rerun rollback --apply through its original-current release"
      fi
      ;;
    rollback)
      if [[ -e "${activation_intent_path}" || -L "${activation_intent_path}" || \
        -e "${activation_intent_next}" || -L "${activation_intent_next}" ]]; then
        fail "an activation transaction is pending at ${activation_intent_path}; rerun activate through its source-clean target release"
      fi
      ;;
    *) assert_no_pending_link_intent ;;
  esac
}

assert_staged_edge_host_contract() {
  local -r pending_link_mode=${1:-reject-pending}
  local caddy_enablement caddy_active_state
  [[ "${pending_link_mode}" == 'reject-pending' || \
    "${pending_link_mode}" == 'allow-pending' ]] || return 1
  if [[ "${pending_link_mode}" == 'reject-pending' ]]; then
    assert_no_pending_link_intent
  fi
  assert_no_pending_edge_recovery
  check_docker_daemon_perimeter_contract
  verify_caddy_config_contract "${tracked_caddy_config}" tracked
  verify_caddy_config_contract "${installed_caddy_config}" installed
  caddy_enablement="$(systemctl is-enabled "${caddy_service}" 2>/dev/null)" || \
    fail "${caddy_service} enablement could not be verified"
  [[ "${caddy_enablement}" == 'enabled' ]] || fail "${caddy_service} must be enabled"
  caddy_active_state="$(systemctl show --property ActiveState --value "${caddy_service}")" || \
    fail "${caddy_service} state could not be verified"
  [[ "${caddy_active_state}" == 'active' ]] || fail "${caddy_service} must be active"
  assert_permissioned_caddy_admin_socket
  assert_caddy_live_config_matches_file
  assert_public_tcp_listener_owned_by_caddy 80
  assert_public_tcp_listener_owned_by_caddy 443
  assert_no_public_udp_listener 443
  assert_docker_network_contract cometa-bank_edge allow-missing
  assert_docker_network_contract cometa-bank_egress allow-missing
  assert_docker_network_contract cometa-bank_public allow-missing
  assert_running_compose_service_bindings web allow-zero
  assert_running_compose_service_bindings bot allow-zero
  verify_nginx_real_ip_contract "${live_config}" || \
    fail 'live Nginx config does not preserve the exact trusted real-IP contract'
  assert_legacy_certbot_units_quiesced
}

assert_staged_edge_contract() {
  local -r pending_link_mode=${1:-reject-pending}
  assert_staged_edge_host_contract "${pending_link_mode}"
  assert_running_compose_service_bindings web
  assert_running_compose_service_bindings bot
}

print_diagnostics() {
  local -r target_release=$1
  compose_release "${target_release}" ps >&2 || true
  compose_release "${target_release}" logs --no-color --tail=80 web bot 2>&1 | \
    sed -E \
      -e 's/[0-9]{6,20}:[A-Za-z0-9_-]{30,}/[REDACTED_BOT_TOKEN]/g' \
      -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' >&2 || true
}

validate_ipv4() {
  local -r address=$1
  local -a octets
  local octet
  IFS='.' read -r -a octets <<<"${address}"
  (( ${#octets[@]} == 4 )) || return 1
  for octet in "${octets[@]}"; do
    [[ "${octet}" =~ ^[0-9]{1,3}$ ]] || return 1
    (( 10#${octet} <= 255 )) || return 1
  done
}

validate_dns_records() {
  local -r record_type=$1
  local -r expected=$2
  local hostname output address found
  for hostname in "${domain}" "${www_domain}"; do
    output="$(dig +short "${record_type}" "${hostname}")" || fail "DNS query failed for ${hostname}"
    found=false
    while IFS= read -r address; do
      [[ -z "${address}" ]] && continue
      if [[ "${record_type}" == 'A' && ! "${address}" =~ ^[0-9.]+$ ]]; then
        continue
      fi
      if [[ "${record_type}" == 'AAAA' && "${address}" != *:* ]]; then
        continue
      fi
      found=true
      [[ "${address}" == "${expected}" ]] || \
        fail "${hostname} ${record_type} still resolves to unexpected address ${address}"
    done <<<"${output}"
    [[ "${found}" == true ]] || fail "${hostname} has no ${record_type} record"
  done
}

reject_unexpected_ipv6() {
  local hostname output address
  for hostname in "${domain}" "${www_domain}"; do
    output="$(dig +short AAAA "${hostname}")" || fail "DNS query failed for ${hostname}"
    while IFS= read -r address; do
      [[ "${address}" == *:* ]] || continue
      fail "${hostname} has AAAA ${address}; pass --server-ipv6 only if this VPS owns it"
    done <<<"${output}"
  done
}

extract_certificate_file() {
  local -r container_path=$1
  local -r destination=$2
  compose_release "${release_id}" --profile tools run \
    --rm --no-deps --pull missing --entrypoint cat certbot "${container_path}" >"${destination}"
  test -s "${destination}" || fail "certificate file is empty: ${container_path}"
}

certificate_covers_host() {
  local -r certificate=$1
  local -r hostname=$2
  local output
  output="$(openssl x509 -in "${certificate}" -noout -checkhost "${hostname}" 2>&1)" || return 1
  [[ "${output}" == "Hostname ${hostname} does match certificate" ]]
}

verify_certificate_lineage() {
  local certificate key certificate_public key_public leaf_certificate intermediate_chain
  certificate="${scratch_directory}/fullchain.pem"
  key="${scratch_directory}/privkey.pem"
  certificate_public="${scratch_directory}/certificate.pub"
  key_public="${scratch_directory}/key.pub"
  leaf_certificate="${scratch_directory}/leaf.pem"
  intermediate_chain="${scratch_directory}/intermediates.pem"
  : >"${certificate}"
  : >"${key}"
  : >"${certificate_public}"
  : >"${key_public}"
  : >"${leaf_certificate}"
  : >"${intermediate_chain}"
  chmod 0600 "${certificate}" "${key}" "${certificate_public}" "${key_public}" \
    "${leaf_certificate}" "${intermediate_chain}"
  extract_certificate_file "/etc/letsencrypt/live/${domain}/fullchain.pem" "${certificate}"
  extract_certificate_file "/etc/letsencrypt/live/${domain}/privkey.pem" "${key}"
  openssl x509 -in "${certificate}" -noout -checkend 1814400 >/dev/null || \
    fail 'certificate expires in less than 21 days'
  certificate_covers_host "${certificate}" "${domain}" || fail "certificate does not cover ${domain}"
  certificate_covers_host "${certificate}" "${www_domain}" || fail "certificate does not cover ${www_domain}"
  openssl x509 -in "${certificate}" -pubkey -noout >"${certificate_public}"
  openssl pkey -in "${key}" -pubout >"${key_public}"
  cmp -s "${certificate_public}" "${key_public}" || fail 'certificate and private key do not match'
  awk -v leaf="${leaf_certificate}" -v intermediates="${intermediate_chain}" '
    /-----BEGIN CERTIFICATE-----/ { certificate_number += 1 }
    certificate_number == 1 { print >> leaf }
    certificate_number > 1 { print >> intermediates }
  ' "${certificate}"
  test -s "${leaf_certificate}" || fail 'certificate lineage has no leaf certificate'
  test -s "${intermediate_chain}" || fail 'certificate lineage has no intermediate chain'
  openssl verify -purpose sslserver -CApath /etc/ssl/certs \
    -untrusted "${intermediate_chain}" "${leaf_certificate}" >/dev/null || \
    fail 'certificate lineage does not chain to the host trust store'
}

test_nginx_config() {
  local -r target_release=$1
  local -r config_path=$2
  docker run --rm --pull never \
    --mount "type=bind,src=${config_path},dst=/etc/nginx/conf.d/default.conf,readonly" \
    --mount 'type=volume,src=cometa-bank_letsencrypt,dst=/etc/letsencrypt,readonly' \
    "cometa-bank-web:${target_release}" nginx -t
}

verify_served_inner_certificates() {
  local hostname transcript leaf_certificate
  for hostname in "${domain}" "${www_domain}"; do
    transcript="${scratch_directory}/inner-${hostname}.openssl"
    leaf_certificate="${scratch_directory}/inner-${hostname}.pem"
    : >"${transcript}"
    : >"${leaf_certificate}"
    chmod 0600 "${transcript}" "${leaf_certificate}"
    timeout --signal=TERM --kill-after="${tls_handshake_kill_after}" --foreground \
      "${tls_handshake_timeout}" openssl s_client \
      -connect '127.0.0.1:8443' \
      -servername "${hostname}" \
      -verify_hostname "${hostname}" \
      -verify_return_error \
      -CApath /etc/ssl/certs \
      -showcerts </dev/null >"${transcript}" 2>&1 || return 1
    awk '
      /-----BEGIN CERTIFICATE-----/ { inside = 1 }
      inside { print }
      /-----END CERTIFICATE-----/ { exit }
    ' "${transcript}" >"${leaf_certificate}" || return 1
    [[ -s "${leaf_certificate}" ]] || return 1
    openssl x509 -in "${leaf_certificate}" -noout -checkend 1814400 >/dev/null || return 1
    certificate_covers_host "${leaf_certificate}" "${hostname}" || return 1
  done
}

tls_web_smoke() {
  local -r boundary=$1
  local -r request_path=${2:-/}
  local port
  [[ "${request_path}" == /* && "${request_path}" != *'?'* && "${request_path}" != *'#'* ]] || \
    fail 'TLS smoke path must be an absolute path without query or fragment'
  case "${boundary}" in
    inner)
      port='8443'
      ;;
    outer) port='443' ;;
    *) fail 'TLS smoke boundary must be inner or outer' ;;
  esac
  curl --disable --fail --silent --show-error --noproxy '*' \
    --connect-timeout "${tls_probe_connect_timeout}" --max-time "${tls_probe_max_time}" \
    --proto '=https' --tlsv1.2 \
    --resolve "${domain}:${port}:127.0.0.1" \
    "https://${domain}:${port}${request_path}" >/dev/null
}

tls_release_alias_smoke() {
  local -r boundary=$1
  local -r target_release=$2
  local unknown_release='99991231T235959Z'
  local port status
  case "${boundary}" in
    inner)
      port='8443'
      ;;
    outer) port='443' ;;
    *) fail 'TLS smoke boundary must be inner or outer' ;;
  esac
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'release-alias smoke requires a valid current release ID'
  if [[ "${unknown_release}" == "${target_release}" ]]; then
    unknown_release='99991231T235958Z'
  fi
  status="$(curl --disable --silent --show-error --noproxy '*' \
    --connect-timeout "${tls_probe_connect_timeout}" --max-time "${tls_probe_max_time}" \
    --proto '=https' --tlsv1.2 \
    --resolve "${domain}:${port}:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' \
    "https://${domain}:${port}/app/${unknown_release}/")" || \
    fail "${boundary} release-alias HTTPS smoke request failed"
  [[ "${status}" == '200' ]] || \
    fail "${boundary} Mini App release alias returned HTTP ${status} instead of 200"
}

tls_unauthenticated_probe() {
  local -r boundary=$1
  local -r route=$2
  local -r payload=$3
  local -r response_name=$4
  local port response_file status
  [[ "${route}" == /api/tma/* && "${route}" != *'?'* && "${route}" != *'#'* ]] || \
    fail 'TLS API smoke route is invalid'
  [[ "${response_name}" =~ ^[a-z-]+$ ]] || fail 'TLS API smoke response name is invalid'
  case "${boundary}" in
    inner)
      port='8443'
      ;;
    outer) port='443' ;;
    *) fail 'TLS smoke boundary must be inner or outer' ;;
  esac
  response_file="${scratch_directory}/${boundary}-${response_name}-response.json"
  : >"${response_file}"
  status="$(curl --disable --silent --show-error --noproxy '*' \
    --connect-timeout "${tls_probe_connect_timeout}" --max-time "${tls_probe_max_time}" \
    --proto '=https' --tlsv1.2 \
    --resolve "${domain}:${port}:127.0.0.1" \
    --output "${response_file}" --write-out '%{http_code}' \
    --request POST --header 'Content-Type: application/json' --data "${payload}" \
    "https://${domain}:${port}${route}")" || \
    fail "${boundary} ${response_name} unauthenticated probe request failed"
  [[ "${status}" == '401' ]] || \
    fail "${boundary} ${response_name} unauthenticated probe returned HTTP ${status}"
  grep -Fq '"error":"invalid_init_data"' "${response_file}" || \
    fail "${boundary} ${response_name} probe did not return the JSON API contract"
}

outer_caddy_www_redirect_smoke() {
  local -r target_release=$1
  local -r expected_location="https://${domain}/app/${target_release}/"
  local -r response_headers="${scratch_directory}/outer-www-redirect.headers"
  local status location
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'www redirect smoke requires a valid release ID'
  : >"${response_headers}"
  status="$(curl --disable --silent --show-error --noproxy '*' \
    --connect-timeout "${tls_probe_connect_timeout}" --max-time "${tls_probe_max_time}" \
    --proto '=https' --tlsv1.2 \
    --resolve "${www_domain}:443:127.0.0.1" \
    --dump-header "${response_headers}" --output /dev/null --write-out '%{http_code}' \
    "https://${www_domain}:443/app/${target_release}/")" || \
    fail 'outer Caddy www redirect smoke request failed'
  [[ "${status}" == '301' || "${status}" == '308' ]] || \
    fail "outer Caddy www redirect returned HTTP ${status} instead of 301/308"
  location="$(awk '
    tolower($1) == "location:" {
      value = $2
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "${response_headers}")"
  [[ "${location}" == "${expected_location}" ]] || \
    fail "outer Caddy www redirect target is ${location:-missing}; expected ${expected_location}"
}

release_api_smoke_profile() {
  local -r target_release=$1
  local -r target_config="${deploy_root}/releases/${target_release}/deploy/standalone/nginx/https.conf"
  local route authority_route_count=0
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'API smoke profile requires a valid release ID'
  [[ -f "${target_config}" && ! -L "${target_config}" ]] || \
    fail "HTTPS config for ${target_release} is missing or symlinked"
  grep -Fq 'location = /api/tma/bootstrap {' "${target_config}" || \
    fail "HTTPS config for ${target_release} has no bootstrap route"
  for route in bank-import bank-command bank-rates; do
    if grep -Fq "location = /api/tma/${route} {" "${target_config}"; then
      authority_route_count=$((authority_route_count + 1))
    fi
  done
  case "${authority_route_count}" in
    0) printf 'legacy\n' ;;
    3) printf 'authority\n' ;;
    *) fail "HTTPS config for ${target_release} has a partial authority API" ;;
  esac
}

legacy_bridge_operator_path() {
  local -r legacy_release=$1
  local -r operator_release=$2
  local -r operator_script="${deploy_root}/releases/${operator_release}/deploy/standalone/scripts/release.sh"
  local api_profile
  [[ "${legacy_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'legacy bridge target requires a valid release ID'
  [[ "${operator_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'pinned bridge operator requires a valid release ID'
  api_profile="$(release_api_smoke_profile "${legacy_release}")"
  [[ "${api_profile}" == 'legacy' ]] || return 0
  [[ -f "${operator_script}" && ! -L "${operator_script}" ]] || \
    fail "pinned bridge operator is missing or symlinked: ${operator_script}"
  printf '%s\n' "${operator_script}"
}

warn_pinned_bridge_operator() {
  local -r warning_context=$1
  local -r legacy_release=$2
  local -r operator_path=$3
  [[ -n "${operator_path}" ]] || return 0
  case "${warning_context}" in
    activation-risk)
      log "WARNING: current release ${legacy_release} still has the legacy operator; if activation fails or restores it, do not use ${deploy_root}/current/deploy/standalone/scripts/release.sh; use pinned immutable candidate operator: ${operator_path}"
      ;;
    activation-live)
      log "WARNING: activation left legacy rollback release ${legacy_release}; until bridge release B is live, run lifecycle commands only through pinned bridge script: ${operator_path}"
      ;;
    rollback-live)
      log "WARNING: rollback made legacy release ${legacy_release} live; run every retry and status command only through pinned bridge script: ${operator_path}"
      ;;
    *) fail 'unknown pinned bridge warning context' ;;
  esac
}

https_smoke_on_boundary() {
  local -r boundary=$1
  local -r target_release=$2
  local api_profile
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'HTTPS smoke requires a valid release ID'
  api_profile="$(release_api_smoke_profile "${target_release}")" || return 1
  tls_web_smoke "${boundary}" "/app/${target_release}/" || return 1
  # BotFather and historical direct links can still name the other bridge
  # release during rollback. A versioned path is a cache key; the compiled
  # client marker, not the URL text, identifies the running authority build.
  tls_release_alias_smoke "${boundary}" "${target_release}" || return 1
  tls_unauthenticated_probe "${boundary}" '/api/tma/bootstrap' '{}' 'bootstrap' || return 1
  if [[ "${api_profile}" == 'authority' ]]; then
    tls_unauthenticated_probe "${boundary}" '/api/tma/bank-import' \
      '{"version":1,"importId":"00000000000000000000000000000000","stateVersion":5,"state":{}}' \
      'bank-import' || return 1
    tls_unauthenticated_probe "${boundary}" '/api/tma/bank-command' \
      '{"version":1,"clientMutationId":"00000000000000000000000000000000","command":{}}' \
      'bank-command' || return 1
    tls_unauthenticated_probe "${boundary}" '/api/tma/bank-rates' \
      '{"version":1,"clientMutationId":"00000000000000000000000000000000"}' \
      'bank-rates' || return 1
  fi
}

inner_upstream_https_smoke() {
  verify_served_inner_certificates || return 1
  https_smoke_on_boundary inner "$1" || return 1
}

outer_caddy_https_smoke() {
  https_smoke_on_boundary outer "$1" || return 1
  outer_caddy_www_redirect_smoke "$1" || return 1
}

# Legacy certificate helper only. Active lifecycle actions never dispatch it.
local_tls_web_smoke() {
  tls_web_smoke outer "${1:-/}"
}

database_check_with_image() {
  local -r image=$1
  local -r database_path=$2
  docker run --rm --pull never \
    --user "${bot_uid}:${bot_uid}" \
    --mount "type=bind,src=${database_path},dst=/data/check.sqlite" \
    --entrypoint node \
    "${image}" \
    --input-type=module \
    --eval \
    "import { DatabaseSync } from 'node:sqlite'; import { PreferencesRepository } from './bot/repository.js'; const path = '/data/check.sqlite'; const repository = new PreferencesRepository(path); if (!repository.ping()) process.exit(1); repository.close(); const db = new DatabaseSync(path); const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (checkpoint?.busy !== 0 || checkpoint?.log !== 0) throw new Error('SQLite WAL checkpoint did not fully materialize'); const quickCheck = db.prepare('PRAGMA quick_check').get(); if (quickCheck?.quick_check !== 'ok') throw new Error('SQLite quick_check failed after WAL checkpoint'); const userVersion = db.prepare('PRAGMA user_version').get()?.user_version; const schemaVersion = db.prepare('PRAGMA schema_version').get()?.schema_version; const schemaObjects = db.prepare(\"SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'\").get()?.count; if (![userVersion, schemaVersion, schemaObjects].every(Number.isSafeInteger)) throw new Error('SQLite contract is invalid'); process.stdout.write([userVersion, schemaVersion, schemaObjects].join('|')); db.close();"
}

verify_materialized_database() {
  local -r database_path=$1
  local -r expected_contract=$2
  local quick_check user_version schema_version schema_objects actual_contract
  [[ "${expected_contract}" =~ ^[0-9]+\|[0-9]+\|[0-9]+$ ]] || return 1
  quick_check="$(sqlite3 -batch -noheader "${database_path}" 'PRAGMA quick_check;')" || return 1
  [[ "${quick_check}" == 'ok' ]] || return 1
  user_version="$(sqlite3 -batch -noheader "${database_path}" 'PRAGMA user_version;')" || return 1
  schema_version="$(sqlite3 -batch -noheader "${database_path}" 'PRAGMA schema_version;')" || return 1
  schema_objects="$(sqlite3 -batch -noheader "${database_path}" \
    "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%';")" || return 1
  actual_contract="${user_version}|${schema_version}|${schema_objects}"
  [[ "${actual_contract}" == "${expected_contract}" ]]
}

prepare_database_backup() {
  local -r target_release=$1
  local -r fallback_release=$2
  local quick_check backup_path target_contract fallback_contract
  if [[ -n "${fallback_release}" ]]; then
    verify_release_images "${fallback_release}"
  fi
  [[ -f "${live_database_path}" ]] || return 0
  [[ ! -L "${live_database_path}" ]] || fail 'refusing a symlinked SQLite database'
  quick_check="$(sqlite3 "${live_database_path}" 'PRAGMA quick_check;')"
  [[ "${quick_check}" == 'ok' ]] || fail 'live SQLite quick_check failed'
  backup_path="${deploy_root}/backups/$(date -u +'%Y%m%dT%H%M%SZ')-before-${release_id}.sqlite"
  test ! -e "${backup_path}" || fail "database backup already exists: ${backup_path}"
  sqlite3 "${live_database_path}" ".backup '${backup_path}'"
  chmod 0600 "${backup_path}"
  compat_copy="${backup_path}.compat"
  install -m 0600 -- "${backup_path}" "${compat_copy}"
  chown -- "+${bot_uid}:+${bot_uid}" "${compat_copy}"

  target_contract="$(database_check_with_image \
    "cometa-bank-bot:${target_release}" "${compat_copy}")" || \
    fail 'target image cannot open a copy of the live database'
  verify_materialized_database "${compat_copy}" "${target_contract}" || \
    fail 'target database migration was not materialized in the rollback probe copy'
  if [[ -n "${fallback_release}" ]]; then
    fallback_contract="$(database_check_with_image \
      "cometa-bank-bot:${fallback_release}" "${compat_copy}")" || \
      fail 'target migration is not backward-compatible with the fallback image'
    verify_materialized_database "${compat_copy}" "${fallback_contract}" || \
      fail 'fallback database check was not materialized in the rollback probe copy'
  fi
  rm -f -- "${compat_copy}"
  compat_copy=''
  log "SQLite backup and rollback compatibility check passed: ${backup_path}"
}

read_database_ledger_mode() {
  local column_count row_count mode
  [[ -f "${live_database_path}" && ! -L "${live_database_path}" ]] || \
    fail 'live SQLite database is missing or symlinked'
  column_count="$(sqlite3 -batch -noheader "${live_database_path}" \
    "SELECT count(*) FROM pragma_table_info('service_state') WHERE name = 'ledger_mode';")" || \
    fail 'cannot inspect the ledger-mode schema'
  [[ "${column_count}" == '1' ]] || \
    fail 'live database is not authority-capable or has an ambiguous ledger-mode schema'
  row_count="$(sqlite3 -batch -noheader "${live_database_path}" \
    'SELECT count(*) FROM service_state WHERE singleton = 1;')" || \
    fail 'cannot inspect the ledger-mode row'
  [[ "${row_count}" == '1' ]] || fail 'live database has an invalid ledger-mode row'
  mode="$(sqlite3 -batch -noheader "${live_database_path}" \
    'SELECT ledger_mode FROM service_state WHERE singleton = 1;')" || \
    fail 'cannot read the ledger mode'
  [[ "${mode}" == 'local' || "${mode}" == 'server' ]] || \
    fail 'live database has an unknown ledger mode'
  printf '%s\n' "${mode}"
}

verify_live_database_integrity() {
  local quick_check
  [[ -f "${live_database_path}" && ! -L "${live_database_path}" ]] || \
    fail 'live SQLite database is missing or symlinked'
  quick_check="$(sqlite3 -batch -noheader "${live_database_path}" 'PRAGMA quick_check;')" || \
    fail 'live SQLite quick_check could not run'
  [[ "${quick_check}" == 'ok' ]] || fail 'live SQLite quick_check failed'
}

probe_authority_bot_image() {
  local -r target_release=$1
  docker run --rm --pull never --network none --read-only \
    --user "${bot_uid}:${bot_uid}" \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "cometa-bank-bot:${target_release}" \
    --input-type=module --eval '
      import { readFileSync } from "node:fs";
      import { PreferencesRepository } from "/app/bot/repository.js";
      const source = readFileSync("/app/bot/main.js", "utf8");
      const repositorySource = readFileSync("/app/bot/repository.js", "utf8");
      const markers = [
        "bank_authority_disabled",
        "bank_import_required",
        "/bank-import",
        "/bank-command",
        "/bank-rates",
      ];
      if (markers.some((marker) => !source.includes(marker))) process.exit(1);
      if (!["ledger_mode", "setLedgerMode"].every((marker) => repositorySource.includes(marker))) {
        process.exit(1);
      }
      if (
        typeof PreferencesRepository.prototype.ledgerMode !== "function" ||
        typeof PreferencesRepository.prototype.setLedgerMode !== "function"
      ) process.exit(1);
    ' >/dev/null
}

probe_authority_web_image() {
  local -r target_release=$1
  docker run --rm --pull never --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --env "EXPECTED_RELEASE_ID=${target_release}" \
    --entrypoint /bin/sh "cometa-bank-web:${target_release}" -eu -c '
      scoped_entry="/usr/share/nginx/html/app/${EXPECTED_RELEASE_ID}/index.html"
      test -f "${scoped_entry}"
      cmp -s /usr/share/nginx/html/index.html "${scoped_entry}"
      for marker in \
        "/api/tma/bank-import" \
        "/api/tma/bank-command" \
        "/api/tma/bank-rates" \
        "ledger-authority-mode" \
        "ledger-client-contract" \
        "${EXPECTED_RELEASE_ID}"; do
        grep -R -F -q -- "${marker}" /usr/share/nginx/html
      done
    ' >/dev/null
}

verify_authority_release() {
  local -r target_release=$1
  local -r target_https_config="${deploy_root}/releases/${target_release}/deploy/standalone/nginx/https.conf"
  verify_release_images "${target_release}"
  [[ -f "${target_https_config}" && ! -L "${target_https_config}" ]] || \
    fail "HTTPS config for ${target_release} is missing or symlinked"
  grep -Fq 'location = /api/tma/bank-import {' "${target_https_config}" || \
    fail "HTTPS config for ${target_release} has no bank-import route"
  grep -Fq 'location = /api/tma/bank-command {' "${target_https_config}" || \
    fail "HTTPS config for ${target_release} has no bank-command route"
  grep -Fq 'location = /api/tma/bank-rates {' "${target_https_config}" || \
    fail "HTTPS config for ${target_release} has no bank-rates route"
  probe_authority_bot_image "${target_release}" || \
    fail "bot image for ${target_release} is pre-authority or unknown"
  probe_authority_web_image "${target_release}" || \
    fail "web image for ${target_release} is pre-authority or unknown"
}

verify_local_authority_backup_with_image() {
  local -r target_release=$1
  local -r backup_path=$2
  docker run --rm --pull never --network none --read-only \
    --user "${bot_uid}:${bot_uid}" \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=${backup_path},dst=/data/check.sqlite,readonly" \
    --entrypoint node "cometa-bank-bot:${target_release}" \
    --input-type=module --eval '
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync("/data/check.sqlite", { readOnly: true });
      try {
        const quickCheck = database.prepare("PRAGMA quick_check").get()?.quick_check;
        if (quickCheck !== "ok") process.exit(1);
        const mode = database
          .prepare("SELECT ledger_mode FROM service_state WHERE singleton = 1")
          .get()?.ledger_mode;
        if (mode !== "local") process.exit(1);
        const requiredTables = [
          "bank_operations",
          "bank_outbox",
          "bank_states",
          "conversation_sessions",
          "service_state",
        ];
        const tables = new Set(
          database
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
            .all()
            .map((row) => row.name),
        );
        if (requiredTables.some((table) => !tables.has(table))) process.exit(1);
      } finally {
        database.close();
      }
    ' >/dev/null
}

assert_authority_bridge() {
  local -r current_release=$1
  local -r previous_release=$2
  [[ -n "${current_release}" && -n "${previous_release}" ]] || \
    fail 'ledger authority requires both current and previous releases'
  [[ "${current_release}" != "${previous_release}" ]] || \
    fail 'current and previous releases must be distinct before ledger authority switches'
  [[ "${release_id}" == "${current_release}" ]] || \
    fail 'run ledger-mode commands through /srv/cometa-bank/current'
  verify_authority_release "${current_release}"
  verify_authority_release "${previous_release}"
}

prepare_ledger_mode_backup() {
  (
    local -r current_release=$1
    local -r previous_release=$2
    local timestamp backup_path backup_quick_check backup_mode compat_copy=''
    local compat_cleanup=''

    [[ -d "${database_backup_root}" && ! -L "${database_backup_root}" ]] || \
      fail 'SQLite backup directory is missing or symlinked'
    timestamp="$(date -u +'%Y%m%dT%H%M%SZ')" || \
      fail 'cannot timestamp the ledger-mode backup'
    backup_path="${database_backup_root}/${timestamp}-before-ledger-mode-server.sqlite"
    [[ "${backup_path}" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
      fail 'ledger-mode backup path contains unsupported characters'
    test ! -e "${backup_path}" || fail "database backup already exists: ${backup_path}"
    sqlite3 -batch -bail "${live_database_path}" ".backup '${backup_path}'" || \
      fail 'online SQLite backup failed before ledger-mode switch'
    chmod 0600 "${backup_path}" || fail 'cannot restrict the ledger-mode backup'
    [[ "$(stat -c '%u:%g:%a' "${backup_path}")" == '0:0:600' ]] || \
      fail 'ledger-mode backup must be root-owned with mode 0600'
    backup_quick_check="$(sqlite3 -batch -noheader "${backup_path}" 'PRAGMA quick_check;')" || \
      fail 'ledger-mode backup quick_check could not run'
    [[ "${backup_quick_check}" == 'ok' ]] || fail 'ledger-mode backup quick_check failed'
    backup_mode="$(sqlite3 -batch -noheader "${backup_path}" \
      'SELECT ledger_mode FROM service_state WHERE singleton = 1;')" || \
      fail 'cannot read ledger mode from the verified backup'
    [[ "${backup_mode}" == 'local' ]] || \
      fail 'ledger-mode backup did not capture the expected local mode'
    compat_copy="${backup_path}.compat"
    test ! -e "${compat_copy}" || fail "database compatibility copy already exists: ${compat_copy}"
    # The caller captures stdout with command substitution, so its EXIT trap is
    # not inherited here. Store a fully expanded cleanup command in this
    # function-owned subshell; function locals are gone by the time EXIT runs.
    printf -v compat_cleanup 'rm -f -- %q' "${compat_copy}"
    trap "${compat_cleanup}" EXIT
    install -m 0600 -- "${backup_path}" "${compat_copy}" || \
      fail 'cannot create the ledger-mode compatibility copy'
    chown -- "+${bot_uid}:+${bot_uid}" "${compat_copy}" || \
      fail 'cannot assign the ledger-mode compatibility copy'
    verify_local_authority_backup_with_image "${current_release}" "${compat_copy}" || \
      fail 'current authority image cannot verify the ledger-mode backup'
    verify_local_authority_backup_with_image "${previous_release}" "${compat_copy}" || \
      fail 'previous authority image cannot verify the ledger-mode backup'
    rm -f -- "${compat_copy}" || fail 'cannot remove the ledger-mode compatibility copy'
    compat_copy=''
    trap - EXIT
    sync -f "${backup_path}" || fail 'cannot durably flush the ledger-mode backup'
    printf '%s\n' "${backup_path}"
  )
}

switch_live_ledger_mode_to_server() {
  local -r current_release=$1
  local container_id result
  container_id="$(compose_release "${current_release}" ps -q bot)" || \
    fail 'cannot resolve the running bot container'
  [[ "${container_id}" =~ ^[a-f0-9]{64}$ ]] || fail 'running bot container identity is ambiguous'
  result="$(docker exec --user "${bot_uid}:${bot_uid}" "${container_id}" \
    node --input-type=module --eval '
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync("/data/cometa-bank.sqlite");
      database.exec("PRAGMA busy_timeout = 10000");
      try {
        if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
          throw new Error("pre-switch quick_check failed");
        }
        database.exec("BEGIN IMMEDIATE");
        const before = database
          .prepare("SELECT ledger_mode FROM service_state WHERE singleton = 1")
          .get()?.ledger_mode;
        if (before !== "local") throw new Error("ledger mode is not local");
        const update = database
          .prepare("UPDATE service_state SET ledger_mode = ? WHERE singleton = 1 AND ledger_mode = ?")
          .run("server", "local");
        if (update.changes !== 1 && update.changes !== 1n) {
          throw new Error("ledger mode update was not singular");
        }
        const after = database
          .prepare("SELECT ledger_mode FROM service_state WHERE singleton = 1")
          .get()?.ledger_mode;
        if (after !== "server") throw new Error("ledger mode did not switch");
        database.exec("COMMIT");
        if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
          throw new Error("post-switch quick_check failed");
        }
        process.stdout.write("server|1|ok");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* transaction may already be committed */ }
        throw error;
      } finally {
        database.close();
      }
    ')" || return 1
  [[ "${result}" == 'server|1|ok' ]]
}

restart_bot_for_server_commands() {
  local -r current_release=$1
  compose_release "${current_release}" restart --timeout 20 bot
}

reconcile_failed_ledger_mode_switch() {
  local mode
  if ! (verify_live_database_integrity); then
    fail 'ledger-mode helper failed and SQLite integrity is unverified; no automatic reversal was attempted'
  fi
  if ! mode="$(read_database_ledger_mode)"; then
    fail 'ledger-mode helper failed and the persisted mode is unreadable; no automatic reversal was attempted'
  fi
  if [[ "${mode}" == 'server' ]]; then
    log 'ledger-mode helper failed after the server marker committed; integrity is verified and final audit will continue'
    return 0
  fi
  fail 'ledger-mode helper failed; verified database remains local'
}

guard_server_authority_release_transition() {
  local -r target_release=$1
  local -r fallback_release=$2
  local column_count mode
  [[ -f "${live_database_path}" ]] || return 0
  [[ ! -L "${live_database_path}" ]] || fail 'refusing a symlinked SQLite database'
  column_count="$(sqlite3 -batch -noheader "${live_database_path}" \
    "SELECT count(*) FROM pragma_table_info('service_state') WHERE name = 'ledger_mode';")" || \
    fail 'cannot inspect ledger authority before the release transition'
  if [[ "${column_count}" == '0' ]]; then
    return 0
  fi
  [[ "${column_count}" == '1' ]] || fail 'ledger authority schema is ambiguous'
  mode="$(read_database_ledger_mode)"
  [[ "${mode}" == 'server' ]] || return 0
  verify_authority_release "${target_release}"
  if [[ -n "${fallback_release}" ]]; then
    verify_authority_release "${fallback_release}"
  fi
}

show_ledger_mode_status() {
  local current_release previous_release mode
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  assert_staged_edge_contract
  verify_release_compose_edge_contract "${current_release}"
  verify_release_compose_edge_contract "${previous_release}"
  assert_authority_bridge "${current_release}" "${previous_release}"
  verify_live_database_integrity
  mode="$(read_database_ledger_mode)"
  service_health "${current_release}" bot || fail 'current bot service is not healthy'
  service_health "${current_release}" web || fail 'current web service is not healthy'
  inner_upstream_https_smoke "${current_release}" || \
    fail 'current inner upstream HTTPS smoke test failed'
  outer_caddy_https_smoke "${current_release}" || \
    fail 'current outer Caddy HTTPS smoke test failed'
  printf 'Ledger mode: %s\nCurrent: %s (authority-capable)\nPrevious: %s (authority-capable)\nService health: healthy\n' \
    "${mode}" "${current_release}" "${previous_release}"
}

enable_server_ledger_mode() {
  local current_release previous_release mode backup_path
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  assert_staged_edge_contract
  verify_release_compose_edge_contract "${current_release}"
  verify_release_compose_edge_contract "${previous_release}"
  assert_authority_bridge "${current_release}" "${previous_release}"
  verify_live_database_integrity
  mode="$(read_database_ledger_mode)"
  service_health "${current_release}" bot || fail 'current bot service is not healthy'
  service_health "${current_release}" web || fail 'current web service is not healthy'
  inner_upstream_https_smoke "${current_release}" || \
    fail 'current inner upstream HTTPS smoke test failed'
  outer_caddy_https_smoke "${current_release}" || \
    fail 'current outer Caddy HTTPS smoke test failed'
  if [[ "${mode}" == 'server' ]]; then
    if [[ "${apply_rollback}" != true ]]; then
      printf 'Ledger mode is already server; no mutation was performed. Rerun with --apply to durably reconcile the final audit event.\n'
      return 0
    fi
    record_deployment ledger-mode-server-reconciled "${current_release}" || \
      fail 'ledger mode is server, but its reconciliation audit event could not be recorded'
    if ! restart_bot_for_server_commands "${current_release}"; then
      print_diagnostics "${current_release}"
      fail 'ledger mode is server, but the bot command profile restart failed; mode was not reversed'
    fi
    if ! wait_for_services "${current_release}" bot web || \
      ! inner_upstream_https_smoke "${current_release}" || \
      ! outer_caddy_https_smoke "${current_release}"; then
      print_diagnostics "${current_release}"
      fail 'ledger mode is server, but reconciliation health failed; mode was not reversed'
    fi
    assert_staged_edge_contract
    log 'server ledger authority and its durable audit trail are reconciled'
    return 0
  fi
  [[ "${apply_rollback}" == true ]] || {
    printf 'Ledger authority plan: local -> server\nCurrent: %s\nPrevious: %s\nRerun with: release.sh ledger-mode server --apply\n' \
      "${current_release}" "${previous_release}"
    return 0
  }

  backup_path="$(prepare_ledger_mode_backup "${current_release}" "${previous_release}")" || \
    fail 'ledger-mode backup preparation failed; database remains local'
  record_deployment ledger-mode-server-ready "${current_release}" || \
    fail 'ledger-mode pre-switch audit could not be recorded; database remains local'
  if ! switch_live_ledger_mode_to_server "${current_release}"; then
    reconcile_failed_ledger_mode_switch
  fi
  [[ "$(read_database_ledger_mode)" == 'server' ]] || \
    fail 'ledger-mode switch completed without a readable server marker'
  verify_live_database_integrity
  if ! record_deployment ledger-mode-server "${current_release}"; then
    fail 'ledger mode is server, but the final audit event could not be recorded'
  fi
  if ! restart_bot_for_server_commands "${current_release}"; then
    print_diagnostics "${current_release}"
    fail 'ledger mode is server, but the bot command profile restart failed; mode was not reversed'
  fi
  if ! wait_for_services "${current_release}" bot web || \
    ! inner_upstream_https_smoke "${current_release}" || \
    ! outer_caddy_https_smoke "${current_release}"; then
    print_diagnostics "${current_release}"
    fail 'ledger mode is server, but post-switch service health failed; mode was not reversed'
  fi
  assert_staged_edge_contract
  log "server ledger authority is enabled; verified backup: ${backup_path}"
}

switch_release_links() {
  local -r old_release=$1
  local -r new_target="releases/${release_id}"
  if [[ "${old_release}" == "${release_id}" ]]; then
    [[ "$(read_release_link current)" == "${release_id}" ]] || return 1
    return 0
  fi
  if [[ -n "${old_release}" ]]; then
    ln -sfnT "releases/${old_release}" "${deploy_root}/previous.next" || return 1
    mv -fT -- "${deploy_root}/previous.next" "${deploy_root}/previous" || return 1
    sync -f "${deploy_root}" || return 1
  fi
  ln -sfnT "${new_target}" "${deploy_root}/current.next" || return 1
  mv -fT -- "${deploy_root}/current.next" "${deploy_root}/current" || return 1
  sync -f "${deploy_root}" || return 1
  [[ "$(read_release_link current)" == "${release_id}" ]] || return 1
  if [[ -n "${old_release}" ]]; then
    [[ "$(read_release_link previous)" == "${old_release}" ]] || return 1
  fi
}

read_activation_intent() {
  local current_line previous_line target_line extra_line=''
  [[ -f "${activation_intent_path}" && ! -L "${activation_intent_path}" ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${activation_intent_root}")" == '700:0:0' ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${activation_intent_path}")" == '600:0:0' ]] || return 1
  [[ "$(awk 'END { print NR + 0 }' "${activation_intent_path}")" == '3' ]] || return 1
  IFS= read -r current_line <"${activation_intent_path}" || return 1
  previous_line="$(sed -n '2p' "${activation_intent_path}")" || return 1
  target_line="$(sed -n '3p' "${activation_intent_path}")" || return 1
  extra_line="$(sed -n '4p' "${activation_intent_path}")" || return 1
  [[ -z "${extra_line}" ]] || return 1
  [[ "${current_line}" =~ ^current[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  local -r original_current=${BASH_REMATCH[1]}
  [[ "${previous_line}" =~ ^previous[[:space:]](none|[0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  local -r original_previous=${BASH_REMATCH[1]}
  [[ "${target_line}" =~ ^target[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  local -r target_release=${BASH_REMATCH[1]}
  [[ "${target_release}" == "${release_id}" && \
    "${target_release}" != "${original_current}" && \
    "${target_release}" != "${original_previous}" ]] || return 1
  test -d "${deploy_root}/releases/${original_current}" || return 1
  if [[ "${original_previous}" != 'none' ]]; then
    test -d "${deploy_root}/releases/${original_previous}" || return 1
  fi
  test -d "${deploy_root}/releases/${target_release}" || return 1
  printf '%s %s %s\n' "${original_current}" "${original_previous}" "${target_release}"
}

recover_activation_intent_candidate() {
  local current_release previous_release previous_token expected_file relation
  if [[ ! -e "${activation_intent_next}" && ! -L "${activation_intent_next}" ]]; then
    return 0
  fi
  [[ ! -e "${activation_intent_path}" && ! -L "${activation_intent_path}" ]] || \
    fail 'activation intent and its staging candidate cannot coexist'
  recovery_candidate_file_is_safe \
    "${activation_intent_root}" "${activation_intent_next}" || \
    fail 'activation staging candidate is not a safe root-owned regular file'
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  [[ -n "${current_release}" && "${release_id}" != "${current_release}" && \
    "${release_id}" != "${previous_release}" ]] || \
    fail 'activation staging candidate no longer matches a safe release-link state'
  previous_token=${previous_release:-none}
  expected_file="${scratch_directory}/activation-intent.expected"
  printf 'current %s\nprevious %s\ntarget %s\n' \
    "${current_release}" "${previous_token}" "${release_id}" >"${expected_file}" || return 1
  relation="$(recovery_candidate_relation \
    "${activation_intent_root}" "${activation_intent_next}" "${expected_file}")" || \
    fail 'activation staging candidate is neither canonical nor a proven write prefix'
  case "${relation}" in
    exact)
      promote_recovery_candidate \
        "${activation_intent_root}" "${activation_intent_next}" \
        "${activation_intent_path}" must-be-absent || \
        fail 'could not promote the durable activation staging candidate'
      read_activation_intent >/dev/null || \
        fail 'promoted activation intent does not satisfy its transaction contract'
      ;;
    prefix)
      discard_partial_recovery_candidate \
        "${activation_intent_root}" "${activation_intent_next}" || \
        fail 'could not retire the proven partial activation staging candidate'
      ;;
    *) fail 'activation staging candidate has an unknown classification' ;;
  esac
}

arm_activation_intent() {
  local -r original_current=$1
  local -r original_previous=${2:-none}
  local -r target_release=$3
  local -r next_intent="${activation_intent_next}"
  [[ "${original_current}" =~ ^[0-9]{8}T[0-9]{6}Z$ && \
    "${original_previous}" =~ ^(none|[0-9]{8}T[0-9]{6}Z)$ && \
    "${target_release}" == "${release_id}" && \
    "${target_release}" != "${original_current}" && \
    "${target_release}" != "${original_previous}" ]] || return 1
  [[ ! -e "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]] || return 1
  install -d -m 0700 -o root -g root -- "${activation_intent_root}" || return 1
  [[ ! -L "${activation_intent_root}" ]] || return 1
  [[ ! -e "${activation_intent_path}" && ! -L "${activation_intent_path}" ]] || return 1
  [[ ! -e "${next_intent}" && ! -L "${next_intent}" ]] || return 1
  printf 'current %s\nprevious %s\ntarget %s\n' \
    "${original_current}" "${original_previous}" "${target_release}" >"${next_intent}" || return 1
  chmod 0600 "${next_intent}" || return 1
  sync -f "${next_intent}" || return 1
  mv -fT -- "${next_intent}" "${activation_intent_path}" || return 1
  sync -f "${activation_intent_root}" || return 1
  read_activation_intent >/dev/null
}

retire_activation_intent() {
  read_activation_intent >/dev/null || return 1
  unlink -- "${activation_intent_path}" || return 1
  sync -f "${activation_intent_root}" || return 1
}

reconcile_pending_activation() {
  local original_current original_previous_token target_release actual_current actual_previous
  local original_previous activation_config intent_record
  intent_record="$(read_activation_intent)" || \
    fail "activation intent is unreadable or unsafe: ${activation_intent_path}"
  read -r original_current original_previous_token target_release <<<"${intent_record}" || \
    fail "activation intent payload is incomplete: ${activation_intent_path}"
  [[ ! -e "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]] || \
    fail 'activation and rollback intents cannot be pending together'
  original_previous=${original_previous_token}
  [[ "${original_previous}" != 'none' ]] || original_previous=''
  actual_current="$(read_release_link current)"
  actual_previous="$(read_release_link previous)"
  if [[ !( "${actual_current}" == "${original_current}" && \
      "${actual_previous}" == "${original_previous}" ) && \
    !( "${actual_current}" == "${original_current}" && \
      "${actual_previous}" == "${original_current}" ) && \
    !( "${actual_current}" == "${target_release}" && \
      "${actual_previous}" == "${original_current}" ) ]]; then
    fail 'activation links do not match any safe state recorded by the pending transaction'
  fi
  assert_staged_edge_host_contract allow-pending
  verify_release_compose_edge_contract "${target_release}"
  verify_release_compose_edge_contract "${original_current}"
  verify_release_images "${target_release}"
  verify_release_images "${original_current}"
  activation_config="${scratch_directory}/reconciled-activation-nginx.conf"
  prepare_hardened_nginx_config \
    "${deploy_root}/releases/${target_release}/deploy/standalone/nginx/https.conf" \
    "${activation_config}" || \
    fail 'pending activation target cannot preserve the trusted real-IP contract'
  test_nginx_config "${target_release}" "${activation_config}"
  install_live_config "${activation_config}"
  compose_release "${target_release}" up -d --no-build --pull never \
    --force-recreate bot web || fail 'pending activation runtime could not be restarted'
  wait_for_services "${target_release}" bot web || \
    fail 'pending activation runtime did not become healthy'
  inner_upstream_https_smoke "${target_release}" || \
    fail 'pending activation inner HTTPS smoke failed'
  outer_caddy_https_smoke "${target_release}" || \
    fail 'pending activation outer HTTPS smoke failed'
  assert_staged_edge_contract allow-pending
  switch_release_links "${original_current}" || \
    fail 'pending activation release links could not be reconciled'
  [[ "$(read_release_link current)" == "${target_release}" && \
    "$(read_release_link previous)" == "${original_current}" ]] || \
    fail 'pending activation committed an unexpected current/previous release pair'
  record_deployment activate-reconciled "${target_release}" || \
    fail 'pending activation final audit could not be recorded'
  retire_activation_intent || \
    fail "activation reconciled, but its intent remains at ${activation_intent_path}"
  assert_staged_edge_contract
  log "activation of ${target_release} was reconciled after an interrupted link commit"
}

write_release_link() {
  local -r link_name=$1
  local -r target_release=$2
  local -r next_path="${deploy_root}/${link_name}.next"
  local -r link_path="${deploy_root}/${link_name}"
  [[ "${link_name}" == 'current' || "${link_name}" == 'previous' ]] || return 1
  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  test -d "${deploy_root}/releases/${target_release}" || return 1
  ln -sfnT "releases/${target_release}" "${next_path}" || return 1
  mv -fT -- "${next_path}" "${link_path}" || return 1
  sync -f "${deploy_root}" || return 1
  [[ "$(readlink -- "${link_path}")" == "releases/${target_release}" ]] || return 1
}

switch_rollback_links() {
  local -r old_current=$1
  local -r old_previous=$2
  [[ "${old_current}" != "${old_previous}" ]] || return 1
  write_release_link previous "${old_current}" || return 1
  write_release_link current "${old_previous}" || return 1
  [[ "$(read_release_link current)" == "${old_previous}" ]] || return 1
  [[ "$(read_release_link previous)" == "${old_current}" ]] || return 1
}

read_rollback_intent() {
  local current_line previous_line extra_line=''
  [[ -f "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${rollback_intent_root}")" == '700:0:0' ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${rollback_intent_path}")" == '600:0:0' ]] || return 1
  [[ "$(awk 'END { print NR + 0 }' "${rollback_intent_path}")" == '2' ]] || return 1
  IFS= read -r current_line <"${rollback_intent_path}" || return 1
  previous_line="$(sed -n '2p' "${rollback_intent_path}")" || return 1
  extra_line="$(sed -n '3p' "${rollback_intent_path}")" || return 1
  [[ -z "${extra_line}" ]] || return 1
  [[ "${current_line}" =~ ^current[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  local -r original_current=${BASH_REMATCH[1]}
  [[ "${previous_line}" =~ ^previous[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  local -r original_previous=${BASH_REMATCH[1]}
  [[ "${original_current}" == "${release_id}" && \
    "${original_current}" != "${original_previous}" ]] || return 1
  test -d "${deploy_root}/releases/${original_current}" || return 1
  test -d "${deploy_root}/releases/${original_previous}" || return 1
  printf '%s %s\n' "${original_current}" "${original_previous}"
}

recover_rollback_intent_candidate() {
  local current_release previous_release expected_file relation
  if [[ ! -e "${rollback_intent_next}" && ! -L "${rollback_intent_next}" ]]; then
    return 0
  fi
  [[ ! -e "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]] || \
    fail 'rollback intent and its staging candidate cannot coexist'
  recovery_candidate_file_is_safe \
    "${rollback_intent_root}" "${rollback_intent_next}" || \
    fail 'rollback staging candidate is not a safe root-owned regular file'
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  [[ -n "${current_release}" && -n "${previous_release}" && \
    "${current_release}" == "${release_id}" && \
    "${current_release}" != "${previous_release}" ]] || \
    fail 'rollback staging candidate no longer matches a safe release-link state'
  expected_file="${scratch_directory}/rollback-intent.expected"
  printf 'current %s\nprevious %s\n' \
    "${current_release}" "${previous_release}" >"${expected_file}" || return 1
  relation="$(recovery_candidate_relation \
    "${rollback_intent_root}" "${rollback_intent_next}" "${expected_file}")" || \
    fail 'rollback staging candidate is neither canonical nor a proven write prefix'
  case "${relation}" in
    exact)
      promote_recovery_candidate \
        "${rollback_intent_root}" "${rollback_intent_next}" \
        "${rollback_intent_path}" must-be-absent || \
        fail 'could not promote the durable rollback staging candidate'
      read_rollback_intent >/dev/null || \
        fail 'promoted rollback intent does not satisfy its transaction contract'
      ;;
    prefix)
      discard_partial_recovery_candidate \
        "${rollback_intent_root}" "${rollback_intent_next}" || \
        fail 'could not retire the proven partial rollback staging candidate'
      ;;
    *) fail 'rollback staging candidate has an unknown classification' ;;
  esac
}

arm_rollback_intent() {
  local -r original_current=$1
  local -r original_previous=$2
  local -r next_intent="${rollback_intent_next}"
  [[ "${original_current}" =~ ^[0-9]{8}T[0-9]{6}Z$ && \
    "${original_previous}" =~ ^[0-9]{8}T[0-9]{6}Z$ && \
    "${original_current}" != "${original_previous}" ]] || return 1
  [[ ! -e "${activation_intent_path}" && ! -L "${activation_intent_path}" ]] || return 1
  install -d -m 0700 -o root -g root -- "${rollback_intent_root}" || return 1
  [[ ! -L "${rollback_intent_root}" ]] || return 1
  [[ ! -e "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]] || return 1
  [[ ! -e "${next_intent}" && ! -L "${next_intent}" ]] || return 1
  printf 'current %s\nprevious %s\n' "${original_current}" "${original_previous}" \
    >"${next_intent}" || return 1
  chmod 0600 "${next_intent}" || return 1
  sync -f "${next_intent}" || return 1
  mv -fT -- "${next_intent}" "${rollback_intent_path}" || return 1
  sync -f "${rollback_intent_root}" || return 1
  read_rollback_intent >/dev/null
}

retire_rollback_intent() {
  read_rollback_intent >/dev/null || return 1
  unlink -- "${rollback_intent_path}" || return 1
  sync -f "${rollback_intent_root}" || return 1
}

reconcile_pending_rollback() {
  local original_current original_previous actual_current actual_previous rollback_config intent_record
  intent_record="$(read_rollback_intent)" || \
    fail "rollback intent is unreadable or unsafe: ${rollback_intent_path}"
  read -r original_current original_previous <<<"${intent_record}" || \
    fail "rollback intent payload is incomplete: ${rollback_intent_path}"
  [[ ! -e "${activation_intent_path}" && ! -L "${activation_intent_path}" ]] || \
    fail 'activation and rollback intents cannot be pending together'
  actual_current="$(read_release_link current)"
  actual_previous="$(read_release_link previous)"
  if [[ !( "${actual_current}" == "${original_current}" && \
      "${actual_previous}" == "${original_previous}" ) && \
    !( "${actual_current}" == "${original_current}" && \
      "${actual_previous}" == "${original_current}" ) && \
    !( "${actual_current}" == "${original_previous}" && \
      "${actual_previous}" == "${original_current}" ) ]]; then
    fail 'rollback links do not match any safe state recorded by the pending transaction'
  fi
  assert_staged_edge_host_contract allow-pending
  verify_release_compose_edge_contract "${original_previous}"
  verify_release_compose_edge_contract "${original_current}"
  verify_release_images "${original_previous}"
  verify_release_images "${original_current}"
  rollback_config="${scratch_directory}/reconciled-rollback-nginx.conf"
  prepare_hardened_nginx_config \
    "${deploy_root}/releases/${original_previous}/deploy/standalone/nginx/https.conf" \
    "${rollback_config}" || \
    fail 'pending rollback target cannot preserve the trusted real-IP contract'
  test_nginx_config "${original_previous}" "${rollback_config}"
  install_live_config "${rollback_config}"
  compose_release "${original_previous}" up -d --no-build --pull never \
    --force-recreate bot web || fail 'pending rollback runtime could not be restarted'
  wait_for_services "${original_previous}" bot web || \
    fail 'pending rollback runtime did not become healthy'
  inner_upstream_https_smoke "${original_previous}" || \
    fail 'pending rollback inner HTTPS smoke failed'
  outer_caddy_https_smoke "${original_previous}" || \
    fail 'pending rollback outer HTTPS smoke failed'
  assert_staged_edge_contract allow-pending
  switch_rollback_links "${original_current}" "${original_previous}" || \
    fail 'pending rollback release links could not be reconciled'
  [[ "$(read_release_link current)" == "${original_previous}" && \
    "$(read_release_link previous)" == "${original_current}" ]] || \
    fail 'pending rollback committed an unexpected current/previous release pair'
  record_deployment rollback-reconciled "${original_previous}" || \
    fail 'pending rollback final audit could not be recorded'
  retire_rollback_intent || \
    fail "rollback reconciled, but its intent remains at ${rollback_intent_path}"
  assert_staged_edge_contract
  log "rollback to ${original_previous} was reconciled after an interrupted link commit"
}

restore_release_links() {
  local -r original_current=$1
  local -r original_previous=$2
  restore_release_link current "${original_current}" || return 1
  restore_release_link previous "${original_previous}" || return 1
  [[ "$(read_release_link current)" == "${original_current}" ]] || return 1
  [[ "$(read_release_link previous)" == "${original_previous}" ]] || return 1
}

restore_release_link() {
  local -r link_name=$1
  local -r target_release=$2
  local -r link_path="${deploy_root}/${link_name}"
  local -r next_path="${link_path}.next"
  if [[ -n "${target_release}" ]]; then
    write_release_link "${link_name}" "${target_release}"
    return
  fi
  [[ ! -e "${link_path}" || -L "${link_path}" ]] || return 1
  [[ ! -e "${next_path}" || -L "${next_path}" ]] || return 1
  if [[ -L "${link_path}" ]]; then
    unlink -- "${link_path}" || return 1
  fi
  if [[ -L "${next_path}" ]]; then
    unlink -- "${next_path}" || return 1
  fi
  sync -f "${deploy_root}" || return 1
  [[ ! -e "${link_path}" && ! -L "${link_path}" && \
    ! -e "${next_path}" && ! -L "${next_path}" ]]
}

rollback_runtime() {
  local -r previous_release=$1
  if [[ -z "${previous_release}" ]]; then
    log 'staged Caddy activation has no rollback release'
    return 1
  fi
  log "restoring runtime release ${previous_release} with the current validated token"
  verify_release_compose_edge_contract "${previous_release}" || return 1
  verify_release_images "${previous_release}" || return 1
  compose_release "${previous_release}" up -d --no-build --pull never --force-recreate bot web || return 1
  wait_for_services "${previous_release}" bot web || return 1
  inner_upstream_https_smoke "${previous_release}" || return 1
  outer_caddy_https_smoke "${previous_release}" || return 1
  return 0
}

record_deployment() {
  local -r event=$1
  local -r target_release=$2
  local web_image_id bot_image_id
  web_image_id="$(docker image inspect --format '{{.Id}}' "cometa-bank-web:${target_release}")" || return 1
  bot_image_id="$(docker image inspect --format '{{.Id}}' "cometa-bank-bot:${target_release}")" || return 1
  printf '{"timestamp":"%s","event":"%s","release":"%s","webImage":"%s","botImage":"%s"}\n' \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "${event}" "${target_release}" \
    "${web_image_id}" "${bot_image_id}" >>"${deploy_root}/deployments.jsonl" || return 1
  chmod 0600 "${deploy_root}/deployments.jsonl" || return 1
  sync -f "${deploy_root}/deployments.jsonl" || return 1
}

verify_renewal_bundle() {
  local -r target_release=$1
  local -r bundle_kind="${2:-stable}"
  local -r target_root="${deploy_root}/releases/${target_release}"
  local -r service_source="${target_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service"
  local -r timer_source="${target_root}/deploy/standalone/systemd/cometa-bank-cert-renew.timer"
  local -r entrypoint_source="${target_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh"
  local -r worker_source="${target_root}/deploy/standalone/scripts/renew-certificates.sh"
  local -r verify_directory="${scratch_directory}/systemd-${target_release}"
  local -r verify_service="${verify_directory}/cometa-bank-cert-renew.service"
  local -r verify_timer="${verify_directory}/cometa-bank-cert-renew.timer"

  [[ "${target_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  [[ "${bundle_kind}" == stable || "${bundle_kind}" == legacy ]] || return 1
  [[ -f "${entrypoint_source}" && ! -L "${entrypoint_source}" && -x "${entrypoint_source}" ]] || \
    return 1
  [[ -f "${worker_source}" && ! -L "${worker_source}" && -x "${worker_source}" ]] || return 1
  [[ -f "${service_source}" && ! -L "${service_source}" && \
    -f "${timer_source}" && ! -L "${timer_source}" ]] || return 1
  grep -Fxq 'ExecStart=/usr/local/sbin/cometa-bank-renew-certificates' \
    "${service_source}" || return 1
  if [[ "${bundle_kind}" == stable ]]; then
    grep -Fxq "readonly renewal_worker='${host_renewal_worker}'" \
      "${entrypoint_source}" || return 1
    grep -Fxq 'exec "${renewal_worker}" "$@"' "${entrypoint_source}" || return 1
    grep -Fxq "    [[ \"\$1\" == '--recover-only' ]] || fail \"unknown argument: \$1\"" \
      "${worker_source}" || return 1
    grep -Fxq 'readonly renewal_record="${deploy_root}/state/renewal-bundle.release"' \
      "${worker_source}" || return 1
    grep -Fxq 'readonly release_root="${deploy_root}/releases/${release_id}"' \
      "${worker_source}" || return 1
    if grep -Fq 'current_target=' "${worker_source}"; then
      return 1
    fi
  fi
  install -d -m 0700 -- "${verify_directory}" || return 1
  sed \
    "s#^ExecStart=/usr/local/sbin/cometa-bank-renew-certificates\$#ExecStart=${entrypoint_source}#" \
    "${service_source}" >"${verify_service}" || return 1
  install -m 0600 -- "${timer_source}" "${verify_timer}" || return 1
  grep -Fxq "ExecStart=${entrypoint_source}" "${verify_service}" || return 1
  systemd-analyze verify "${verify_service}" "${verify_timer}"
}

read_renewal_release_marker() {
  local -r marker_path=$1
  local marker_release extra line_count

  [[ -f "${marker_path}" && ! -L "${marker_path}" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${marker_path}")" == 'root:root:600' ]] || return 1
  line_count="$(wc -l <"${marker_path}" | tr -d '[:space:]')" || return 1
  [[ "${line_count}" == '1' ]] || return 1
  read -r marker_release extra <"${marker_path}" || return 1
  [[ -z "${extra:-}" && "${marker_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  test -d "${deploy_root}/releases/${marker_release}" || return 1
  printf '%s\n' "${marker_release}"
}

write_renewal_release_marker() {
  local -r marker_path=$1
  local -r marker_release=$2
  local -r next_path="${marker_path}.next"
  local -r source_path="${scratch_directory}/$(basename -- "${marker_path}").source"

  [[ "${marker_path}" == "${host_renewal_record}" || \
    "${marker_path}" == "${host_renewal_pending_record}" ]] || return 1
  [[ "${marker_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  test -d "${deploy_root}/releases/${marker_release}" || return 1
  [[ -d "${deploy_root}/state" && ! -L "${deploy_root}/state" ]] || return 1
  [[ ! -L "${marker_path}" && ! -L "${next_path}" ]] || return 1
  [[ ! -e "${marker_path}" || -f "${marker_path}" ]] || return 1
  [[ ! -e "${next_path}" || -f "${next_path}" ]] || return 1
  printf '%s\n' "${marker_release}" >"${source_path}" || return 1
  chmod 0600 "${source_path}" || return 1
  install -m 0600 -o root -g root -- "${source_path}" "${next_path}" || return 1
  sync || return 1
  mv -fT -- "${next_path}" "${marker_path}" || return 1
  sync
}

remove_pending_renewal_marker() {
  if [[ ! -e "${host_renewal_pending_record}" && ! -L "${host_renewal_pending_record}" ]]; then
    return 0
  fi
  [[ -f "${host_renewal_pending_record}" && ! -L "${host_renewal_pending_record}" ]] || return 1
  unlink -- "${host_renewal_pending_record}" || return 1
  sync
}

read_legacy_timer_journal() {
  local journal_release timer_state extra line_count

  [[ -f "${host_renewal_legacy_timer_journal}" && \
    ! -L "${host_renewal_legacy_timer_journal}" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_legacy_timer_journal}")" == \
    'root:root:600' ]] || return 1
  line_count="$(wc -l <"${host_renewal_legacy_timer_journal}" | tr -d '[:space:]')" || \
    return 1
  [[ "${line_count}" == '1' ]] || return 1
  read -r journal_release timer_state extra <"${host_renewal_legacy_timer_journal}" || return 1
  [[ -z "${extra:-}" && "${journal_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  [[ "${timer_state}" == enabled || "${timer_state}" == enabled-runtime || \
    "${timer_state}" == disabled ]] || return 1
  test -d "${deploy_root}/releases/${journal_release}" || return 1
  printf '%s %s\n' "${journal_release}" "${timer_state}"
}

write_legacy_timer_journal() {
  local -r journal_release=$1
  local -r timer_state=$2
  local -r next_path="${host_renewal_legacy_timer_journal}.next"
  local -r source_path="${scratch_directory}/renewal-bundle.legacy-timer.source"

  [[ "${journal_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  [[ "${timer_state}" == enabled || "${timer_state}" == enabled-runtime || \
    "${timer_state}" == disabled ]] || return 1
  test -d "${deploy_root}/releases/${journal_release}" || return 1
  [[ -d "${deploy_root}/state" && ! -L "${deploy_root}/state" ]] || return 1
  [[ ! -L "${host_renewal_legacy_timer_journal}" && ! -L "${next_path}" ]] || return 1
  [[ ! -e "${host_renewal_legacy_timer_journal}" || \
    -f "${host_renewal_legacy_timer_journal}" ]] || return 1
  [[ ! -e "${next_path}" || -f "${next_path}" ]] || return 1
  printf '%s %s\n' "${journal_release}" "${timer_state}" >"${source_path}" || return 1
  chmod 0600 "${source_path}" || return 1
  install -m 0600 -o root -g root -- "${source_path}" "${next_path}" || return 1
  sync || return 1
  mv -fT -- "${next_path}" "${host_renewal_legacy_timer_journal}" || return 1
  sync
}

remove_legacy_timer_journal() {
  [[ -f "${host_renewal_legacy_timer_journal}" && \
    ! -L "${host_renewal_legacy_timer_journal}" ]] || return 1
  unlink -- "${host_renewal_legacy_timer_journal}" || return 1
  sync
}

renewal_timer_enablement() {
  local timer_state status

  if timer_state="$(systemctl is-enabled "${renewal_timer_unit}" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  case "${status}:${timer_state}" in
    0:enabled) printf 'enabled\n' ;;
    0:enabled-runtime) printf 'enabled-runtime\n' ;;
    1:disabled) printf 'disabled\n' ;;
    *) return 1 ;;
  esac
}

ensure_legacy_renewal_guard() {
  local -r guard_source="${scratch_directory}/10-bundle-migration.conf.source"

  [[ ! -L "${host_renewal_guard_directory}" ]] || return 1
  [[ ! -L "${host_renewal_guard}" && ! -L "${host_renewal_guard}.next" ]] || return 1
  [[ ! -e "${host_renewal_guard}" || -f "${host_renewal_guard}" ]] || return 1
  [[ ! -e "${host_renewal_guard}.next" || -f "${host_renewal_guard}.next" ]] || return 1
  printf '[Unit]\nConditionPathExists=!%s\n' \
    "${host_renewal_legacy_timer_journal}" >"${guard_source}" || return 1
  chmod 0644 "${guard_source}" || return 1
  install -d -m 0755 -o root -g root -- "${host_renewal_guard_directory}" || return 1
  if [[ -e "${host_renewal_guard}" ]]; then
    [[ "$(stat -c '%U:%G:%a' "${host_renewal_guard}")" == 'root:root:644' ]] || return 1
    cmp -s "${guard_source}" "${host_renewal_guard}" || return 1
  else
    install -m 0644 -o root -g root -- "${guard_source}" \
      "${host_renewal_guard}.next" || return 1
    mv -fT -- "${host_renewal_guard}.next" "${host_renewal_guard}" || return 1
    sync || return 1
  fi
  systemctl daemon-reload
}

remove_legacy_renewal_guard() {
  local -r guard_source="${scratch_directory}/10-bundle-migration.conf.source"

  [[ -f "${host_renewal_guard}" && ! -L "${host_renewal_guard}" ]] || return 1
  printf '[Unit]\nConditionPathExists=!%s\n' \
    "${host_renewal_legacy_timer_journal}" >"${guard_source}" || return 1
  cmp -s "${guard_source}" "${host_renewal_guard}" || return 1
  unlink -- "${host_renewal_guard}" || return 1
  sync || return 1
  systemctl daemon-reload
}

unit_is_inactive() {
  local -r unit_name=$1
  local active_state

  active_state="$(systemctl show --property ActiveState --value "${unit_name}")" || return 1
  [[ "${active_state}" == inactive || "${active_state}" == failed ]]
}

quiesce_legacy_renewal_units() {
  local -r target_release=$1
  local journal_payload journal_release timer_state

  if [[ -e "${host_renewal_legacy_timer_journal}" || \
    -L "${host_renewal_legacy_timer_journal}" ]]; then
    journal_payload="$(read_legacy_timer_journal)" || return 1
    read -r journal_release timer_state <<<"${journal_payload}"
    [[ "${journal_release}" == "${target_release}" ]] || return 1
    ensure_legacy_renewal_guard || return 1
  else
    timer_state="$(renewal_timer_enablement)" || return 1
    ensure_legacy_renewal_guard || return 1
    write_legacy_timer_journal "${target_release}" "${timer_state}" || return 1
  fi
  systemctl disable --now "${renewal_timer_unit}" || return 1
  systemctl stop "${renewal_service_unit}" || return 1
  [[ "$(renewal_timer_enablement)" == disabled ]] || return 1
  unit_is_inactive "${renewal_timer_unit}" || return 1
  unit_is_inactive "${renewal_service_unit}"
}

restore_legacy_renewal_units() {
  local -r target_release=$1
  local journal_payload journal_release timer_state recorded_release

  journal_payload="$(read_legacy_timer_journal)" || return 1
  read -r journal_release timer_state <<<"${journal_payload}"
  [[ "${journal_release}" == "${target_release}" ]] || return 1
  [[ ! -e "${host_renewal_pending_record}" && ! -L "${host_renewal_pending_record}" ]] || \
    return 1
  recorded_release="$(read_renewal_release_marker "${host_renewal_record}")" || return 1
  [[ "${recorded_release}" == "${target_release}" ]] || return 1
  verify_host_renewal_files "${target_release}" || return 1

  case "${timer_state}" in
    enabled) systemctl enable --now "${renewal_timer_unit}" || return 1 ;;
    enabled-runtime)
      systemctl enable --runtime --now "${renewal_timer_unit}" || return 1
      ;;
    disabled) systemctl disable --now "${renewal_timer_unit}" || return 1 ;;
    *) return 1 ;;
  esac
  [[ "$(renewal_timer_enablement)" == "${timer_state}" ]] || return 1
  remove_legacy_renewal_guard || return 1
  remove_legacy_timer_journal
}

host_renewal_migration_is_complete() {
  [[ ! -e "${host_renewal_pending_record}" && ! -L "${host_renewal_pending_record}" ]] && \
    [[ ! -e "${host_renewal_legacy_timer_journal}" && \
      ! -L "${host_renewal_legacy_timer_journal}" ]] && \
    [[ ! -e "${host_renewal_guard}" && ! -L "${host_renewal_guard}" ]] && \
    [[ ! -e "${host_renewal_guard}.next" && ! -L "${host_renewal_guard}.next" ]]
}

verify_host_renewal_files() {
  local -r target_release=$1
  local -r target_root="${deploy_root}/releases/${target_release}"
  local -r service_source="${target_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service"
  local -r timer_source="${target_root}/deploy/standalone/systemd/cometa-bank-cert-renew.timer"
  local -r entrypoint_source="${target_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh"
  local -r worker_source="${target_root}/deploy/standalone/scripts/renew-certificates.sh"

  verify_renewal_bundle "${target_release}" || return 1
  [[ -f "${host_renewal_entrypoint}" && ! -L "${host_renewal_entrypoint}" ]] || return 1
  [[ -f "${host_renewal_worker}" && ! -L "${host_renewal_worker}" ]] || return 1
  [[ -f "${host_renewal_service}" && ! -L "${host_renewal_service}" ]] || return 1
  [[ -f "${host_renewal_timer}" && ! -L "${host_renewal_timer}" ]] || return 1
  cmp -s "${entrypoint_source}" "${host_renewal_entrypoint}" || return 1
  cmp -s "${worker_source}" "${host_renewal_worker}" || return 1
  cmp -s "${service_source}" "${host_renewal_service}" || return 1
  cmp -s "${timer_source}" "${host_renewal_timer}" || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_entrypoint}")" == 'root:root:755' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_worker}")" == 'root:root:755' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_service}")" == 'root:root:644' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_timer}")" == 'root:root:644' ]] || return 1
  systemd-analyze verify "${host_renewal_service}" "${host_renewal_timer}"
}

verify_recorded_host_renewal_bundle() {
  local recorded_release

  [[ -f "${host_renewal_record}" && ! -L "${host_renewal_record}" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_record}")" == 'root:root:600' ]] || return 1
  [[ ! -e "${host_renewal_pending_record}" && ! -L "${host_renewal_pending_record}" ]] || return 1
  recorded_release="$(read_renewal_release_marker "${host_renewal_record}")" || return 1
  verify_host_renewal_files "${recorded_release}"
}

verify_candidate_host_renewal_bundle() {
  local -r target_release=$1
  local recorded_release

  verify_recorded_host_renewal_bundle || return 1
  recorded_release="$(read_renewal_release_marker "${host_renewal_record}")" || return 1
  [[ "${recorded_release}" == "${target_release}" ]] || return 1
  verify_host_renewal_files "${target_release}"
}

verify_legacy_host_renewal_bundle() {
  local -r current_release=$1
  local -r current_root="${deploy_root}/releases/${current_release}"
  local -r service_source="${current_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service"
  local -r timer_source="${current_root}/deploy/standalone/systemd/cometa-bank-cert-renew.timer"
  local -r entrypoint_source="${current_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh"

  verify_renewal_bundle "${current_release}" legacy || return 1
  [[ -f "${host_renewal_entrypoint}" && ! -L "${host_renewal_entrypoint}" ]] || return 1
  [[ -f "${host_renewal_service}" && ! -L "${host_renewal_service}" ]] || return 1
  [[ -f "${host_renewal_timer}" && ! -L "${host_renewal_timer}" ]] || return 1
  [[ ! -e "${host_renewal_worker}" && ! -L "${host_renewal_worker}" ]] || return 1
  cmp -s "${entrypoint_source}" "${host_renewal_entrypoint}" || return 1
  cmp -s "${service_source}" "${host_renewal_service}" || return 1
  cmp -s "${timer_source}" "${host_renewal_timer}" || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_entrypoint}")" == 'root:root:755' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_service}")" == 'root:root:644' ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "${host_renewal_timer}")" == 'root:root:644' ]] || return 1
}

host_renewal_paths_are_safe() {
  local host_path

  for host_path in \
    "${host_renewal_worker}" \
    "${host_renewal_service}" \
    "${host_renewal_timer}" \
    "${host_renewal_entrypoint}"; do
    [[ ! -L "${host_path}" && ! -L "${host_path}.next" ]] || return 1
    [[ ! -e "${host_path}" || -f "${host_path}" ]] || return 1
    [[ ! -e "${host_path}.next" || -f "${host_path}.next" ]] || return 1
  done
}

install_host_renewal_bundle() {
  local -r target_release=$1
  local -r target_root="${deploy_root}/releases/${target_release}"
  local -r service_source="${target_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service"
  local -r timer_source="${target_root}/deploy/standalone/systemd/cometa-bank-cert-renew.timer"
  local -r entrypoint_source="${target_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh"
  local -r worker_source="${target_root}/deploy/standalone/scripts/renew-certificates.sh"
  local pending_release

  verify_renewal_bundle "${target_release}" || return 1
  pending_release="$(read_renewal_release_marker "${host_renewal_pending_record}")" || return 1
  [[ "${pending_release}" == "${target_release}" ]] || return 1
  host_renewal_paths_are_safe || return 1
  install -d -m 0755 -o root -g root -- "$(dirname -- "${host_renewal_worker}")" || return 1

  install -m 0755 -o root -g root -- "${worker_source}" "${host_renewal_worker}.next" || return 1
  mv -fT -- "${host_renewal_worker}.next" "${host_renewal_worker}" || return 1
  install -m 0644 -o root -g root -- "${service_source}" "${host_renewal_service}.next" || return 1
  install -m 0644 -o root -g root -- "${timer_source}" "${host_renewal_timer}.next" || return 1
  mv -fT -- "${host_renewal_service}.next" "${host_renewal_service}" || return 1
  mv -fT -- "${host_renewal_timer}.next" "${host_renewal_timer}" || return 1
  sync || return 1

  # The wrapper moves last, only after the stable worker is durable.
  install -m 0755 -o root -g root -- "${entrypoint_source}" "${host_renewal_entrypoint}.next" || \
    return 1
  mv -fT -- "${host_renewal_entrypoint}.next" "${host_renewal_entrypoint}" || return 1
  sync || return 1
  systemctl daemon-reload || return 1
  verify_host_renewal_files "${target_release}" || return 1
  write_renewal_release_marker "${host_renewal_record}" "${target_release}" || return 1
  remove_pending_renewal_marker || return 1
  verify_recorded_host_renewal_bundle
}

ensure_host_renewal_bundle() {
  local -r target_release=$1
  local -r current_release=$2
  local recorded_release='' pending_release='' journal_payload='' journal_release=''
  local legacy_migration=false

  verify_renewal_bundle "${target_release}" || return 1
  [[ -d "${deploy_root}/state" && ! -L "${deploy_root}/state" ]] || return 1

  if [[ -e "${host_renewal_legacy_timer_journal}" || \
    -L "${host_renewal_legacy_timer_journal}" ]]; then
    journal_payload="$(read_legacy_timer_journal)" || return 1
    read -r journal_release _ <<<"${journal_payload}"
    [[ "${journal_release}" == "${target_release}" ]] || {
      log "legacy renewal migration for ${journal_release} is incomplete; resume that release first"
      return 1
    }
    legacy_migration=true
    quiesce_legacy_renewal_units "${target_release}" || return 1
  fi

  if [[ -e "${host_renewal_pending_record}" || -L "${host_renewal_pending_record}" ]]; then
    pending_release="$(read_renewal_release_marker "${host_renewal_pending_record}")" || return 1
    [[ "${pending_release}" == "${target_release}" ]] || {
      log "renewal-bundle migration for ${pending_release} is incomplete; resume that release first"
      return 1
    }
    install_host_renewal_bundle "${target_release}" || return 1
    if [[ "${legacy_migration}" == true ]]; then
      restore_legacy_renewal_units "${target_release}" || return 1
    fi
    return
  fi

  if [[ -e "${host_renewal_record}" || -L "${host_renewal_record}" ]]; then
    verify_recorded_host_renewal_bundle || return 1
    recorded_release="$(read_renewal_release_marker "${host_renewal_record}")" || return 1
    if [[ "${recorded_release}" == "${target_release}" ]]; then
      if [[ "${legacy_migration}" == true ]]; then
        restore_legacy_renewal_units "${target_release}" || return 1
      fi
      return 0
    fi
  elif [[ -n "${current_release}" ]]; then
    verify_legacy_host_renewal_bundle "${current_release}" || return 1
    legacy_migration=true
    quiesce_legacy_renewal_units "${target_release}" || return 1
  else
    host_renewal_paths_are_safe || return 1
    [[ ! -e "${host_renewal_entrypoint}" && ! -e "${host_renewal_worker}" && \
      ! -e "${host_renewal_service}" && ! -e "${host_renewal_timer}" ]] || return 1
  fi

  write_renewal_release_marker "${host_renewal_pending_record}" "${target_release}" || return 1
  install_host_renewal_bundle "${target_release}" || return 1
  if [[ "${legacy_migration}" == true ]]; then
    restore_legacy_renewal_units "${target_release}" || return 1
  fi
}

renewal_state_is_clean() {
  local container_name existing_container container_names volume_match

  docker info >/dev/null 2>&1 || return 1
  container_names="$(docker container ls --all --format '{{.Names}}')" || return 1
  for container_name in "${renewal_container}" "${recovery_helper_container}"; do
    while IFS= read -r existing_container; do
      [[ "${existing_container}" != "${container_name}" ]] || return 1
    done <<<"${container_names}"
  done
  volume_match="$(docker volume ls --quiet --filter "name=^${letsencrypt_volume}$")" || return 1
  if [[ -z "${volume_match}" ]]; then
    return 0
  fi
  [[ "${volume_match}" == "${letsencrypt_volume}" ]] || return 1
  docker volume inspect "${letsencrypt_volume}" >/dev/null 2>&1 || return 1
  docker run --rm --name "${recovery_helper_container}" --pull never \
    --label 'com.docker.compose.project=cometa-bank' \
    --label 'com.docker.compose.service=certbot' \
    --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=volume,src=${letsencrypt_volume},dst=/etc/letsencrypt,readonly" \
    --entrypoint sh "${certbot_image}" \
    -c '
      set -eu
      root=$1
      test ! -L "${root}"
      if test -e "${root}"; then
        test -d "${root}"
      fi
      for path in \
        "${root}/pending-recovery" \
        "${root}/pending-recovery.next" \
        "${root}/retired-recovery"; do
        test ! -e "${path}" && test ! -L "${path}"
      done
    ' sh "${recovery_volume_root}" >/dev/null
}

assert_renewal_state_clean() {
  renewal_state_is_clean || \
    fail "certificate renewal recovery is pending or unsafe; run: ${renewal_recovery_instruction}"
}

assert_host_renewal_migration_complete() {
  host_renewal_migration_is_complete || \
    fail 'host-owned certificate-renewal migration is incomplete; rerun prepare from its recorded release'
}

assert_prepare_renewal_state_clean() {
  if renewal_state_is_clean; then
    return 0
  fi
  if [[ -f "${host_renewal_record}" && ! -L "${host_renewal_record}" ]] && \
    host_renewal_migration_is_complete && verify_recorded_host_renewal_bundle; then
    fail "certificate renewal recovery is pending or unsafe; run: ${renewal_recovery_instruction}"
  fi
  fail 'certificate renewal state is unsafe before stable-worker migration; manual recovery is required'
}

replace_installed_caddy_config() {
  local -r source_config=$1
  local -r next_config="${installed_caddy_config}.cometa-bank.next"
  [[ -f "${source_config}" && ! -L "${source_config}" ]] || return 1
  [[ -f "${installed_caddy_config}" && ! -L "${installed_caddy_config}" ]] || return 1
  [[ ! -L "${next_config}" ]] || return 1
  install -m 0644 -o root -g root -- "${source_config}" "${next_config}" || return 1
  caddy validate --config "${next_config}" --adapter caddyfile >/dev/null || return 1
  sync -f "${next_config}" || return 1
  mv -fT -- "${next_config}" "${installed_caddy_config}" || return 1
  sync -f "$(dirname -- "${installed_caddy_config}")" || return 1
}

reload_caddy_edge() {
  local current_admin expected_mode attempt
  current_admin="$(detect_caddy_admin_address)" || return 1
  if (verify_caddy_config_contract \
    "${installed_caddy_config}" installed secure >/dev/null 2>&1); then
    expected_mode=strict
  elif (verify_caddy_config_contract \
    "${installed_caddy_config}" installed legacy >/dev/null 2>&1); then
    expected_mode=legacy
  else
    return 1
  fi
  timeout --foreground --signal=TERM --kill-after=2s 20s \
    caddy reload --address "${current_admin}" \
    --config "${installed_caddy_config}" --adapter caddyfile --force || return 1
  for (( attempt = 1; attempt <= 15; attempt += 1 )); do
    [[ "$(timeout --foreground --signal=TERM --kill-after=2s 8s \
      systemctl show --property ActiveState --value "${caddy_service}")" == 'active' ]] || \
      return 1
    case "${expected_mode}" in
      strict)
        if (assert_permissioned_caddy_admin_socket >/dev/null 2>&1) && \
          (assert_caddy_live_config_matches_file >/dev/null 2>&1); then
          return 0
        fi
        ;;
      legacy)
        if (assert_legacy_caddy_admin_listener >/dev/null 2>&1) || \
          (reconcile_stale_caddy_admin_socket && \
            (assert_legacy_caddy_admin_listener >/dev/null 2>&1)); then
          return 0
        fi
        ;;
      *) return 1 ;;
    esac
    sleep 1
  done
  return 1
}

read_edge_recovery_marker() {
  local operator_line current_line caddy_hash_line nginx_hash_line extra_line=''
  local operator_release current_release expected_caddy_hash expected_nginx_hash
  local actual_caddy_hash actual_nginx_hash
  [[ -d "${edge_recovery_root}" && ! -L "${edge_recovery_root}" ]] || return 1
  [[ -f "${edge_recovery_marker}" && ! -L "${edge_recovery_marker}" ]] || return 1
  [[ -f "${edge_recovery_caddy}" && ! -L "${edge_recovery_caddy}" ]] || return 1
  [[ -f "${edge_recovery_nginx}" && ! -L "${edge_recovery_nginx}" ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${edge_recovery_root}")" == '700:0:0' ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${edge_recovery_marker}")" == '600:0:0' ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${edge_recovery_caddy}")" == '600:0:0' ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "${edge_recovery_nginx}")" == '600:0:0' ]] || return 1
  [[ "$(awk 'END { print NR + 0 }' "${edge_recovery_marker}")" == '4' ]] || return 1
  IFS= read -r operator_line <"${edge_recovery_marker}" || return 1
  current_line="$(sed -n '2p' "${edge_recovery_marker}")" || return 1
  caddy_hash_line="$(sed -n '3p' "${edge_recovery_marker}")" || return 1
  nginx_hash_line="$(sed -n '4p' "${edge_recovery_marker}")" || return 1
  extra_line="$(sed -n '5p' "${edge_recovery_marker}")" || return 1
  [[ -z "${extra_line}" ]] || return 1
  [[ "${operator_line}" =~ ^operator[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  operator_release=${BASH_REMATCH[1]}
  [[ "${current_line}" =~ ^current[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  current_release=${BASH_REMATCH[1]}
  [[ "${caddy_hash_line}" =~ ^caddy-sha256[[:space:]]([a-f0-9]{64})$ ]] || return 1
  expected_caddy_hash=${BASH_REMATCH[1]}
  [[ "${nginx_hash_line}" =~ ^nginx-sha256[[:space:]]([a-f0-9]{64})$ ]] || return 1
  expected_nginx_hash=${BASH_REMATCH[1]}
  [[ "${operator_release}" == "${release_id}" ]] || return 1
  test -d "${deploy_root}/releases/${operator_release}" || return 1
  test -d "${deploy_root}/releases/${current_release}" || return 1
  actual_caddy_hash="$(sha256sum "${edge_recovery_caddy}" | awk '{print $1}')" || return 1
  actual_nginx_hash="$(sha256sum "${edge_recovery_nginx}" | awk '{print $1}')" || return 1
  [[ "${actual_caddy_hash}" == "${expected_caddy_hash}" && \
    "${actual_nginx_hash}" == "${expected_nginx_hash}" ]] || return 1
  printf '%s %s\n' "${operator_release}" "${current_release}"
}

verify_edge_recovery_snapshots() {
  read_edge_recovery_marker >/dev/null || return 1
  caddy validate --config "${edge_recovery_caddy}" --adapter caddyfile >/dev/null || return 1
  if (verify_caddy_config_contract "${edge_recovery_caddy}" installed secure >/dev/null 2>&1); then
    :
  elif (verify_caddy_config_contract "${edge_recovery_caddy}" installed legacy >/dev/null 2>&1); then
    :
  else
    return 1
  fi
}

edge_recovery_staging_exists() {
  local candidate
  for candidate in \
    "${edge_recovery_caddy_next}" \
    "${edge_recovery_nginx_next}" \
    "${edge_recovery_marker_next}"; do
    if [[ -e "${candidate}" || -L "${candidate}" ]]; then
      return 0
    fi
  done
  return 1
}

recover_edge_recovery_candidates() {
  local -r current_release=$1
  local expected_marker caddy_candidate nginx_candidate
  local caddy_hash nginx_hash marker_relation caddy_relation nginx_relation candidate
  edge_recovery_staging_exists || return 0
  [[ "${apply_rollback}" == true ]] || return 1
  [[ ! -e "${edge_recovery_marker}" && ! -L "${edge_recovery_marker}" ]] || \
    fail 'edge recovery marker and staging candidates cannot coexist'
  [[ "${current_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  [[ -f "${installed_caddy_config}" && ! -L "${installed_caddy_config}" ]] || return 1
  [[ -f "${live_config}" && ! -L "${live_config}" ]] || return 1

  if [[ ! -e "${edge_recovery_marker_next}" && ! -L "${edge_recovery_marker_next}" ]]; then
    for candidate in "${edge_recovery_caddy_next}" "${edge_recovery_nginx_next}"; do
      if [[ -e "${candidate}" || -L "${candidate}" ]]; then
        if [[ "${candidate}" == "${edge_recovery_caddy_next}" ]]; then
          recovery_candidate_relation \
            "${edge_recovery_root}" "${candidate}" "${installed_caddy_config}" >/dev/null || \
            fail 'unarmed Caddy recovery candidate is not a proven source prefix'
        else
          recovery_candidate_relation \
            "${edge_recovery_root}" "${candidate}" "${live_config}" >/dev/null || \
            fail 'unarmed Nginx recovery candidate is not a proven source prefix'
        fi
      fi
    done
    for candidate in "${edge_recovery_caddy_next}" "${edge_recovery_nginx_next}"; do
      if [[ -e "${candidate}" || -L "${candidate}" ]]; then
        discard_partial_recovery_candidate "${edge_recovery_root}" "${candidate}" || \
          fail 'could not retire a proven partial edge recovery candidate'
      fi
    done
    return 0
  fi

  caddy_hash="$(sha256sum "${installed_caddy_config}" | awk '{print $1}')" || return 1
  nginx_hash="$(sha256sum "${live_config}" | awk '{print $1}')" || return 1
  [[ "${caddy_hash}" =~ ^[a-f0-9]{64}$ && "${nginx_hash}" =~ ^[a-f0-9]{64}$ ]] || \
    return 1
  expected_marker="${scratch_directory}/edge-recovery-marker.expected"
  printf 'operator %s\ncurrent %s\ncaddy-sha256 %s\nnginx-sha256 %s\n' \
    "${release_id}" "${current_release}" "${caddy_hash}" "${nginx_hash}" \
    >"${expected_marker}" || return 1
  marker_relation="$(recovery_candidate_relation \
    "${edge_recovery_root}" "${edge_recovery_marker_next}" "${expected_marker}")" || \
    fail 'edge recovery marker candidate is neither canonical nor a proven write prefix'

  if [[ -e "${edge_recovery_caddy_next}" || -L "${edge_recovery_caddy_next}" ]]; then
    caddy_candidate=${edge_recovery_caddy_next}
  else
    caddy_candidate=${edge_recovery_caddy}
  fi
  if [[ -e "${edge_recovery_nginx_next}" || -L "${edge_recovery_nginx_next}" ]]; then
    nginx_candidate=${edge_recovery_nginx_next}
  else
    nginx_candidate=${edge_recovery_nginx}
  fi
  caddy_relation="$(recovery_candidate_relation \
    "${edge_recovery_root}" "${caddy_candidate}" "${installed_caddy_config}")" || \
    fail 'edge Caddy snapshot candidate is neither canonical nor a proven write prefix'
  nginx_relation="$(recovery_candidate_relation \
    "${edge_recovery_root}" "${nginx_candidate}" "${live_config}")" || \
    fail 'edge Nginx snapshot candidate is neither canonical nor a proven write prefix'
  if [[ "${caddy_candidate}" == "${edge_recovery_caddy}" && \
    "${caddy_relation}" != exact ]] || \
    [[ "${nginx_candidate}" == "${edge_recovery_nginx}" && \
      "${nginx_relation}" != exact ]]; then
    fail 'a committed edge snapshot is partial without a committed recovery marker'
  fi

  if [[ "${marker_relation}" == exact && "${caddy_relation}" == exact && \
    "${nginx_relation}" == exact ]]; then
    if [[ "${caddy_candidate}" == "${edge_recovery_caddy_next}" ]]; then
      promote_recovery_candidate \
        "${edge_recovery_root}" "${edge_recovery_caddy_next}" \
        "${edge_recovery_caddy}" replace-safe-snapshot || \
        fail 'could not promote the durable Caddy recovery snapshot'
    fi
    if [[ "${nginx_candidate}" == "${edge_recovery_nginx_next}" ]]; then
      promote_recovery_candidate \
        "${edge_recovery_root}" "${edge_recovery_nginx_next}" \
        "${edge_recovery_nginx}" replace-safe-snapshot || \
        fail 'could not promote the durable Nginx recovery snapshot'
    fi
    promote_recovery_candidate \
      "${edge_recovery_root}" "${edge_recovery_marker_next}" \
      "${edge_recovery_marker}" must-be-absent || \
      fail 'could not promote the durable edge recovery marker'
    verify_edge_recovery_snapshots || \
      fail 'promoted edge recovery snapshots do not satisfy their transaction contract'
    return 0
  fi

  discard_partial_recovery_candidate \
    "${edge_recovery_root}" "${edge_recovery_marker_next}" || \
    fail 'could not retire the proven partial edge marker candidate'
  for candidate in "${edge_recovery_caddy_next}" "${edge_recovery_nginx_next}"; do
    if [[ -e "${candidate}" || -L "${candidate}" ]]; then
      discard_partial_recovery_candidate "${edge_recovery_root}" "${candidate}" || \
        fail 'could not retire a proven partial edge snapshot candidate'
    fi
  done
}

arm_edge_recovery_snapshots() {
  local -r source_caddy=$1
  local -r source_nginx=$2
  local -r current_release=$3
  local -r next_caddy="${edge_recovery_caddy_next}"
  local -r next_nginx="${edge_recovery_nginx_next}"
  local -r next_marker="${edge_recovery_marker_next}"
  local caddy_hash nginx_hash
  [[ -f "${source_caddy}" && ! -L "${source_caddy}" ]] || return 1
  [[ -f "${source_nginx}" && ! -L "${source_nginx}" ]] || return 1
  [[ "${current_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  test -d "${deploy_root}/releases/${current_release}" || return 1
  install -d -m 0700 -o root -g root -- "${edge_recovery_root}" || return 1
  [[ ! -L "${edge_recovery_root}" ]] || return 1
  if [[ -e "${edge_recovery_marker}" || -L "${edge_recovery_marker}" ]]; then
    local recorded_operator recorded_current marker_record
    marker_record="$(read_edge_recovery_marker)" || return 1
    read -r recorded_operator recorded_current <<<"${marker_record}" || return 1
    [[ "${recorded_operator}" == "${release_id}" && \
      "${recorded_current}" == "${current_release}" ]] || return 1
    verify_edge_recovery_snapshots
    return
  fi
  [[ ! -e "${next_caddy}" && ! -L "${next_caddy}" ]] || return 1
  [[ ! -e "${next_nginx}" && ! -L "${next_nginx}" ]] || return 1
  [[ ! -e "${next_marker}" && ! -L "${next_marker}" ]] || return 1
  install -m 0600 -o root -g root -- "${source_caddy}" "${next_caddy}" || return 1
  install -m 0600 -o root -g root -- "${source_nginx}" "${next_nginx}" || return 1
  caddy_hash="$(sha256sum "${next_caddy}" | awk '{print $1}')" || return 1
  nginx_hash="$(sha256sum "${next_nginx}" | awk '{print $1}')" || return 1
  [[ "${caddy_hash}" =~ ^[a-f0-9]{64}$ && "${nginx_hash}" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf 'operator %s\ncurrent %s\ncaddy-sha256 %s\nnginx-sha256 %s\n' \
    "${release_id}" "${current_release}" "${caddy_hash}" "${nginx_hash}" \
    >"${next_marker}" || return 1
  chmod 0600 "${next_marker}" || return 1
  sync -f "${next_caddy}" || return 1
  sync -f "${next_nginx}" || return 1
  sync -f "${next_marker}" || return 1
  mv -fT -- "${next_caddy}" "${edge_recovery_caddy}" || return 1
  mv -fT -- "${next_nginx}" "${edge_recovery_nginx}" || return 1
  sync -f "${edge_recovery_root}" || return 1
  mv -fT -- "${next_marker}" "${edge_recovery_marker}" || return 1
  sync -f "${edge_recovery_root}" || return 1
  verify_edge_recovery_snapshots
}

retire_edge_recovery_snapshots() {
  verify_edge_recovery_snapshots || return 1
  unlink -- "${edge_recovery_marker}" || return 1
  sync -f "${edge_recovery_root}" || return 1
}

restart_current_web() {
  local -r current_release=$1
  compose_release "${current_release}" up -d --no-deps --no-build --pull never \
    --force-recreate web || return 1
  wait_for_services "${current_release}" web || return 1
  service_health "${current_release}" bot
}

harden_edge() {
  local current_release actual_current recorded_operator recorded_current marker_record
  local hardened_caddy hardened_nginx original_caddy original_nginx
  local edge_pending=false
  actual_current="$(read_release_link current)"
  [[ -n "${actual_current}" ]] || fail 'edge hardening requires an existing current release'
  assert_no_pending_link_intent
  if edge_recovery_staging_exists; then
    [[ ! -e "${edge_recovery_marker}" && ! -L "${edge_recovery_marker}" ]] || \
      fail 'edge recovery marker and staging candidates cannot coexist'
    if [[ "${apply_rollback}" != true ]]; then
      printf 'Interrupted edge recovery staging is pending under %s.\nRerun with: release.sh harden-edge --apply\n' \
        "${edge_recovery_root}"
      return 0
    fi
    recover_edge_recovery_candidates "${actual_current}"
  fi
  check_docker_daemon_perimeter_contract
  if [[ -e "${edge_recovery_marker}" || -L "${edge_recovery_marker}" ]]; then
    marker_record="$(read_edge_recovery_marker)" || \
      fail "edge recovery marker or snapshots are unreadable or unsafe: ${edge_recovery_marker}"
    read -r recorded_operator recorded_current <<<"${marker_record}" || \
      fail "edge recovery marker payload is incomplete: ${edge_recovery_marker}"
    [[ "${recorded_operator}" == "${release_id}" && \
      "${recorded_current}" == "${actual_current}" ]] || \
      fail 'edge recovery must be resumed through its recorded operator release before any release switch'
    current_release=${recorded_current}
    edge_pending=true
  else
    current_release=${actual_current}
  fi
  verify_caddy_config_contract "${tracked_caddy_config}" tracked secure
  verify_release_compose_edge_contract "${current_release}"
  verify_release_images "${current_release}"
  assert_docker_network_contract cometa-bank_edge allow-missing
  assert_docker_network_contract cometa-bank_egress allow-missing
  assert_docker_network_contract cometa-bank_public allow-missing
  if [[ "${edge_pending}" == true ]]; then
    assert_running_compose_service_bindings web allow-zero
    assert_running_compose_service_bindings bot
    service_health "${current_release}" bot || \
      fail 'current bot service must remain healthy while edge hardening recovery is pending'
  else
    service_health "${current_release}" bot || fail 'current bot service is not healthy'
    service_health "${current_release}" web || fail 'current web service is not healthy'
    assert_running_compose_service_bindings web
    assert_running_compose_service_bindings bot
  fi
  assert_legacy_certbot_units_quiesced
  [[ "$(systemctl is-enabled "${caddy_service}" 2>/dev/null)" == 'enabled' ]] || \
    fail "${caddy_service} must be enabled"
  [[ "$(systemctl show --property ActiveState --value "${caddy_service}")" == 'active' ]] || \
    fail "${caddy_service} must be active"
  detect_caddy_admin_address >/dev/null || \
    fail 'Caddy admin endpoint is neither the exact legacy listener nor the permissioned Unix socket'
  assert_public_tcp_listener_owned_by_caddy 80
  assert_public_tcp_listener_owned_by_caddy 443
  if [[ "${edge_pending}" != true ]]; then
    verify_served_inner_certificates || \
      fail 'the retained inner certificate is untrusted, mismatched, or expires in less than 21 days'
  fi

  hardened_caddy="${scratch_directory}/Caddyfile.hardened"
  hardened_nginx="${scratch_directory}/nginx.hardened.conf"
  original_caddy="${edge_recovery_caddy}"
  original_nginx="${edge_recovery_nginx}"
  prepare_hardened_caddy_config "${installed_caddy_config}" "${hardened_caddy}" || \
    fail 'installed Caddy config is neither the exact legacy bridge nor the hardened contract'
  prepare_hardened_nginx_config "${live_config}" "${hardened_nginx}" || \
    fail 'live Nginx config is partial, duplicated, symlinked, or otherwise unsafe to harden'
  test_nginx_config "${current_release}" "${hardened_nginx}"

  if [[ "${apply_rollback}" != true ]]; then
    if [[ "${edge_pending}" == true ]]; then
      printf 'Interrupted edge hardening is pending at %s.\nRerun with: release.sh harden-edge --apply\n' \
        "${edge_recovery_marker}"
      return 0
    fi
    printf '%s\n' \
      'Edge hardening plan:' \
      '- authenticate the retained loopback TLS certificate and set host-wide Caddy protocols to h1/h2' \
      '- restore the original client IP before legacy Nginx rate limiting' \
      '- preserve unrelated Caddy route blocks and keep the bot container running' \
      'Rerun with: release.sh harden-edge --apply'
    return 0
  fi

  if [[ "${edge_pending}" != true ]]; then
    arm_edge_recovery_snapshots \
      "${installed_caddy_config}" "${live_config}" "${current_release}" || \
      fail "could not arm durable edge recovery snapshots under ${edge_recovery_root}"
  fi
  verify_edge_recovery_snapshots || \
    fail "durable edge recovery snapshots are unsafe under ${edge_recovery_root}"
  reconcile_stale_caddy_admin_socket || \
    fail 'legacy Caddy runtime has an unsafe or unrecoverable stale admin socket'
  test_nginx_config "${current_release}" "${original_nginx}" || \
    fail "durable Nginx recovery snapshot is invalid: ${original_nginx}"
  if ! (
    replace_installed_caddy_config "${hardened_caddy}" &&
      reload_caddy_edge &&
      assert_no_public_udp_listener 443 &&
      outer_caddy_https_smoke "${current_release}" &&
      install_live_config "${hardened_nginx}" &&
      restart_current_web "${current_release}" &&
      inner_upstream_https_smoke "${current_release}" &&
      outer_caddy_https_smoke "${current_release}" &&
      verify_caddy_config_contract "${installed_caddy_config}" installed secure &&
      verify_nginx_real_ip_contract "${live_config}" &&
      assert_running_compose_service_bindings web &&
      assert_running_compose_service_bindings bot
  ); then
    log 'edge hardening failed; restoring both configuration snapshots'
    if ! (
      install_live_config "${original_nginx}" &&
        restart_current_web "${current_release}" &&
        replace_installed_caddy_config "${original_caddy}" &&
        reload_caddy_edge &&
        inner_upstream_https_smoke "${current_release}" &&
        outer_caddy_https_smoke "${current_release}"
    ); then
      fail "edge hardening and automatic recovery both failed; restore ${edge_recovery_caddy} and ${edge_recovery_nginx} manually"
    fi
    retire_edge_recovery_snapshots || \
      fail "edge hardening was restored, but the recovery marker remains at ${edge_recovery_marker}"
    fail 'edge hardening failed; both original configurations were restored and verified'
  fi
  retire_edge_recovery_snapshots || \
    fail "edge hardening succeeded, but the recovery marker remains at ${edge_recovery_marker}"
  assert_staged_edge_contract
  log 'edge hardening is applied and verified'
}

prepare_release() {
  local current_release manifest current_bot current_bot_image expected_bot_image
  current_release="$(read_release_link current)"
  [[ -n "${current_release}" ]] || \
    fail 'staged Caddy compatibility release requires an existing current release'
  assert_staged_edge_contract
  verify_release_compose_edge_contract "${release_id}"
  verify_release_compose_edge_contract "${current_release}"
  if [[ "${repair_bot}" == true ]]; then
    verify_release_images "${current_release}"
    current_bot="$(running_compose_service_container_id bot)" || \
      fail 'bot repair requires exactly one running current bot'
    current_bot_image="$(docker inspect --format '{{.Image}}' "${current_bot}")" || \
      fail 'could not inspect current bot image for repair'
    expected_bot_image="$(docker image inspect --format '{{.Id}}' "cometa-bank-bot:${current_release}")" || \
      fail 'could not inspect immutable current bot image for repair'
    [[ "${current_bot_image}" == "${expected_bot_image}" ]] || \
      fail 'bot repair requires the immutable current bot image'
    log 'preparing bot repair; only current bot health and restart count are waived'
  else
    service_health "${current_release}" bot || fail 'current bot service is not healthy'
  fi
  service_health "${current_release}" web || fail 'current web service is not healthy'
  inner_upstream_https_smoke "${current_release}" || \
    fail 'current inner upstream HTTPS smoke test failed'
  outer_caddy_https_smoke "${current_release}" || \
    fail 'current outer Caddy HTTPS smoke test failed'
  manifest="$(image_manifest_path "${release_id}")"
  if [[ -f "${manifest}" ]]; then
    log "reusing verified immutable images for ${release_id}"
    verify_release_images "${release_id}"
  else
    if docker image inspect "cometa-bank-web:${release_id}" >/dev/null 2>&1 || \
      docker image inspect "cometa-bank-bot:${release_id}" >/dev/null 2>&1; then
      fail "release ${release_id} has unrecorded image tags; refusing to rebuild or retag them"
    fi
    log "building immutable images for ${release_id}"
    compose_release "${release_id}" build web bot
    verify_image "cometa-bank-web:${release_id}" "${release_id}"
    verify_image "cometa-bank-bot:${release_id}" "${release_id}"
    record_image_manifest "${release_id}"
    verify_release_images "${release_id}"
  fi
  test_nginx_config "${release_id}" "${https_config}"
  assert_staged_edge_contract
  log "release ${release_id} is prepared"
}

issue_certificate() {
  local current_release
  local -a contact_arguments
  current_release="$(read_release_link current)"
  [[ -z "${current_release}" ]] || fail 'issue-certificate is only valid during first install'
  if [[ "${without_email}" == true ]]; then
    [[ -z "${email}" ]] || fail '--email and --no-email are mutually exclusive'
    contact_arguments=(--register-unsafely-without-email)
  else
    grep -Eq '^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' \
      <<<"${email}" || fail 'pass a valid --email address or explicitly use --no-email'
    contact_arguments=(--email "${email}")
  fi
  validate_ipv4 "${server_ipv4}" || fail '--server-ipv4 must be a valid IPv4 address'
  validate_dns_records A "${server_ipv4}"
  if [[ -n "${server_ipv6}" ]]; then
    [[ "${server_ipv6}" == *:* && "${server_ipv6}" =~ ^[0-9A-Fa-f:]+$ ]] || \
      fail '--server-ipv6 must be a plain IPv6 address'
    validate_dns_records AAAA "${server_ipv6}"
  else
    reject_unexpected_ipv6
  fi
  service_health "${release_id}" web || fail 'run prepare and keep the HTTP preview healthy first'
  verify_candidate_host_renewal_bundle "${release_id}" || \
    fail 'host-owned certificate-renewal worker does not match the certificate release'
  assert_host_renewal_migration_complete
  assert_renewal_state_clean

  log 'requesting the apex + www certificate through HTTP-01'
  compose_release "${release_id}" --profile tools run --rm --no-deps --pull missing certbot \
    certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --non-interactive \
    --agree-tos \
    --no-eff-email \
    "${contact_arguments[@]}" \
    --cert-name "${domain}" \
    --domain "${domain}" \
    --domain "${www_domain}"
  verify_certificate_lineage

  test_nginx_config "${release_id}" "${https_config}"
  install_live_config "${https_config}"
  if ! compose_release "${release_id}" up -d --no-build --pull never --force-recreate web || \
    ! wait_for_services "${release_id}" web || ! local_tls_web_smoke; then
    log 'TLS switch failed; restoring the HTTP preview config'
    install_live_config "${http_config}"
    if ! compose_release "${release_id}" up -d --no-build --pull never --force-recreate web || \
      ! wait_for_services "${release_id}" web || \
      ! curl --disable --fail --silent --show-error --noproxy '*' \
        --connect-timeout "${tls_probe_connect_timeout}" --max-time "${tls_probe_max_time}" \
        --header "Host: ${domain}" http://127.0.0.1/ >/dev/null; then
      fail 'certificate exists, and both the TLS switch and HTTP recovery failed'
    fi
    fail 'certificate exists, but the local TLS switch failed'
  fi
  log 'certificate is valid and the local TLS endpoint is healthy'
}

install_token() {
  local -r helper="${release_root}/deploy/bot/install-secret.sh"
  test -x "${helper}" || fail 'token installer is missing or not executable'
  COMETA_BOT_UID="${bot_uid}" "${helper}"
  log 'validated token installed; activate the release immediately'
}

activate_release() {
  local current_release previous_release previous_config runtime_restored links_restored
  local bridge_operator_path
  recover_activation_intent_candidate
  if [[ -e "${activation_intent_path}" || -L "${activation_intent_path}" ]]; then
    reconcile_pending_activation
    return
  fi
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  [[ -n "${current_release}" ]] || \
    fail 'staged Caddy activation requires an existing rollback release'
  bridge_operator_path="$(legacy_bridge_operator_path "${current_release}" "${release_id}")"
  warn_pinned_bridge_operator activation-risk "${current_release}" "${bridge_operator_path}"
  assert_staged_edge_host_contract
  verify_release_compose_edge_contract "${release_id}"
  verify_release_compose_edge_contract "${current_release}"
  verify_release_images "${release_id}"
  guard_server_authority_release_transition "${release_id}" "${current_release}"
  [[ -f "${token_path}" && ! -L "${token_path}" ]] || fail 'install the bot token first'
  [[ "$(stat -c '%u:%g:%a' "${token_path}")" == "${bot_uid}:${bot_uid}:600" ]] || \
    fail 'bot token must be owned by service UID 10001 with mode 0600'
  prepare_database_backup "${release_id}" "${current_release}"
  test_nginx_config "${release_id}" "${https_config}"
  previous_config="${scratch_directory}/previous-nginx.conf"
  if [[ -f "${live_config}" ]]; then
    install -m 0600 -- "${live_config}" "${previous_config}"
  fi
  install_live_config "${https_config}"

  log "activating release ${release_id}"
  if ! compose_release "${release_id}" up -d --no-build --pull never --force-recreate bot web || \
    ! wait_for_services "${release_id}" bot web || \
    ! inner_upstream_https_smoke "${release_id}" || \
    ! outer_caddy_https_smoke "${release_id}"; then
    print_diagnostics "${release_id}"
    if [[ -s "${previous_config}" ]]; then
      install_live_config "${previous_config}"
    fi
    if rollback_runtime "${current_release}"; then
      fail "candidate ${release_id} failed; runtime rollback is healthy"
    fi
    fail 'candidate activation and runtime rollback both failed'
  fi
  assert_staged_edge_contract

  if ! record_deployment activation-ready "${release_id}"; then
    [[ ! -s "${previous_config}" ]] || install_live_config "${previous_config}"
    if rollback_runtime "${current_release}"; then
      fail 'candidate was healthy, but the pre-commit audit failed; prior runtime was restored'
    fi
    fail 'candidate was healthy, but both the pre-commit audit and prior runtime restore failed'
  fi
  if ! arm_activation_intent "${current_release}" "${previous_release:-none}" "${release_id}"; then
    [[ ! -s "${previous_config}" ]] || install_live_config "${previous_config}"
    runtime_restored=false
    rollback_runtime "${current_release}" && runtime_restored=true
    links_restored=false
    restore_release_links "${current_release}" "${previous_release}" && links_restored=true
    [[ "${runtime_restored}" == true && "${links_restored}" == true ]] || \
      fail "activation intent could not be armed and prior-state recovery needs manual repair"
    fail "activation intent could not be armed; prior runtime and links were restored"
  fi
  if ! switch_release_links "${current_release}"; then
    if [[ -s "${previous_config}" ]]; then
      install_live_config "${previous_config}"
    fi
    runtime_restored=false
    rollback_runtime "${current_release}" && runtime_restored=true
    links_restored=false
    restore_release_links "${current_release}" "${previous_release}" && links_restored=true
    [[ "${runtime_restored}" == true && "${links_restored}" == true ]] || \
      fail "runtime was healthy, but link recovery needs manual repair using ${activation_intent_path}"
    retire_activation_intent || \
      fail "prior runtime and links were restored, but activation intent remains at ${activation_intent_path}"
    fail 'runtime was healthy, but the atomic release switch failed; prior state was restored'
  fi
  if ! record_deployment activate "${release_id}"; then
    [[ ! -s "${previous_config}" ]] || install_live_config "${previous_config}"
    runtime_restored=false
    rollback_runtime "${current_release}" && runtime_restored=true
    links_restored=false
    restore_release_links "${current_release}" "${previous_release}" && links_restored=true
    [[ "${runtime_restored}" == true && "${links_restored}" == true ]] || \
      fail "final deployment audit failed and recovery needs manual repair using ${activation_intent_path}"
    retire_activation_intent || \
      fail "final audit recovery succeeded, but activation intent remains at ${activation_intent_path}"
    fail 'final deployment audit failed; prior runtime and release links were restored'
  fi
  retire_activation_intent || \
    fail "activation completed, but its intent remains at ${activation_intent_path}"
  assert_staged_edge_contract
  warn_pinned_bridge_operator activation-live "${current_release}" "${bridge_operator_path}"
  log "release ${release_id} is live and healthy"
}

rollback_release() {
  local current_release previous_release current_config bridge_operator_path rollback_config
  local runtime_restored links_restored
  if [[ -e "${rollback_intent_next}" || -L "${rollback_intent_next}" ]]; then
    [[ ! -e "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]] || \
      fail 'rollback intent and its staging candidate cannot coexist'
    if [[ "${apply_rollback}" != true ]]; then
      printf 'Interrupted rollback staging is pending at %s.\nRerun with: release.sh rollback --apply\n' \
        "${rollback_intent_next}"
      return 0
    fi
    recover_rollback_intent_candidate
  fi
  if [[ -e "${rollback_intent_path}" || -L "${rollback_intent_path}" ]]; then
    if [[ "${apply_rollback}" != true ]]; then
      printf 'Interrupted rollback is pending at %s.\nRerun with: release.sh rollback --apply\n' \
        "${rollback_intent_path}"
      return 0
    fi
    reconcile_pending_rollback
    return
  fi
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  [[ -n "${current_release}" && -n "${previous_release}" ]] || fail 'current and previous releases are required'
  [[ "${release_id}" == "${current_release}" ]] || \
    fail 'rollback must be run through the immutable current release operator'
  [[ "${current_release}" != "${previous_release}" ]] || \
    fail 'current and previous release links are equal without a recoverable rollback intent'
  assert_staged_edge_host_contract
  verify_release_compose_edge_contract "${previous_release}"
  verify_release_compose_edge_contract "${current_release}"
  [[ "${apply_rollback}" == true ]] || {
    printf 'Rollback plan: %s -> %s\nRerun with: release.sh rollback --apply\n' \
      "${current_release}" "${previous_release}"
    return 0
  }
  verify_release_images "${previous_release}"
  guard_server_authority_release_transition "${previous_release}" "${current_release}"
  bridge_operator_path="$(legacy_bridge_operator_path "${previous_release}" "${current_release}")"
  prepare_database_backup "${previous_release}" "${current_release}"
  rollback_config="${scratch_directory}/rollback-nginx.conf"
  prepare_hardened_nginx_config \
    "${deploy_root}/releases/${previous_release}/deploy/standalone/nginx/https.conf" \
    "${rollback_config}" || \
    fail 'rollback Nginx config cannot preserve the trusted real-IP contract'
  test_nginx_config "${previous_release}" "${rollback_config}"
  current_config="${scratch_directory}/current-nginx.conf"
  install -m 0600 -- "${live_config}" "${current_config}"
  install_live_config "${rollback_config}"
  if ! compose_release "${previous_release}" up -d --no-build --pull never --force-recreate bot web || \
    ! wait_for_services "${previous_release}" bot web || \
    ! inner_upstream_https_smoke "${previous_release}" || \
    ! outer_caddy_https_smoke "${previous_release}"; then
    print_diagnostics "${previous_release}"
    install_live_config "${current_config}"
    if rollback_runtime "${current_release}"; then
      fail 'rollback candidate failed; current runtime was restored and verified'
    fi
    fail 'rollback candidate and current-runtime recovery both failed; manual repair is required'
  fi
  assert_staged_edge_contract

  if ! record_deployment rollback-ready "${previous_release}"; then
    install_live_config "${current_config}"
    compose_release "${current_release}" up -d --no-build --pull never --force-recreate bot web || \
      fail 'rollback pre-commit audit failed and the current runtime could not be restarted'
    wait_for_services "${current_release}" bot web || \
      fail 'rollback pre-commit audit failed and the restored current runtime is unhealthy'
    inner_upstream_https_smoke "${current_release}" || \
      fail 'rollback pre-commit audit failed and the restored upstream failed HTTPS smoke'
    outer_caddy_https_smoke "${current_release}" || \
      fail 'rollback pre-commit audit failed and the restored Caddy edge failed HTTPS smoke'
    fail 'rollback pre-commit audit failed; current runtime was restored'
  fi
  if ! arm_rollback_intent "${current_release}" "${previous_release}"; then
    install_live_config "${current_config}"
    runtime_restored=false
    rollback_runtime "${current_release}" && runtime_restored=true
    links_restored=false
    restore_release_links "${current_release}" "${previous_release}" && links_restored=true
    [[ "${runtime_restored}" == true && "${links_restored}" == true ]] || \
      fail 'rollback intent could not be armed and prior-state recovery needs manual repair'
    fail 'rollback intent could not be armed; prior runtime and links were restored'
  fi
  if ! switch_rollback_links "${current_release}" "${previous_release}"; then
    log 'rollback runtime was healthy, but the release-link commit failed; restoring current runtime'
    install_live_config "${current_config}"
    compose_release "${current_release}" up -d --no-build --pull never --force-recreate bot web || \
      fail 'release-link commit failed and the current runtime could not be restarted'
    wait_for_services "${current_release}" bot web || \
      fail 'release-link commit failed and the restored current runtime is unhealthy'
    inner_upstream_https_smoke "${current_release}" || \
      fail 'release-link commit failed and the restored upstream failed its HTTPS smoke test'
    outer_caddy_https_smoke "${current_release}" || \
      fail 'release-link commit failed and the restored Caddy edge failed its HTTPS smoke test'
    restore_release_links "${current_release}" "${previous_release}" || \
      fail "current runtime was restored, but release links require manual repair using ${rollback_intent_path}"
    retire_rollback_intent || \
      fail "current runtime and links were restored, but rollback intent remains at ${rollback_intent_path}"
    fail 'rollback link commit failed; current runtime and links were restored'
  fi
  if ! record_deployment rollback "${previous_release}"; then
    install_live_config "${current_config}"
    compose_release "${current_release}" up -d --no-build --pull never --force-recreate bot web || \
      fail 'rollback audit commit failed and the prior runtime could not be restarted'
    wait_for_services "${current_release}" bot web || \
      fail 'rollback audit commit failed and the restored prior runtime is unhealthy'
    inner_upstream_https_smoke "${current_release}" || \
      fail 'rollback audit commit failed and the restored upstream failed HTTPS smoke'
    outer_caddy_https_smoke "${current_release}" || \
      fail 'rollback audit commit failed and the restored Caddy edge failed HTTPS smoke'
    restore_release_links "${current_release}" "${previous_release}" || \
      fail "rollback audit commit failed; prior runtime is healthy but links need repair using ${rollback_intent_path}"
    retire_rollback_intent || \
      fail "rollback audit recovery succeeded, but intent remains at ${rollback_intent_path}"
    fail 'rollback audit commit failed; prior runtime and release links were restored'
  fi
  retire_rollback_intent || \
    fail "rollback completed, but its intent remains at ${rollback_intent_path}"
  assert_staged_edge_contract
  warn_pinned_bridge_operator rollback-live "${previous_release}" "${bridge_operator_path}"
  log "rollback complete: ${previous_release} is live"
}

show_status() {
  local current_release previous_release
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  [[ -n "${current_release}" ]] || fail 'staged Caddy status requires a current release'
  assert_staged_edge_contract
  verify_release_compose_edge_contract "${current_release}"
  if [[ -n "${previous_release}" ]]; then
    verify_release_compose_edge_contract "${previous_release}"
  fi
  verify_release_images "${current_release}"
  if [[ -n "${previous_release}" ]]; then
    verify_release_images "${previous_release}"
  fi
  service_health "${current_release}" bot || fail 'current bot service is not healthy'
  service_health "${current_release}" web || fail 'current web service is not healthy'
  inner_upstream_https_smoke "${current_release}" || \
    fail 'current inner upstream HTTPS smoke test failed'
  outer_caddy_https_smoke "${current_release}" || \
    fail 'current outer Caddy HTTPS smoke test failed'
  printf 'Candidate: %s\nCurrent: %s\nPrevious: %s\n' \
    "${release_id}" "${current_release:-none}" "${previous_release:-none}"
  if [[ -n "${current_release}" ]]; then
    compose_release "${current_release}" ps
  else
    compose_release "${release_id}" ps
  fi
  if [[ -f "${token_path}" ]]; then
    printf 'Bot token file: installed (value hidden)\n'
  else
    printf 'Bot token file: missing\n'
  fi
  printf 'Edge: Caddy active on public 80/443 -> HTTPS loopback 8443\n'
}

if [[ "${action}" != 'harden-edge' ]]; then
  assert_no_pending_edge_recovery
fi
assert_action_link_intent_contract "${action}"

case "${action}" in
  harden-edge)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true ]] || \
      fail 'harden-edge accepts only --apply'
    harden_edge
    ;;
  prepare)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true && \
      "${apply_rollback}" != true ]] || \
      fail 'prepare does not accept additional options'
    prepare_release
    ;;
  install-token)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true && \
      "${apply_rollback}" != true ]] || \
      fail 'install-token does not accept additional options'
    install_token
    ;;
  activate)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true && \
      "${apply_rollback}" != true ]] || \
      fail 'activate does not accept additional options'
    activate_release
    ;;
  rollback)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true ]] || \
      fail 'rollback only accepts --apply'
    rollback_release
    ;;
  ledger-mode)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true ]] || \
      fail 'ledger-mode does not accept network or certificate options'
    case "${ledger_mode_command}" in
      status)
        [[ "${apply_rollback}" != true ]] || fail 'ledger-mode status does not accept --apply'
        show_ledger_mode_status
        ;;
      server)
        enable_server_ledger_mode
        ;;
      '') fail 'ledger-mode requires status or server' ;;
      *) fail "unknown ledger-mode command: ${ledger_mode_command}" ;;
    esac
    ;;
  status)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true && \
      "${apply_rollback}" != true ]] || \
      fail 'status does not accept additional options'
    show_status
    ;;
  *)
    usage
    fail "unknown action: ${action}"
    ;;
esac
