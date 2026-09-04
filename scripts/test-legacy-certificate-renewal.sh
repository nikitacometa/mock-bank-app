#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
project_root="$(cd -- "${script_directory}/.." && pwd -P)"
readonly project_root
harness_directory="$(mktemp -d)"
readonly harness_directory
readonly events_file="${harness_directory}/events"
readonly renewed_file="${harness_directory}/renewed"
readonly stopped_file="${harness_directory}/stopped"
readonly invalid_trust_file="${harness_directory}/invalid-trust"
readonly restored_file="${harness_directory}/restored"
readonly output_file="${harness_directory}/output"
trap 'rm -rf -- "${harness_directory}"' EXIT
export COMETA_CERT_RENEW_STATE_DIR="${harness_directory}/state"

flock() {
  return 0
}

sleep() {
  return 0
}

docker() {
  local joined="$*"
  local argument last=''
  for argument in "$@"; do
    last="${argument}"
  done

  case "${joined}" in
    'volume inspect '*) return 0 ;;
    'container inspect '*'cometa-proxy'*) return 0 ;;
    'container inspect '*'cometa-certbot-renew'*)
      if [[ -e "${renewed_file}" ]]; then return 0; else return 1; fi
      ;;
    'container inspect '*) return 1 ;;
  esac

  if [[ "${joined}" == 'rm --force cometa-certbot-renew' ]]; then
    printf 'stop-writer\n' >>"${events_file}"
    : >"${stopped_file}"
    rm -f "${renewed_file}"
    return 0
  fi

  if [[ "${joined}" == *'--entrypoint sh'* ]]; then
    if [[ "${joined}" == *',readonly'* ]]; then
      printf '%s\n' \
        'euphoria.bot cert ../../archive/euphoria.bot/cert1.pem' \
        'euphoria.bot chain ../../archive/euphoria.bot/chain1.pem' \
        'euphoria.bot fullchain ../../archive/euphoria.bot/fullchain1.pem' \
        'euphoria.bot privkey ../../archive/euphoria.bot/privkey1.pem'
    else
      printf 'restore\n' >>"${events_file}"
      : >"${restored_file}"
      while IFS= read -r _line; do :; done
    fi
    return 0
  fi

  if [[ "${joined}" == *'--entrypoint cat'* ]]; then
    if [[ "${last}" == *'/privkey.pem' ]]; then
      printf 'CANDIDATE_KEY\n'
    elif [[ -e "${renewed_file}" ]]; then
      printf 'CANDIDATE_CERT\n'
    else
      printf 'PREVIOUS_CERT\n'
    fi
    return 0
  fi

  if [[ "${joined}" == *'renew --no-random-sleep-on-renew'* ]]; then
    printf 'renew\n' >>"${events_file}"
    : >"${renewed_file}"
    return 0
  fi

  if [[ "${joined}" == exec*'nginx -t'* ]]; then
    printf 'nginx-test\n' >>"${events_file}"
    return 0
  fi
  if [[ "${joined}" == exec*'nginx -s reload'* ]]; then
    printf 'nginx-reload\n' >>"${events_file}"
    return 0
  fi

  printf 'unexpected docker call: %s\n' "${joined}" >&2
  return 1
}

openssl() {
  local joined="$*"
  local input_file='' cert_host='' argument previous=''
  for argument in "$@"; do
    if [[ "${previous}" == '-in' ]]; then
      input_file="${argument}"
    elif [[ "${previous}" == '-checkhost' ]]; then
      cert_host="${argument}"
    fi
    previous="${argument}"
  done

  if [[ "${1:-}" == s_client ]]; then
    printf 'PREVIOUS_CERT\n'
    if [[ "${joined}" == *'-verify_return_error'* && -e "${invalid_trust_file}" ]]; then
      return 1
    fi
    return 0
  fi
  if [[ "${joined}" == *'-outform PEM'* ]]; then
    while IFS= read -r line; do printf '%s\n' "${line}"; done
    return 0
  fi
  if [[ "${joined}" == *'-fingerprint -sha256'* ]]; then
    if grep -q 'CANDIDATE_CERT' "${input_file}"; then
      printf 'sha256 Fingerprint=CANDIDATE\n'
    else
      printf 'sha256 Fingerprint=PREVIOUS\n'
    fi
    return 0
  fi
  if [[ "${joined}" == *'-checkhost'* ]]; then
    printf 'Hostname %s does match certificate\n' "${cert_host}"
    return 0
  fi
  if [[ "${joined}" == *'-checkend'* ]]; then
    if grep -q 'CANDIDATE_CERT' "${input_file}"; then
      return 1
    fi
    return 0
  fi

  printf 'unexpected openssl call: %s\n' "${joined}" >&2
  return 1
}

set +e
( source "${project_root}/deploy/scripts/renew-certificates.sh" ) \
  >"${output_file}" 2>&1
renewal_status=$?
set -e

[[ "${renewal_status}" -ne 0 ]] || {
  printf 'ERROR: invalid candidate certificate unexpectedly passed renewal\n' >&2
  exit 1
}
[[ -e "${events_file}" ]] || {
  printf 'ERROR: renewal harness did not record lifecycle events\n' >&2
  exit 1
}
[[ -e "${restored_file}" ]] || {
  printf 'ERROR: invalid candidate certificate did not restore lineages\n' >&2
  exit 1
}
[[ -e "${stopped_file}" ]] || {
  printf 'ERROR: cleanup did not stop the active Certbot writer before restore\n' >&2
  exit 1
}
[[ "$(grep -c '^nginx-reload$' "${events_file}")" == 1 ]] || {
  printf 'ERROR: candidate was reloaded before validation or rollback reload was skipped\n' >&2
  exit 1
}
expected_events=$'renew\nstop-writer\nrestore\nnginx-test\nnginx-reload'
actual_events="$(printf '%s\n' \
  "$(sed -n '1p' "${events_file}")" \
  "$(sed -n '2p' "${events_file}")" \
  "$(sed -n '3p' "${events_file}")" \
  "$(sed -n '4p' "${events_file}")" \
  "$(sed -n '5p' "${events_file}")")"
[[ "${actual_events}" == "${expected_events}" ]] || {
  printf 'ERROR: renewal rollback lifecycle order is incorrect\n' >&2
  exit 1
}
grep -q 'candidate lineage expiry, SAN, key, or trust validation failed' "${output_file}" || {
  printf 'ERROR: candidate validation failure was not reported\n' >&2
  exit 1
}
grep -q 'Restored every previous certificate lineage' "${output_file}" || {
  printf 'ERROR: successful rollback was not reported\n' >&2
  exit 1
}

readonly restart_output_file="${harness_directory}/restart-output"
readonly pending_recovery_directory="${COMETA_CERT_RENEW_STATE_DIR}/pending-recovery"
readonly -a served_hosts=(
  '0xbeef.wtf'
  'www.0xbeef.wtf'
  'aisatisfy.me'
  'www.aisatisfy.me'
  'api.cometa.farm'
  'app.0xbeef.wtf'
  'app.cometa.farm'
  'beefthis.wtf'
  'www.beefthis.wtf'
  'fairground.quest'
  'www.fairground.quest'
  'app.fairground.quest'
  'api.fairground.quest'
  'nikitacometa.dev'
  'www.nikitacometa.dev'
  'euphoria.bot'
  'www.euphoria.bot'
)

: >"${events_file}"
rm -f "${renewed_file}" "${restored_file}" "${stopped_file}"
mkdir -m 0700 "${pending_recovery_directory}"
printf '%s\n' \
  'euphoria.bot cert ../../archive/euphoria.bot/cert1.pem' \
  'euphoria.bot chain ../../archive/euphoria.bot/chain1.pem' \
  'euphoria.bot fullchain ../../archive/euphoria.bot/fullchain1.pem' \
  'euphoria.bot privkey ../../archive/euphoria.bot/privkey1.pem' \
  >"${pending_recovery_directory}/lineage-before.txt"
for cert_host in "${served_hosts[@]}"; do
  printf 'PREVIOUS_CERT\n' \
    >"${pending_recovery_directory}/previous-served-${cert_host}.pem"
done
: >"${renewed_file}"

set +e
( source "${project_root}/deploy/scripts/renew-certificates.sh" ) \
  >"${restart_output_file}" 2>&1
restart_status=$?
set -e

[[ "${restart_status}" -ne 0 ]] || {
  printf 'ERROR: restart harness unexpectedly completed renewal\n' >&2
  exit 1
}
restart_prefix="$(printf '%s\n' \
  "$(sed -n '1p' "${events_file}")" \
  "$(sed -n '2p' "${events_file}")" \
  "$(sed -n '3p' "${events_file}")" \
  "$(sed -n '4p' "${events_file}")" \
  "$(sed -n '5p' "${events_file}")")"
expected_restart_prefix=$'stop-writer\nrestore\nnginx-test\nnginx-reload\nrenew'
[[ "${restart_prefix}" == "${expected_restart_prefix}" ]] || {
  printf 'ERROR: restart did not recover durable state before a new renewal: %q\n' \
    "${restart_prefix}" >&2
  sed -n '1,120p' "${restart_output_file}" >&2
  exit 1
}
grep -q 'Recovered and verified the pre-renewal certificate state from durable storage' \
  "${restart_output_file}" || {
  printf 'ERROR: durable restart recovery was not reported\n' >&2
  exit 1
}

readonly trust_output_file="${harness_directory}/trust-output"
: >"${events_file}"
rm -f "${renewed_file}" "${restored_file}" "${stopped_file}"
: >"${invalid_trust_file}"
set +e
( source "${project_root}/deploy/scripts/renew-certificates.sh" ) \
  >"${trust_output_file}" 2>&1
trust_status=$?
set -e

[[ "${trust_status}" -ne 0 ]] || {
  printf 'ERROR: invalid served trust chain unexpectedly passed rollback verification\n' >&2
  exit 1
}
grep -q 'CRITICAL: certificate renewal failed and the previous served state could not be restored' \
  "${trust_output_file}" || {
  printf 'ERROR: a failed s_client trust check was lost after leaf extraction\n' >&2
  exit 1
}
if grep -q 'Restored every previous certificate lineage' "${trust_output_file}"; then
  printf 'ERROR: invalid served trust chain was reported as a successful rollback\n' >&2
  exit 1
fi

printf 'Legacy renewal rollback, restart, and trust harness passed.\n'
