#!/usr/bin/env bash
set -Eeuo pipefail

readonly deploy_root="${COMETA_DEPLOY_ROOT:-/srv/cometa-bank}"
readonly domain='euphoria.bot'
readonly www_domain='www.euphoria.bot'
lock_file='/run/lock/cometa-bank.deploy.lock'
if [[ "${BASH_SOURCE[0]}" != "$0" && -n "${COMETA_CERT_RENEW_LOCK_FILE:-}" ]]; then
  lock_file="${COMETA_CERT_RENEW_LOCK_FILE}"
fi
readonly lock_file
readonly minimum_validity_seconds='1814400'
readonly renewal_container='cometa-bank-certbot-renew'
readonly recovery_helper_container='cometa-bank-certbot-recovery'
readonly recovery_volume_root='/etc/letsencrypt/.cometa-bank-renewal'
readonly renewal_record="${deploy_root}/state/renewal-bundle.release"
readonly renewal_pending_record="${deploy_root}/state/renewal-bundle.pending"
readonly renewal_legacy_timer_journal="${deploy_root}/state/renewal-bundle.legacy-timer"

umask 077

temporary_directory=''
lineage_snapshot=''
previous_certificate=''
restore_needed=false
cleanup_can_use_docker=false
recover_only=false

fail() {
  printf '[%s] ERROR: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

case $# in
  0) ;;
  1)
    [[ "$1" == '--recover-only' ]] || fail "unknown argument: $1"
    recover_only=true
    ;;
  *) fail 'certificate renewal accepts only --recover-only' ;;
esac

compose() {
  COMETA_RELEASE_ID="${release_id}" COMETA_DEPLOY_ROOT="${deploy_root}" \
    docker compose -f "${compose_file}" "$@"
}

certificate_fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256
}

probe_served_certificate() {
  local -r expected_certificate=$1
  local -r minimum_seconds=$2
  local expected_fingerprint hostname served_fingerprint attempt
  local served_ok=false

  expected_fingerprint="$(certificate_fingerprint "${expected_certificate}")" || return 1
  for hostname in "${domain}" "${www_domain}"; do
    served_ok=false
    for attempt in 1 2 3 4 5; do
      : >"${served_certificate}"
      if openssl s_client \
        -connect '127.0.0.1:443' \
        -servername "${hostname}" \
        -showcerts \
        -verify_return_error \
        -verify 5 \
        -verify_hostname "${hostname}" \
        -CApath /etc/ssl/certs </dev/null 2>/dev/null \
        | openssl x509 -outform PEM >"${served_certificate}"; then
        served_fingerprint="$(certificate_fingerprint "${served_certificate}")" || return 1
        if [[ "${served_fingerprint}" == "${expected_fingerprint}" ]] && \
          openssl x509 -in "${served_certificate}" -noout \
            -checkend "${minimum_seconds}" >/dev/null; then
          served_ok=true
          break
        fi
      fi
      sleep 1
    done
    [[ "${served_ok}" == true ]] || return 1
  done
}

snapshot_lineage() {
  compose --profile tools run --rm --name "${recovery_helper_container}" \
    --no-deps --pull never -T --entrypoint sh certbot \
    -c '
      set -eu
      domain=$1
      for name in cert chain fullchain privkey; do
        target=$(readlink "/etc/letsencrypt/live/${domain}/${name}.pem")
        case "${target}" in
          "../../archive/${domain}/${name}"[0-9]*.pem) ;;
          *) exit 1 ;;
        esac
        printf "%s %s\n" "${name}" "${target}"
      done
    ' sh "${domain}" >"${lineage_snapshot}"
  [[ "$(wc -l <"${lineage_snapshot}" | tr -d '[:space:]')" == '4' ]]
}

restore_lineage() {
  [[ -s "${lineage_snapshot}" && -s "${previous_certificate}" ]] || return 1
  compose --profile tools run --rm --name "${recovery_helper_container}" \
    --no-deps --pull never -T --entrypoint sh certbot \
    -c '
      set -eu
      domain=$1
      count=0
      while read -r name target extra; do
        test -z "${extra:-}"
        case "${name}" in cert|chain|fullchain|privkey) ;; *) exit 1 ;; esac
        case "${target}" in
          "../../archive/${domain}/${name}"[0-9]*.pem) ;;
          *) exit 1 ;;
        esac
        test -f "/etc/letsencrypt/live/${domain}/${target}"
        ln -sfn "${target}" "/etc/letsencrypt/live/${domain}/${name}.pem"
        count=$((count + 1))
      done
      test "${count}" -eq 4
    ' sh "${domain}" <"${lineage_snapshot}" || return 1
  compose exec -T web nginx -t || return 1
  compose exec -T web nginx -s reload || return 1
  probe_served_certificate "${previous_certificate}" 0 || return 1
}

stop_owned_certbot_container() {
  local -r container_name=$1
  local identity

  if ! docker container inspect "${container_name}" >/dev/null 2>&1; then
    return 0
  fi
  identity="$(docker container inspect --format \
    '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' \
    "${container_name}")" || return 1
  if [[ "${identity}" != 'cometa-bank|certbot' ]]; then
    log "CRITICAL: refusing to remove foreign container named ${container_name}"
    return 1
  fi
  docker rm --force "${container_name}" >/dev/null
}

stop_certbot_containers() {
  stop_owned_certbot_container "${renewal_container}" && \
    stop_owned_certbot_container "${recovery_helper_container}"
}

volume_recovery_operation() {
  local -r operation=$1
  shift

  compose --profile tools run --rm --name "${recovery_helper_container}" \
    --no-deps --pull never -T --entrypoint sh certbot \
    -c '
      set -eu
      umask 077
      operation=$1
      root=$2
      shift 2
      pending="${root}/pending-recovery"
      staging="${root}/pending-recovery.next"
      retired="${root}/retired-recovery"

      validate_root() {
        test ! -L "${root}"
        if test -e "${root}"; then
          test -d "${root}"
        fi
      }

      validate_pending() {
        test -d "${pending}" && test ! -L "${pending}"
        for filename in lineage-before.txt previous-fullchain.pem; do
          test -f "${pending}/${filename}"
          test ! -L "${pending}/${filename}"
          test -s "${pending}/${filename}"
        done
      }

      validate_root
      case "${operation}" in
        status)
          if test -d "${pending}" && test ! -L "${pending}"; then
            printf "pending\n"
          elif test -e "${pending}" || test -L "${pending}"; then
            exit 1
          else
            printf "absent\n"
          fi
          ;;
        stage-lineage)
          test ! -e "${pending}" && test ! -L "${pending}"
          test ! -e "${staging}" && test ! -L "${staging}"
          test ! -e "${retired}" && test ! -L "${retired}"
          mkdir -p "${root}"
          chmod 0700 "${root}"
          mkdir -m 0700 "${staging}"
          cat >"${staging}/lineage-before.txt"
          test -s "${staging}/lineage-before.txt"
          chmod 0600 "${staging}/lineage-before.txt"
          sync
          ;;
        commit-bundle)
          test -d "${staging}" && test ! -L "${staging}"
          test ! -e "${pending}" && test ! -L "${pending}"
          test ! -e "${retired}" && test ! -L "${retired}"
          cat >"${staging}/previous-fullchain.pem"
          for filename in lineage-before.txt previous-fullchain.pem; do
            test -f "${staging}/${filename}"
            test ! -L "${staging}/${filename}"
            test -s "${staging}/${filename}"
            chmod 0600 "${staging}/${filename}"
          done
          sync
          mv "${staging}" "${pending}"
          sync
          ;;
        read-file)
          filename=${1:-}
          case "${filename}" in
            lineage-before.txt|previous-fullchain.pem) ;;
            *) exit 1 ;;
          esac
          validate_pending
          cat "${pending}/${filename}"
          ;;
        retire)
          validate_pending
          test ! -e "${retired}" && test ! -L "${retired}"
          mv "${pending}" "${retired}"
          sync
          rm -rf "${retired}"
          sync
          ;;
        clear-stale)
          test ! -e "${pending}" && test ! -L "${pending}"
          for path in "${staging}" "${retired}"; do
            if test -e "${path}" || test -L "${path}"; then
              test -d "${path}" && test ! -L "${path}"
              rm -rf "${path}"
            fi
          done
          sync
          ;;
        *) exit 1 ;;
      esac
    ' sh "${operation}" "${recovery_volume_root}" "$@"
}

arm_durable_recovery() {
  volume_recovery_operation stage-lineage <"${lineage_snapshot}" || return 1
  volume_recovery_operation commit-bundle <"${previous_certificate}" || return 1
  restore_needed=true
}

retire_durable_recovery() {
  volume_recovery_operation retire || return 1
  restore_needed=false
}

recover_pending_state() {
  local recovery_status

  recovery_status="$(volume_recovery_operation status)" || return 1
  case "${recovery_status}" in
    absent) return 0 ;;
    pending) ;;
    *) return 1 ;;
  esac
  volume_recovery_operation read-file lineage-before.txt >"${lineage_snapshot}" || return 1
  volume_recovery_operation read-file previous-fullchain.pem >"${previous_certificate}" || return 1
  chmod 0600 "${lineage_snapshot}" "${previous_certificate}" || return 1
  [[ -s "${lineage_snapshot}" && -s "${previous_certificate}" ]] || return 1

  restore_needed=true
  restore_lineage || return 1
  retire_durable_recovery || return 1
  log 'recovered and verified the pre-renewal certificate state from durable storage'
}

cleanup() {
  local exit_status=$?
  local containers_stopped=true

  trap - EXIT INT TERM HUP
  if [[ "${cleanup_can_use_docker}" == true ]] && ! stop_certbot_containers; then
    log 'CRITICAL: could not stop the owned Certbot containers during cleanup'
    containers_stopped=false
    exit_status=1
  fi
  if [[ "${restore_needed}" == true ]]; then
    if [[ "${containers_stopped}" == true ]] && restore_lineage; then
      if retire_durable_recovery; then
        log 'restored the previous certificate lineage and verified the served leaf'
      else
        log 'CRITICAL: restored the previous lineage but could not retire its recovery marker'
        exit_status=1
      fi
    else
      log 'CRITICAL: certificate renewal failed and the previous lineage could not be restored'
      exit_status=1
    fi
  fi
  if [[ -n "${temporary_directory}" && -d "${temporary_directory}" ]]; then
    rm -rf -- "${temporary_directory}"
  fi
  exit "${exit_status}"
}

stop_on_signal() {
  fail 'certificate renewal interrupted'
}

trap cleanup EXIT
trap stop_on_signal INT TERM HUP

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  (( EUID == 0 )) || fail 'certificate renewal must run as root'
fi
for command_name in awk chmod cmp date docker flock mktemp openssl rm sleep stat tr wc; do
  command -v "${command_name}" >/dev/null 2>&1 || \
    fail "required command not found: ${command_name}"
done

[[ "${deploy_root}" == /* && "${deploy_root}" != '/' && "${deploy_root}" != *'..'* ]] || \
  fail 'COMETA_DEPLOY_ROOT must be a narrow absolute path without ..'
[[ "${lock_file}" == /* && "${lock_file}" != '/' && "${lock_file}" != *'..'* ]] || \
  fail 'COMETA_CERT_RENEW_LOCK_FILE must be a narrow absolute path without ..'
[[ ! -L "${lock_file}" ]] || fail 'certificate-renewal lock file must not be a symbolic link'

exec 9>"${lock_file}"
flock --nonblock 9 || {
  log 'another Cometa deployment or certificate renewal command is running; exiting'
  exit 0
}

[[ ! -e "${renewal_pending_record}" && ! -L "${renewal_pending_record}" ]] || \
  fail 'host-owned certificate-renewal bundle migration is incomplete'
[[ ! -e "${renewal_legacy_timer_journal}" && ! -L "${renewal_legacy_timer_journal}" ]] || \
  fail 'legacy certificate-renewal timer migration is incomplete'
[[ -f "${renewal_record}" && ! -L "${renewal_record}" ]] || \
  fail 'host-owned certificate-renewal source record is missing or unsafe'
[[ "$(stat -c '%U:%G:%a' "${renewal_record}")" == 'root:root:600' ]] || \
  fail 'host-owned certificate-renewal source record has unsafe ownership or mode'
record_line_count="$(wc -l <"${renewal_record}" | tr -d '[:space:]')" || \
  fail 'could not read the certificate-renewal source record'
[[ "${record_line_count}" == '1' ]] || \
  fail 'host-owned certificate-renewal source record is malformed'
read -r release_id extra <"${renewal_record}" || \
  fail 'could not parse the certificate-renewal source record'
[[ -z "${extra:-}" && "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
  fail 'host-owned certificate-renewal source record is malformed'
readonly release_id
readonly release_root="${deploy_root}/releases/${release_id}"
readonly compose_file="${release_root}/deploy/standalone/compose.yaml"
[[ -f "${compose_file}" && ! -L "${compose_file}" ]] || \
  fail 'recorded standalone Compose file is missing or unsafe'
cleanup_can_use_docker=true

temporary_directory="$(mktemp -d)"
chmod 0700 "${temporary_directory}"
readonly certificate="${temporary_directory}/fullchain.pem"
readonly private_key="${temporary_directory}/privkey.pem"
readonly certificate_public="${temporary_directory}/certificate.pub"
readonly key_public="${temporary_directory}/key.pub"
readonly served_certificate="${temporary_directory}/served.pem"
readonly leaf_certificate="${temporary_directory}/leaf.pem"
readonly intermediate_chain="${temporary_directory}/intermediates.pem"
lineage_snapshot="${temporary_directory}/lineage-before.txt"
previous_certificate="${temporary_directory}/previous-fullchain.pem"

# Stop any interrupted volume writer, then recover before taking a new baseline.
stop_certbot_containers || fail 'could not stop orphaned Certbot containers'
recover_pending_state || fail 'could not recover the pending pre-renewal certificate state'
volume_recovery_operation clear-stale || fail 'could not clear stale certificate recovery staging'
if [[ "${recover_only}" == true ]]; then
  log 'certificate renewal recovery state is clean'
  exit 0
fi
lineage_snapshot="${temporary_directory}/lineage-before.txt"
previous_certificate="${temporary_directory}/previous-fullchain.pem"

snapshot_lineage || fail 'could not snapshot the current certificate lineage'
compose --profile tools run --rm --name "${recovery_helper_container}" \
  --no-deps --pull never -T --entrypoint cat certbot \
  "/etc/letsencrypt/live/${domain}/fullchain.pem" >"${previous_certificate}"
chmod 0600 "${previous_certificate}"
test -s "${previous_certificate}" || fail 'current certificate lineage is empty'
probe_served_certificate "${previous_certificate}" 0 || \
  fail 'current Nginx leaf does not match the restorable certificate lineage'

# Persist rollback inputs before Certbot can mutate the shared volume.
arm_durable_recovery || fail 'could not persist the pre-renewal recovery bundle'
log 'running bounded Certbot renewal with durable rollback armed'
compose --profile tools run --rm --name "${renewal_container}" --no-deps --pull missing -T certbot \
  renew --no-random-sleep-on-renew || fail 'Certbot renewal failed'

compose --profile tools run --rm --name "${recovery_helper_container}" \
  --no-deps --pull missing -T --entrypoint cat certbot \
  "/etc/letsencrypt/live/${domain}/fullchain.pem" >"${certificate}"
compose --profile tools run --rm --name "${recovery_helper_container}" \
  --no-deps --pull missing -T --entrypoint cat certbot \
  "/etc/letsencrypt/live/${domain}/privkey.pem" >"${private_key}"
chmod 0600 "${certificate}" "${private_key}"
test -s "${certificate}" || fail 'renewed certificate lineage is empty'
test -s "${private_key}" || fail 'renewed private key is empty'

openssl x509 -in "${certificate}" -noout -checkend "${minimum_validity_seconds}" >/dev/null || \
  fail 'certificate expires in less than 21 days'
for hostname in "${domain}" "${www_domain}"; do
  match_output="$(openssl x509 -in "${certificate}" -noout -checkhost "${hostname}" 2>&1)" || \
    fail "could not validate certificate hostname ${hostname}"
  [[ "${match_output}" == "Hostname ${hostname} does match certificate" ]] || \
    fail "certificate does not cover ${hostname}"
done
openssl x509 -in "${certificate}" -pubkey -noout >"${certificate_public}"
openssl pkey -in "${private_key}" -pubout >"${key_public}"
cmp -s "${certificate_public}" "${key_public}" || fail 'certificate and private key do not match'
: >"${leaf_certificate}"
: >"${intermediate_chain}"
chmod 0600 "${leaf_certificate}" "${intermediate_chain}"
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
validation_epoch_seconds="$(date -u +%s)"
[[ "${validation_epoch_seconds}" =~ ^[0-9]+$ ]] || \
  fail 'could not determine the certificate trust-horizon timestamp'
validation_time="$((validation_epoch_seconds + minimum_validity_seconds))"
openssl verify -purpose sslserver -attime "${validation_time}" -CApath /etc/ssl/certs \
  -untrusted "${intermediate_chain}" "${leaf_certificate}" >/dev/null || \
  fail 'certificate lineage trust does not cover the 21-day safety window'

# Reload only after the candidate lineage passes expiry, SAN, key, and trust checks.
compose exec -T web nginx -t
compose exec -T web nginx -s reload

probe_served_certificate "${certificate}" "${minimum_validity_seconds}" || \
  fail 'Nginx did not serve the renewed certificate for both hostnames'

retire_durable_recovery || fail 'could not commit the validated certificate state'
log 'certificate renewal, guarded reload, and served-SNI probes passed'
