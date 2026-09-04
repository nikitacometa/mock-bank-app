#!/usr/bin/env bash
set -Eeuo pipefail

readonly STATE_DIR="${COMETA_CERT_RENEW_STATE_DIR:-/home/metaflexer/.local/state/cometa-cert-renew}"
readonly LOCK_FILE="${STATE_DIR}/renew.lock"
readonly RECOVERY_DIR="${STATE_DIR}/pending-recovery"
readonly RECOVERY_STAGING_DIR="${STATE_DIR}/pending-recovery.staging"
readonly CERTBOT_IMAGE="certbot/certbot:v5.3.1"
readonly CERTBOT_CONF_VOLUME="aisatisfy-blog_certbot-conf"
readonly CERTBOT_WEBROOT_VOLUME="aisatisfy-blog_certbot-www"
readonly PROXY_CONTAINER="cometa-proxy"
readonly RENEW_CONTAINER="cometa-certbot-renew"
readonly CERT_DOMAIN="euphoria.bot"
readonly -a CERT_LINEAGE_HOSTS=("euphoria.bot" "www.euphoria.bot")
readonly -a SERVED_CERT_HOSTS=(
  "0xbeef.wtf"
  "www.0xbeef.wtf"
  "aisatisfy.me"
  "www.aisatisfy.me"
  "api.cometa.farm"
  "app.0xbeef.wtf"
  "app.cometa.farm"
  "beefthis.wtf"
  "www.beefthis.wtf"
  "fairground.quest"
  "www.fairground.quest"
  "app.fairground.quest"
  "api.fairground.quest"
  "nikitacometa.dev"
  "www.nikitacometa.dev"
  "euphoria.bot"
  "www.euphoria.bot"
)
readonly MIN_CERT_VALIDITY_SECONDS=1814400

umask 077

temporary_directory=''
lineage_snapshot=''
served_cert_file=''
host_lineage_map=''
previous_state_directory=''
restore_needed='false'
declare -a lineages=()

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

fail() {
  log "ERROR: $1"
  exit 1
}

certificate_fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256
}

certificate_covers_host() {
  local -r cert_file=$1
  local -r cert_host=$2
  local check_output

  # OpenSSL 3.0's `x509 -checkhost` prints a mismatch but still exits zero.
  # Match its explicit success sentence so a mismatch or wording drift fails closed.
  check_output="$(openssl x509 -in "${cert_file}" -noout -checkhost "${cert_host}" 2>&1)" || return 1
  [[ "${check_output}" == "Hostname ${cert_host} does match certificate" ]]
}

copy_lineage_file() {
  local -r lineage=$1
  local -r filename=$2
  local -r destination=$3

  : >"${destination}"
  docker run --rm \
    --mount "type=volume,src=${CERTBOT_CONF_VOLUME},dst=/etc/letsencrypt,readonly" \
    --entrypoint cat \
    "${CERTBOT_IMAGE}" \
    "/etc/letsencrypt/live/${lineage}/${filename}" >"${destination}"
  [[ -s "${destination}" ]]
}

snapshot_lineages() {
  docker run --rm \
    --mount "type=volume,src=${CERTBOT_CONF_VOLUME},dst=/etc/letsencrypt,readonly" \
    --entrypoint sh \
    "${CERTBOT_IMAGE}" \
    -c '
      set -eu
      found=false
      for directory in /etc/letsencrypt/live/*; do
        test -d "${directory}" || continue
        lineage=${directory##*/}
        case "${lineage}" in ""|*[!A-Za-z0-9.-]*) exit 1 ;; esac
        for name in cert chain fullchain privkey; do
          target=$(readlink "${directory}/${name}.pem")
          case "${target}" in
            "../../archive/${lineage}/${name}"[0-9]*.pem) ;;
            *) exit 1 ;;
          esac
          printf "%s %s %s\n" "${lineage}" "${name}" "${target}"
        done
        found=true
      done
      test "${found}" = true
    ' >"${lineage_snapshot}"

  local lineage name target extra
  while read -r lineage name target extra; do
    [[ -z "${extra:-}" ]] || return 1
    case "${lineage}" in ""|*[!A-Za-z0-9.-]*) return 1 ;; esac
    case "${name}" in cert|chain|fullchain|privkey) ;; *) return 1 ;; esac
    case "${target}" in
      "../../archive/${lineage}/${name}"[0-9]*.pem) ;;
      *) return 1 ;;
    esac
    if [[ "${name}" == fullchain ]]; then
      lineages+=("${lineage}")
    fi
  done <"${lineage_snapshot}"

  (( ${#lineages[@]} > 0 ))
  [[ "$(wc -l <"${lineage_snapshot}" | tr -d '[:space:]')" == "$(( ${#lineages[@]} * 4 ))" ]]
}

restore_lineages() {
  [[ -s "${lineage_snapshot}" ]] || return 1
  docker run --rm -i \
    --mount "type=volume,src=${CERTBOT_CONF_VOLUME},dst=/etc/letsencrypt" \
    --entrypoint sh \
    "${CERTBOT_IMAGE}" \
    -c '
      set -eu
      manifest=$(mktemp)
      cat >"${manifest}"
      count=0
      while read -r lineage name target extra; do
        test -z "${extra:-}"
        case "${lineage}" in ""|*[!A-Za-z0-9.-]*) exit 1 ;; esac
        case "${name}" in cert|chain|fullchain|privkey) ;; *) exit 1 ;; esac
        case "${target}" in
          "../../archive/${lineage}/${name}"[0-9]*.pem) ;;
          *) exit 1 ;;
        esac
        test -f "/etc/letsencrypt/live/${lineage}/${target}"
        count=$((count + 1))
      done <"${manifest}"
      test "${count}" -gt 0
      test "$((count % 4))" -eq 0

      while read -r lineage name target extra; do
        ln -sfn "${target}" "/etc/letsencrypt/live/${lineage}/${name}.pem"
      done <"${manifest}"
    ' <"${lineage_snapshot}"
}

fetch_served_certificate() {
  local -r cert_host=$1
  local -r destination=$2

  : >"${destination}"
  if ! openssl s_client \
      -connect '127.0.0.1:443' \
      -servername "${cert_host}" \
      -showcerts \
      -verify_return_error \
      -verify 5 \
      -verify_hostname "${cert_host}" \
      -CApath /etc/ssl/certs </dev/null 2>/dev/null \
      | openssl x509 -outform PEM >"${destination}"; then
    return 1
  fi
  [[ -s "${destination}" ]]
}

capture_served_leaf() {
  local -r cert_host=$1
  local -r destination=$2

  : >"${destination}"
  if ! openssl s_client \
      -connect '127.0.0.1:443' \
      -servername "${cert_host}" \
      -showcerts </dev/null 2>/dev/null \
      | openssl x509 -outform PEM >"${destination}"; then
    return 1
  fi
  [[ -s "${destination}" ]]
}

probe_served_certificate() {
  local -r cert_host=$1
  local -r expected_certificate=$2
  local -r minimum_seconds=$3
  local expected_fingerprint served_fingerprint attempt

  expected_fingerprint="$(certificate_fingerprint "${expected_certificate}")" || return 1
  for attempt in 1 2 3 4 5; do
    if fetch_served_certificate "${cert_host}" "${served_cert_file}"; then
      served_fingerprint="$(certificate_fingerprint "${served_cert_file}")" || return 1
      if [[ "${served_fingerprint}" == "${expected_fingerprint}" ]] && \
        openssl x509 -in "${served_cert_file}" -noout \
          -checkend "${minimum_seconds}" >/dev/null && \
        certificate_covers_host "${served_cert_file}" "${cert_host}"; then
        return 0
      fi
    fi
    if (( attempt < 5 )); then
      sleep 1
    fi
  done
  return 1
}

capture_previous_state() {
  local lineage cert_host previous_certificate previous_fingerprint lineage_fingerprint matched_lineage
  local matched_lineage_count

  : >"${host_lineage_map}"
  for lineage in "${lineages[@]}"; do
    previous_certificate="${temporary_directory}/previous-lineage-${lineage}.pem"
    copy_lineage_file "${lineage}" fullchain.pem "${previous_certificate}" || return 1
  done

  for cert_host in "${SERVED_CERT_HOSTS[@]}"; do
    previous_certificate="${temporary_directory}/previous-served-${cert_host}.pem"
    # Capture without trust/expiry gating so a valid renewal can recover a broken
    # currently served leaf. Rollback probes still require a usable old leaf.
    capture_served_leaf "${cert_host}" "${previous_certificate}" || return 1
    previous_fingerprint="$(certificate_fingerprint "${previous_certificate}")" || return 1

    matched_lineage=''
    matched_lineage_count=0
    for lineage in "${lineages[@]}"; do
      lineage_fingerprint="$(certificate_fingerprint \
        "${temporary_directory}/previous-lineage-${lineage}.pem")" || return 1
      if [[ "${lineage_fingerprint}" == "${previous_fingerprint}" ]]; then
        matched_lineage="${lineage}"
        matched_lineage_count=$((matched_lineage_count + 1))
      fi
    done
    [[ "${matched_lineage_count}" == 1 ]] || return 1
    printf '%s %s\n' "${cert_host}" "${matched_lineage}" >>"${host_lineage_map}"
  done

  for cert_host in "${CERT_LINEAGE_HOSTS[@]}"; do
    [[ "$(lineage_for_host "${cert_host}")" == "${CERT_DOMAIN}" ]] || return 1
  done
}

lineage_for_host() {
  local -r cert_host=$1
  awk -v cert_host="${cert_host}" '
    $1 == cert_host && NF == 2 { lineage = $2; matches += 1 }
    END {
      if (matches != 1) exit 1
      print lineage
    }
  ' "${host_lineage_map}"
}

lineage_is_used() {
  local -r lineage=$1
  awk -v lineage="${lineage}" '
    $2 == lineage && NF == 2 { found = 1 }
    END { exit found ? 0 : 1 }
  ' "${host_lineage_map}"
}

validate_lineage() {
  local -r lineage=$1
  local -r certificate=$2
  local -r private_key=$3
  local -r certificate_public="${temporary_directory}/candidate-${lineage}.certificate.pub"
  local -r key_public="${temporary_directory}/candidate-${lineage}.key.pub"
  local -r leaf_certificate="${temporary_directory}/candidate-${lineage}.leaf.pem"
  local -r intermediate_chain="${temporary_directory}/candidate-${lineage}.intermediates.pem"
  local validation_time

  openssl x509 -in "${certificate}" -noout \
    -checkend "${MIN_CERT_VALIDITY_SECONDS}" >/dev/null || return 1
  openssl x509 -in "${certificate}" -pubkey -noout >"${certificate_public}" || return 1
  openssl pkey -in "${private_key}" -pubout >"${key_public}" || return 1
  cmp -s "${certificate_public}" "${key_public}" || return 1

  : >"${leaf_certificate}"
  : >"${intermediate_chain}"
  awk -v leaf="${leaf_certificate}" -v intermediates="${intermediate_chain}" '
    /-----BEGIN CERTIFICATE-----/ { certificate_number += 1 }
    certificate_number == 1 { print >> leaf }
    certificate_number > 1 { print >> intermediates }
  ' "${certificate}"
  [[ -s "${leaf_certificate}" ]] || return 1
  [[ -s "${intermediate_chain}" ]] || return 1
  openssl verify -purpose sslserver -CApath /etc/ssl/certs \
    -untrusted "${intermediate_chain}" "${leaf_certificate}" >/dev/null || return 1
  validation_time="$(( $(date -u +%s) + MIN_CERT_VALIDITY_SECONDS ))"
  openssl verify -purpose sslserver -attime "${validation_time}" -CApath /etc/ssl/certs \
    -untrusted "${intermediate_chain}" "${leaf_certificate}" >/dev/null
}

validate_candidate_lineages() {
  local lineage certificate private_key cert_host

  for lineage in "${lineages[@]}"; do
    lineage_is_used "${lineage}" || continue
    certificate="${temporary_directory}/candidate-lineage-${lineage}.pem"
    private_key="${temporary_directory}/candidate-lineage-${lineage}.key"
    copy_lineage_file "${lineage}" fullchain.pem "${certificate}" || return 1
    copy_lineage_file "${lineage}" privkey.pem "${private_key}" || return 1
    chmod 0600 "${certificate}" "${private_key}"
    validate_lineage "${lineage}" "${certificate}" "${private_key}" || return 1
  done

  for cert_host in "${SERVED_CERT_HOSTS[@]}"; do
    lineage="$(lineage_for_host "${cert_host}")" || return 1
    certificate="${temporary_directory}/candidate-lineage-${lineage}.pem"
    certificate_covers_host "${certificate}" "${cert_host}" || return 1
  done
}

probe_candidate_served_certificates() {
  local cert_host lineage
  for cert_host in "${SERVED_CERT_HOSTS[@]}"; do
    lineage="$(lineage_for_host "${cert_host}")" || return 1
    if ! probe_served_certificate \
      "${cert_host}" \
      "${temporary_directory}/candidate-lineage-${lineage}.pem" \
      "${MIN_CERT_VALIDITY_SECONDS}"; then
      return 1
    fi
    log "Proxy is serving the validated candidate certificate for ${cert_host}"
  done
}

restore_previous_state() {
  local cert_host

  restore_lineages || return 1
  docker exec "${PROXY_CONTAINER}" nginx -t || return 1
  docker exec "${PROXY_CONTAINER}" nginx -s reload || return 1
  for cert_host in "${SERVED_CERT_HOSTS[@]}"; do
    probe_served_certificate \
      "${cert_host}" \
      "${previous_state_directory}/previous-served-${cert_host}.pem" \
      0 || return 1
  done
}

stop_renewal_container() {
  if docker container inspect "${RENEW_CONTAINER}" >/dev/null 2>&1; then
    docker rm --force "${RENEW_CONTAINER}" >/dev/null
  fi
}

arm_durable_recovery() {
  local cert_host

  [[ ! -e "${RECOVERY_DIR}" ]] || return 1
  rm -rf -- "${RECOVERY_STAGING_DIR}"
  mkdir -m 0700 "${RECOVERY_STAGING_DIR}" || return 1
  if ! cp "${lineage_snapshot}" "${RECOVERY_STAGING_DIR}/lineage-before.txt"; then
    rm -rf -- "${RECOVERY_STAGING_DIR}"
    return 1
  fi
  for cert_host in "${SERVED_CERT_HOSTS[@]}"; do
    if ! cp \
      "${temporary_directory}/previous-served-${cert_host}.pem" \
      "${RECOVERY_STAGING_DIR}/previous-served-${cert_host}.pem"; then
      rm -rf -- "${RECOVERY_STAGING_DIR}"
      return 1
    fi
  done
  chmod 0600 "${RECOVERY_STAGING_DIR}"/*
  if ! sync; then
    rm -rf -- "${RECOVERY_STAGING_DIR}"
    return 1
  fi
  if ! mv "${RECOVERY_STAGING_DIR}" "${RECOVERY_DIR}"; then
    rm -rf -- "${RECOVERY_STAGING_DIR}"
    return 1
  fi

  lineage_snapshot="${RECOVERY_DIR}/lineage-before.txt"
  previous_state_directory="${RECOVERY_DIR}"
  restore_needed=true
  sync
}

retire_durable_recovery() {
  local -r retired_directory="${STATE_DIR}/retired-recovery.$$"

  [[ -d "${RECOVERY_DIR}" ]] || return 1
  [[ ! -e "${retired_directory}" ]] || return 1
  mv "${RECOVERY_DIR}" "${retired_directory}" || return 1
  restore_needed=false
  if ! sync; then
    log 'WARNING: could not force the retired recovery marker to stable storage'
  fi
  if ! rm -rf -- "${retired_directory}"; then
    log "WARNING: could not remove retired recovery bundle: ${retired_directory}"
  fi
}

recover_pending_state() {
  local cert_host

  if [[ ! -e "${RECOVERY_DIR}" ]]; then
    return 0
  fi
  [[ -d "${RECOVERY_DIR}" ]] || return 1
  [[ -s "${RECOVERY_DIR}/lineage-before.txt" ]] || return 1
  for cert_host in "${SERVED_CERT_HOSTS[@]}"; do
    [[ -s "${RECOVERY_DIR}/previous-served-${cert_host}.pem" ]] || return 1
  done

  lineage_snapshot="${RECOVERY_DIR}/lineage-before.txt"
  previous_state_directory="${RECOVERY_DIR}"
  stop_renewal_container || return 1
  restore_previous_state || return 1
  restore_needed=true
  retire_durable_recovery || return 1
  log 'Recovered and verified the pre-renewal certificate state from durable storage'
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM HUP
  if [[ "${restore_needed}" == true ]]; then
    if stop_renewal_container && restore_previous_state; then
      if retire_durable_recovery; then
        log 'Restored every previous certificate lineage and reloaded the verified proxy state'
      else
        log 'CRITICAL: restored the proxy, but could not retire its recovery marker'
        exit_status=1
      fi
    else
      log 'CRITICAL: certificate renewal failed and the previous served state could not be restored'
      exit_status=1
    fi
  fi
  if [[ -n "${temporary_directory}" && -d "${temporary_directory}" ]]; then
    rm -rf -- "${temporary_directory}"
  fi
  if [[ -d "${RECOVERY_STAGING_DIR}" && ! -L "${RECOVERY_STAGING_DIR}" ]]; then
    rm -rf -- "${RECOVERY_STAGING_DIR}"
  fi
  exit "${exit_status}"
}

stop_on_signal() {
  fail 'certificate renewal interrupted'
}

trap cleanup EXIT
trap stop_on_signal INT TERM HUP

for dependency in awk chmod cmp cp date docker flock mkdir mktemp mv openssl readlink rm sleep sync tr wc; do
  if ! command -v "${dependency}" >/dev/null 2>&1; then
    fail "missing dependency: ${dependency}"
  fi
done

if ! mkdir -p -- "${STATE_DIR}" || ! chmod 700 "${STATE_DIR}"; then
  fail "could not prepare state directory: ${STATE_DIR}"
fi
if [[ -L "${RECOVERY_DIR}" || -L "${RECOVERY_STAGING_DIR}" ]]; then
  fail 'certificate recovery paths must not be symbolic links'
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log 'Another certificate renewal is already running; exiting'
  exit 0
fi

for volume in "${CERTBOT_CONF_VOLUME}" "${CERTBOT_WEBROOT_VOLUME}"; do
  if ! docker volume inspect "${volume}" >/dev/null 2>&1; then
    fail "required Docker volume does not exist: ${volume}"
  fi
done
if ! docker container inspect "${PROXY_CONTAINER}" >/dev/null 2>&1; then
  fail "proxy container does not exist: ${PROXY_CONTAINER}"
fi

temporary_directory="$(mktemp -d)"
chmod 0700 "${temporary_directory}"
lineage_snapshot="${temporary_directory}/lineage-before.txt"
served_cert_file="${temporary_directory}/served.pem"
host_lineage_map="${temporary_directory}/served-lineages.txt"
previous_state_directory="${temporary_directory}"

recover_pending_state || fail 'could not recover the pending pre-renewal certificate state'
stop_renewal_container || fail 'could not stop an orphaned Certbot renewal container'
lineage_snapshot="${temporary_directory}/lineage-before.txt"
previous_state_directory="${temporary_directory}"

snapshot_lineages || fail 'could not snapshot every current certificate lineage'
capture_previous_state || fail 'could not map every served certificate to a restorable lineage'

# Persist the rollback bundle before Certbot can mutate the shared volume.
arm_durable_recovery || fail 'could not persist the pre-renewal recovery bundle'
log 'Running Certbot renewal with rollback armed'
docker run --rm \
  --name "${RENEW_CONTAINER}" \
  --mount "type=volume,src=${CERTBOT_CONF_VOLUME},dst=/etc/letsencrypt" \
  --mount "type=volume,src=${CERTBOT_WEBROOT_VOLUME},dst=/var/www/certbot" \
  "${CERTBOT_IMAGE}" \
  renew --no-random-sleep-on-renew || fail 'Certbot renewal failed'

# The shared proxy is reloaded only after every referenced candidate passes checks.
validate_candidate_lineages || fail 'candidate lineage expiry, SAN, key, or trust validation failed'
docker exec "${PROXY_CONTAINER}" nginx -t || fail 'candidate lineages failed the proxy configuration test'
docker exec "${PROXY_CONTAINER}" nginx -s reload || fail 'proxy reload failed'
probe_candidate_served_certificates || fail 'proxy did not serve every validated candidate certificate'

retire_durable_recovery || fail 'could not commit the validated certificate state'
log 'Certificate renewal, guarded reload, and served-SNI probes passed'
