#!/usr/bin/env bash
set -Eeuo pipefail

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

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
release_root="$(cd -- "${script_directory}/../../.." && pwd -P)"
readonly release_root
release_id="$(basename -- "${release_root}")"
readonly release_id
readonly compose_relative='deploy/standalone/compose.yaml'
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

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

usage() {
  printf '%s\n' \
    'Usage: release.sh prepare' \
    '       release.sh issue-certificate (--email ADDRESS | --no-email) --server-ipv4 ADDRESS [--server-ipv6 ADDRESS]' \
    '       release.sh install-token' \
    '       release.sh activate' \
    '       release.sh rollback --apply' \
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

[[ "${deploy_root}" == /* && "${deploy_root}" != '/' && "${deploy_root}" != *'..'* ]] || \
  fail 'COMETA_DEPLOY_ROOT must be a narrow absolute path without ..'
(( EUID == 0 )) || fail 'run this release command through sudo'
[[ "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
  fail 'release directory must use UTC format YYYYMMDDTHHMMSSZ'
[[ "${release_root}" == "${deploy_root}/releases/${release_id}" ]] || \
  fail "release must live under ${deploy_root}/releases"
test -f "${release_root}/${compose_relative}" || fail 'standalone Compose file is missing'

for command_name in awk chown cmp curl date dig dirname docker flock grep install mktemp openssl readlink sed sqlite3 stat sync systemctl systemd-analyze tr unlink wc; do
  command -v "${command_name}" >/dev/null 2>&1 || \
    fail "required command not found: ${command_name}"
done
exec 9>"${deploy_lock}"
flock --nonblock 9 || fail 'another Cometa deployment command is running'
scratch_directory="$(mktemp -d)"
chmod 0700 "${scratch_directory}"

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

install_live_config() {
  local -r source_config=$1
  local -r next_config="${deploy_root}/state/nginx/default.conf.next"
  test -f "${source_config}" || fail "Nginx config is missing: ${source_config}"
  test ! -L "${live_config}" || fail 'refusing a symlinked live Nginx config'
  install -m 0644 -o root -g root -- "${source_config}" "${next_config}"
  mv -fT -- "${next_config}" "${live_config}"
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
  local manifest web_id bot_id line_count
  manifest="$(image_manifest_path "${target_release}")"
  [[ -f "${manifest}" && ! -L "${manifest}" ]] || \
    fail "immutable image manifest is missing for ${target_release}"
  line_count="$(wc -l <"${manifest}")"
  [[ "${line_count//[[:space:]]/}" == '2' ]] || \
    fail "image manifest must contain exactly two lines for ${target_release}"
  read -r _ web_id <"${manifest}" || fail "cannot read image manifest for ${target_release}"
  read -r _ bot_id < <(sed -n '2p' "${manifest}") || \
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

local_tls_web_smoke() {
  curl --disable --fail --silent --show-error --noproxy '*' \
    --proto '=https' --tlsv1.2 --resolve "${domain}:443:127.0.0.1" \
    "https://${domain}/" >/dev/null
}

local_https_smoke() {
  local response_file status
  response_file="${scratch_directory}/bootstrap-response.json"
  : >"${response_file}"
  local_tls_web_smoke
  status="$(curl --disable --silent --show-error --noproxy '*' \
    --proto '=https' --tlsv1.2 --resolve "${domain}:443:127.0.0.1" \
    --output "${response_file}" --write-out '%{http_code}' \
    --request POST --header 'Content-Type: application/json' --data '{}' \
    "https://${domain}/api/tma/bootstrap")"
  [[ "${status}" == '401' ]] || fail "bootstrap unauthenticated probe returned HTTP ${status}"
  grep -Fq '"error":"invalid_init_data"' "${response_file}" || \
    fail 'bootstrap unauthenticated probe did not return the JSON API contract'
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
  local -r database_path="${deploy_root}/data/cometa-bank.sqlite"
  local quick_check backup_path target_contract fallback_contract
  if [[ -n "${fallback_release}" ]]; then
    verify_release_images "${fallback_release}"
  fi
  [[ -f "${database_path}" ]] || return 0
  [[ ! -L "${database_path}" ]] || fail 'refusing a symlinked SQLite database'
  quick_check="$(sqlite3 "${database_path}" 'PRAGMA quick_check;')"
  [[ "${quick_check}" == 'ok' ]] || fail 'live SQLite quick_check failed'
  backup_path="${deploy_root}/backups/$(date -u +'%Y%m%dT%H%M%SZ')-before-${release_id}.sqlite"
  test ! -e "${backup_path}" || fail "database backup already exists: ${backup_path}"
  sqlite3 "${database_path}" ".backup '${backup_path}'"
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
  fi
  ln -sfnT "${new_target}" "${deploy_root}/current.next" || return 1
  mv -fT -- "${deploy_root}/current.next" "${deploy_root}/current" || return 1
  [[ "$(read_release_link current)" == "${release_id}" ]] || return 1
  if [[ -n "${old_release}" ]]; then
    [[ "$(read_release_link previous)" == "${old_release}" ]] || return 1
  fi
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
  [[ "$(readlink -- "${link_path}")" == "releases/${target_release}" ]] || return 1
}

switch_rollback_links() {
  local -r old_current=$1
  local -r old_previous=$2
  write_release_link previous "${old_current}" || return 1
  write_release_link current "${old_previous}" || return 1
  [[ "$(read_release_link current)" == "${old_previous}" ]] || return 1
  [[ "$(read_release_link previous)" == "${old_current}" ]] || return 1
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
  [[ ! -e "${link_path}" && ! -L "${link_path}" && \
    ! -e "${next_path}" && ! -L "${next_path}" ]]
}

rollback_runtime() {
  local -r previous_release=$1
  if [[ -z "${previous_release}" ]]; then
    log 'no previous release exists; restoring the HTTP preview and stopping the failed bot'
    compose_release "${release_id}" stop --timeout 20 bot >/dev/null 2>&1 || true
    compose_release "${release_id}" up -d --no-build --pull never --force-recreate web || return 1
    wait_for_services "${release_id}" web || return 1
    curl --disable --fail --silent --show-error --noproxy '*' \
      --header "Host: ${domain}" http://127.0.0.1/ >/dev/null || return 1
    return 0
  fi
  log "restoring runtime release ${previous_release} with the current validated token"
  verify_release_images "${previous_release}" || return 1
  compose_release "${previous_release}" up -d --no-build --pull never --force-recreate bot web || return 1
  wait_for_services "${previous_release}" bot web || return 1
  local_https_smoke || return 1
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

prepare_release() {
  local current_release manifest
  current_release="$(read_release_link current)"
  if ! docker image inspect "${certbot_image}" >/dev/null 2>&1; then
    docker pull "${certbot_image}"
  fi
  assert_prepare_renewal_state_clean
  ensure_host_renewal_bundle "${release_id}" "${current_release}" || \
    fail 'host-owned certificate-renewal bundle is missing, unsafe, or could not be migrated'
  assert_host_renewal_migration_complete
  assert_renewal_state_clean
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
  if [[ -z "${current_release}" ]]; then
    log 'first install detected; starting HTTP preview for DNS and ACME'
    install_live_config "${http_config}"
    compose_release "${release_id}" up -d --no-build --pull never --force-recreate web
    wait_for_services "${release_id}" web || {
      print_diagnostics "${release_id}"
      fail 'HTTP preview did not become healthy'
    }
    curl --disable --fail --silent --show-error --noproxy '*' \
      --header "Host: ${domain}" http://127.0.0.1/ >/dev/null || \
      fail 'local HTTP preview probe failed'
  fi
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
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  verify_certificate_lineage
  verify_release_images "${release_id}"
  [[ -f "${token_path}" && ! -L "${token_path}" ]] || fail 'install the bot token first'
  [[ "$(stat -c '%u:%g:%a' "${token_path}")" == "${bot_uid}:${bot_uid}:600" ]] || \
    fail 'bot token must be owned by service UID 10001 with mode 0600'
  verify_candidate_host_renewal_bundle "${release_id}" || \
    fail 'host-owned certificate-renewal worker does not match the candidate release'
  assert_host_renewal_migration_complete
  assert_renewal_state_clean
  prepare_database_backup "${release_id}" "${current_release}"
  test_nginx_config "${release_id}" "${https_config}"
  previous_config="${scratch_directory}/previous-nginx.conf"
  if [[ -f "${live_config}" ]]; then
    install -m 0600 -- "${live_config}" "${previous_config}"
  fi
  install_live_config "${https_config}"

  log "activating release ${release_id}"
  if ! compose_release "${release_id}" up -d --no-build --pull never --force-recreate bot web || \
    ! wait_for_services "${release_id}" bot web || ! local_https_smoke; then
    print_diagnostics "${release_id}"
    if [[ -s "${previous_config}" ]]; then
      install_live_config "${previous_config}"
    fi
    if rollback_runtime "${current_release}"; then
      fail "candidate ${release_id} failed; runtime rollback is healthy"
    fi
    fail 'candidate activation and runtime rollback both failed'
  fi

  if ! record_deployment activation-ready "${release_id}"; then
    [[ ! -s "${previous_config}" ]] || install_live_config "${previous_config}"
    if rollback_runtime "${current_release}"; then
      fail 'candidate was healthy, but the pre-commit audit failed; prior runtime was restored'
    fi
    fail 'candidate was healthy, but both the pre-commit audit and prior runtime restore failed'
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
      fail 'runtime was healthy, but the atomic release switch failed and recovery needs manual repair'
    fail 'runtime was healthy, but the atomic release switch failed; prior state was restored'
  fi
  if ! verify_recorded_host_renewal_bundle; then
    [[ ! -s "${previous_config}" ]] || install_live_config "${previous_config}"
    runtime_restored=false
    rollback_runtime "${current_release}" && runtime_restored=true
    links_restored=false
    restore_release_links "${current_release}" "${previous_release}" && links_restored=true
    [[ "${runtime_restored}" == true && "${links_restored}" == true ]] || \
      fail 'release switched, but the recorded renewal worker is invalid and recovery needs manual repair'
    fail 'release switched, but the recorded renewal worker is invalid; prior state was restored'
  fi
  if ! record_deployment activate "${release_id}"; then
    [[ ! -s "${previous_config}" ]] || install_live_config "${previous_config}"
    runtime_restored=false
    rollback_runtime "${current_release}" && runtime_restored=true
    links_restored=false
    restore_release_links "${current_release}" "${previous_release}" && links_restored=true
    [[ "${runtime_restored}" == true && "${links_restored}" == true ]] || \
      fail 'final deployment audit failed and recovery needs manual repair'
    fail 'final deployment audit failed; prior runtime and release links were restored'
  fi
  systemctl enable --now cometa-bank-cert-renew.timer || \
    fail "release ${release_id} is live and recorded, but the certificate-renewal timer failed to start"
  log "release ${release_id} is live and healthy"
}

rollback_release() {
  local current_release previous_release current_config
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
  [[ -n "${current_release}" && -n "${previous_release}" ]] || fail 'current and previous releases are required'
  [[ "${apply_rollback}" == true ]] || {
    printf 'Rollback plan: %s -> %s\nRerun with: release.sh rollback --apply\n' \
      "${current_release}" "${previous_release}"
    return 0
  }
  verify_release_images "${previous_release}"
  verify_recorded_host_renewal_bundle || \
    fail 'recorded host-owned certificate-renewal bundle is invalid'
  assert_host_renewal_migration_complete
  assert_renewal_state_clean

  prepare_database_backup "${previous_release}" "${current_release}"
  test_nginx_config "${previous_release}" \
    "${deploy_root}/releases/${previous_release}/deploy/standalone/nginx/https.conf"
  current_config="${scratch_directory}/current-nginx.conf"
  install -m 0600 -- "${live_config}" "${current_config}"
  install_live_config \
    "${deploy_root}/releases/${previous_release}/deploy/standalone/nginx/https.conf"
  if ! compose_release "${previous_release}" up -d --no-build --pull never --force-recreate bot web || \
    ! wait_for_services "${previous_release}" bot web || ! local_https_smoke; then
    print_diagnostics "${previous_release}"
    install_live_config "${current_config}"
    if rollback_runtime "${current_release}"; then
      fail 'rollback candidate failed; current runtime was restored and verified'
    fi
    fail 'rollback candidate and current-runtime recovery both failed; manual repair is required'
  fi

  if ! record_deployment rollback-ready "${previous_release}"; then
    install_live_config "${current_config}"
    compose_release "${current_release}" up -d --no-build --pull never --force-recreate bot web || \
      fail 'rollback pre-commit audit failed and the current runtime could not be restarted'
    wait_for_services "${current_release}" bot web || \
      fail 'rollback pre-commit audit failed and the restored current runtime is unhealthy'
    local_https_smoke || \
      fail 'rollback pre-commit audit failed and the restored current runtime failed HTTPS smoke'
    fail 'rollback pre-commit audit failed; current runtime was restored'
  fi
  if ! switch_rollback_links "${current_release}" "${previous_release}"; then
    log 'rollback runtime was healthy, but the release-link commit failed; restoring current runtime'
    install_live_config "${current_config}"
    compose_release "${current_release}" up -d --no-build --pull never --force-recreate bot web || \
      fail 'release-link commit failed and the current runtime could not be restarted'
    wait_for_services "${current_release}" bot web || \
      fail 'release-link commit failed and the restored current runtime is unhealthy'
    local_https_smoke || \
      fail 'release-link commit failed and the restored current runtime failed its HTTPS smoke test'
    restore_release_links "${current_release}" "${previous_release}" || \
      fail 'current runtime was restored, but release links require manual repair'
    fail 'rollback link commit failed; current runtime and links were restored'
  fi
  if ! record_deployment rollback "${previous_release}"; then
    install_live_config "${current_config}"
    compose_release "${current_release}" up -d --no-build --pull never --force-recreate bot web || \
      fail 'rollback audit commit failed and the prior runtime could not be restarted'
    wait_for_services "${current_release}" bot web || \
      fail 'rollback audit commit failed and the restored prior runtime is unhealthy'
    local_https_smoke || \
      fail 'rollback audit commit failed and the restored prior runtime failed HTTPS smoke'
    restore_release_links "${current_release}" "${previous_release}" || \
      fail 'rollback audit commit failed; prior runtime is healthy but links need manual repair'
    fail 'rollback audit commit failed; prior runtime and release links were restored'
  fi
  log "rollback complete: ${previous_release} is live"
}

show_status() {
  local current_release previous_release
  current_release="$(read_release_link current)"
  previous_release="$(read_release_link previous)"
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
  if [[ -f "${live_config}" ]] && cmp -s "${live_config}" "${https_config}"; then
    printf 'Nginx mode: HTTPS\n'
  else
    printf 'Nginx mode: HTTP bootstrap or unknown\n'
  fi
}

case "${action}" in
  prepare)
    [[ -z "${email}${server_ipv4}${server_ipv6}" && "${without_email}" != true && \
      "${apply_rollback}" != true ]] || \
      fail 'prepare does not accept additional options'
    prepare_release
    ;;
  issue-certificate)
    [[ "${apply_rollback}" != true ]] || fail 'issue-certificate does not accept --apply'
    issue_certificate
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
