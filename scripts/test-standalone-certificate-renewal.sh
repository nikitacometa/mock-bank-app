#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
project_root="$(cd -- "${script_directory}/.." && pwd -P)"
readonly project_root
readonly renewal_script="${project_root}/deploy/standalone/scripts/renew-certificates.sh"
harness_directory="$(mktemp -d)"
readonly harness_directory
readonly test_deploy_root="${harness_directory}/deploy"
readonly test_release_id='20990101T000000Z'
readonly test_release_root="${test_deploy_root}/releases/${test_release_id}"
readonly test_current_release_id='20980101T000000Z'
readonly test_current_release_root="${test_deploy_root}/releases/${test_current_release_id}"
readonly test_renewal_record="${test_deploy_root}/state/renewal-bundle.release"
readonly test_volume_recovery_root="${harness_directory}/letsencrypt/.cometa-bank-renewal"
readonly test_recovery_directory="${test_volume_recovery_root}/pending-recovery"
readonly scenario_file="${harness_directory}/scenario"
readonly events_file="${harness_directory}/events"
readonly lineage_state_file="${harness_directory}/lineage-state"
readonly served_state_file="${harness_directory}/served-state"
readonly renewal_container_file="${harness_directory}/renewal-container"
readonly renewal_container_identity_file="${harness_directory}/renewal-container-identity"
readonly helper_container_file="${harness_directory}/helper-container"
readonly helper_container_identity_file="${harness_directory}/helper-container-identity"
readonly output_file="${harness_directory}/output"
trap 'rm -rf -- "${harness_directory}"' EXIT

export COMETA_DEPLOY_ROOT="${test_deploy_root}"
export COMETA_CERT_RENEW_LOCK_FILE="${harness_directory}/cometa-bank.deploy.lock"
export scenario_file events_file lineage_state_file served_state_file
export renewal_container_file renewal_container_identity_file
export helper_container_file helper_container_identity_file test_volume_recovery_root
export test_release_root test_renewal_record

mkdir -p \
  "${test_release_root}/deploy/standalone" \
  "${test_current_release_root}/deploy/standalone" \
  "${test_deploy_root}/state"
: >"${test_release_root}/deploy/standalone/compose.yaml"
: >"${test_current_release_root}/deploy/standalone/compose.yaml"
printf '%s\n' "${test_release_id}" >"${test_renewal_record}"
ln -s "releases/${test_current_release_id}" "${test_deploy_root}/current"

record_event() {
  printf '%s\n' "$1" >>"${events_file}"
}

certificate_body() {
  local -r state=$1
  local -r include_chain=$2
  local label

  case "${state}" in
    previous) label='PREVIOUS' ;;
    candidate) label='CANDIDATE' ;;
    *) return 1 ;;
  esac

  printf '%s\n' \
    '-----BEGIN CERTIFICATE-----' \
    "${label}_LEAF" \
    '-----END CERTIFICATE-----'
  if [[ "${include_chain}" == true ]]; then
    printf '%s\n' \
      '-----BEGIN CERTIFICATE-----' \
      "${label}_CHAIN" \
      '-----END CERTIFICATE-----'
  fi
}

reset_state() {
  rm -rf -- "${test_volume_recovery_root}"
  rm -f -- \
    "${events_file}" \
    "${renewal_container_file}" \
    "${renewal_container_identity_file}" \
    "${helper_container_file}" \
    "${helper_container_identity_file}" \
    "${output_file}"
  printf 'previous\n' >"${lineage_state_file}"
  printf 'previous\n' >"${served_state_file}"
}

flock() {
  return 0
}

sleep() {
  return 0
}

sync() {
  return 0
}

stat() {
  [[ "${1:-}" == -c && "${3:-}" == "${test_renewal_record}" ]] || return 1
  printf 'root:root:600\n'
}

docker() {
  local joined="$*"
  local argument last=''
  local scenario
  local container_file='' identity_file='' state
  local staging="${test_volume_recovery_root}/pending-recovery.next"
  local pending="${test_volume_recovery_root}/pending-recovery"
  local retired="${test_volume_recovery_root}/retired-recovery"

  scenario="$(<"${scenario_file}")"
  for argument in "$@"; do
    last="${argument}"
  done

  if [[ "${1:-}" == container && "${2:-}" == inspect ]]; then
    case "${last}" in
      cometa-bank-certbot-renew)
        container_file="${renewal_container_file}"
        identity_file="${renewal_container_identity_file}"
        ;;
      cometa-bank-certbot-recovery)
        container_file="${helper_container_file}"
        identity_file="${helper_container_identity_file}"
        ;;
      *) return 1 ;;
    esac
    [[ -e "${container_file}" ]] || return 1
    if [[ "${joined}" == *'--format'* ]]; then
      cat "${identity_file}"
    fi
    return 0
  fi

  if [[ "${joined}" == 'rm --force cometa-bank-certbot-renew' ]]; then
    record_event 'stop-writer'
    rm -f -- "${renewal_container_file}" "${renewal_container_identity_file}"
    return 0
  fi
  if [[ "${joined}" == 'rm --force cometa-bank-certbot-recovery' ]]; then
    record_event 'stop-helper'
    rm -f -- "${helper_container_file}" "${helper_container_identity_file}"
    return 0
  fi

  [[ "${1:-}" == compose ]] || {
    printf 'unexpected docker call: %s\n' "${joined}" >&2
    return 1
  }
  [[ "${joined}" == *"-f ${test_release_root}/deploy/standalone/compose.yaml"* ]] || {
    printf 'renewal worker used a Compose contract outside its recorded release: %s\n' \
      "${joined}" >&2
    return 1
  }

  if [[ "${joined}" == *' sh status /etc/letsencrypt/.cometa-bank-renewal'* ]]; then
    record_event 'bundle-status'
    if [[ -d "${pending}" ]]; then
      printf 'pending\n'
    elif [[ -e "${pending}" ]]; then
      return 1
    else
      printf 'absent\n'
    fi
    return 0
  fi
  if [[ "${joined}" == *' sh stage-lineage /etc/letsencrypt/.cometa-bank-renewal'* ]]; then
    record_event 'bundle-stage'
    [[ ! -e "${pending}" && ! -e "${staging}" && ! -e "${retired}" ]] || return 1
    mkdir -p "${staging}"
    cat >"${staging}/lineage-before.txt"
    [[ -s "${staging}/lineage-before.txt" ]]
    return 0
  fi
  if [[ "${joined}" == *' sh commit-bundle /etc/letsencrypt/.cometa-bank-renewal'* ]]; then
    record_event 'bundle-commit'
    [[ -d "${staging}" && ! -e "${pending}" && ! -e "${retired}" ]] || return 1
    cat >"${staging}/previous-fullchain.pem"
    [[ -s "${staging}/lineage-before.txt" && -s "${staging}/previous-fullchain.pem" ]] || \
      return 1
    mv "${staging}" "${pending}"
    return 0
  fi
  if [[ "${joined}" == *' sh read-file /etc/letsencrypt/.cometa-bank-renewal lineage-before.txt'* ]]; then
    record_event 'bundle-read-lineage'
    cat "${pending}/lineage-before.txt"
    return 0
  fi
  if [[ "${joined}" == *' sh read-file /etc/letsencrypt/.cometa-bank-renewal previous-fullchain.pem'* ]]; then
    record_event 'bundle-read-certificate'
    cat "${pending}/previous-fullchain.pem"
    return 0
  fi
  if [[ "${joined}" == *' sh retire /etc/letsencrypt/.cometa-bank-renewal'* ]]; then
    record_event 'bundle-retire'
    [[ -d "${pending}" && ! -e "${retired}" ]] || return 1
    mv "${pending}" "${retired}"
    rm -rf "${retired}"
    return 0
  fi
  if [[ "${joined}" == *' sh clear-stale /etc/letsencrypt/.cometa-bank-renewal'* ]]; then
    record_event 'bundle-clear'
    [[ ! -e "${pending}" ]] || return 1
    rm -rf "${staging}" "${retired}"
    return 0
  fi

  if [[ "${joined}" == *'--entrypoint sh certbot'* && \
    "${joined}" == *'for name in cert chain fullchain privkey'* ]]; then
    record_event 'snapshot'
    if [[ "${scenario}" == recovery-only ]]; then
      return 1
    fi
    state="$(<"${lineage_state_file}")"
    printf '%s\n' \
      "cert ../../archive/euphoria.bot/cert$([[ "${state}" == previous ]] && printf 1 || printf 2).pem" \
      "chain ../../archive/euphoria.bot/chain$([[ "${state}" == previous ]] && printf 1 || printf 2).pem" \
      "fullchain ../../archive/euphoria.bot/fullchain$([[ "${state}" == previous ]] && printf 1 || printf 2).pem" \
      "privkey ../../archive/euphoria.bot/privkey$([[ "${state}" == previous ]] && printf 1 || printf 2).pem"
    return 0
  fi

  if [[ "${joined}" == *'--entrypoint sh certbot'* && \
    "${joined}" == *'while read -r name target extra'* ]]; then
    record_event 'restore'
    local snapshot=''
    while IFS= read -r line; do
      snapshot+="${line}"$'\n'
    done
    [[ "${snapshot}" == *'../../archive/euphoria.bot/fullchain1.pem'* ]] || return 1
    printf 'previous\n' >"${lineage_state_file}"
    return 0
  fi

  if [[ "${joined}" == *'--entrypoint cat certbot'* ]]; then
    if [[ "${last}" == *'/privkey.pem' ]]; then
      printf '%s\n' 'TEST_PRIVATE_KEY'
    else
      certificate_body "$(<"${lineage_state_file}")" true
    fi
    return 0
  fi

  if [[ "${joined}" == *'--name cometa-bank-certbot-renew'* && \
    "${joined}" == *'renew --no-random-sleep-on-renew'* ]]; then
    record_event 'renew'
    : >"${renewal_container_file}"
    printf 'cometa-bank|certbot\n' >"${renewal_container_identity_file}"
    printf 'candidate\n' >"${lineage_state_file}"
    case "${scenario}" in
      signal-INT)
        kill -INT "$$"
        return 130
        ;;
      signal-TERM)
        kill -TERM "$$"
        return 143
        ;;
      signal-HUP)
        kill -HUP "$$"
        return 129
        ;;
      kill-KILL)
        kill -KILL "$$"
        return 137
        ;;
      normal|invalid-horizon)
        rm -f -- "${renewal_container_file}" "${renewal_container_identity_file}"
        return 0
        ;;
      *)
        printf 'unexpected renewal scenario: %s\n' "${scenario}" >&2
        return 1
        ;;
    esac
  fi

  if [[ "${joined}" == *'exec -T web nginx -t'* ]]; then
    record_event 'nginx-test'
    return 0
  fi
  if [[ "${joined}" == *'exec -T web nginx -s reload'* ]]; then
    record_event 'nginx-reload'
    cp -- "${lineage_state_file}" "${served_state_file}"
    return 0
  fi

  printf 'unexpected docker compose call: %s\n' "${joined}" >&2
  return 1
}

openssl() {
  local joined="$*"
  local input_file='' cert_host='' argument previous=''
  local scenario

  scenario="$(<"${scenario_file}")"

  for argument in "$@"; do
    if [[ "${previous}" == -in ]]; then
      input_file="${argument}"
    elif [[ "${previous}" == -checkhost ]]; then
      cert_host="${argument}"
    fi
    previous="${argument}"
  done

  if [[ "${1:-}" == s_client ]]; then
    local served_state
    served_state="$(<"${served_state_file}")"
    record_event "probe-${served_state}"
    certificate_body "${served_state}" false
    return 0
  fi
  if [[ "${joined}" == *'-outform PEM'* ]]; then
    while IFS= read -r line; do
      printf '%s\n' "${line}"
    done
    return 0
  fi
  if [[ "${joined}" == *'-fingerprint -sha256'* ]]; then
    if grep -q 'CANDIDATE_LEAF' "${input_file}"; then
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
    return 0
  fi
  if [[ "${joined}" == *'-pubkey -noout'* || "${1:-}" == pkey ]]; then
    printf 'TEST_PUBLIC_KEY\n'
    return 0
  fi
  if [[ "${1:-}" == verify ]]; then
    if [[ "${scenario}" == invalid-horizon && "${joined}" == *'-attime'* ]]; then
      return 1
    fi
    return 0
  fi

  printf 'unexpected openssl call: %s\n' "${joined}" >&2
  return 1
}

event_line() {
  local -r event=$1
  local -r occurrence=${2:-1}
  awk -v event="${event}" -v occurrence="${occurrence}" '
    $0 == event { seen += 1; if (seen == occurrence) { print NR; exit } }
  ' "${events_file}"
}

assert_order() {
  local previous_line=0 event occurrence line

  for event in "$@"; do
    occurrence=1
    if [[ "${event}" == *'#'* ]]; then
      occurrence="${event##*#}"
      event="${event%%#*}"
    fi
    line="$(event_line "${event}" "${occurrence}")"
    [[ "${line}" =~ ^[0-9]+$ && "${line}" -gt "${previous_line}" ]] || {
      printf 'ERROR: lifecycle event order failed at %s#%s\n' "${event}" "${occurrence}" >&2
      sed -n '1,120p' "${events_file}" >&2
      exit 1
    }
    previous_line="${line}"
  done
}

run_renewal() {
  local -r worker_argument="${1:-}"
  set +e
  if [[ -n "${worker_argument}" ]]; then
    bash -c 'script=$1; argument=$2; set --; source "${script}" "${argument}"' \
      _ "${renewal_script}" "${worker_argument}" >"${output_file}" 2>&1
  else
    bash -c 'script=$1; set --; source "${script}"' \
      _ "${renewal_script}" >"${output_file}" 2>&1
  fi
  local status=$?
  set -e
  printf '%s\n' "${status}"
}

export -f record_event certificate_body flock sleep stat sync docker openssl

# Test: INT, TERM, and HUP restore and verify the pre-renewal served lineage.
for signal_name in INT TERM HUP; do
  reset_state
  printf 'signal-%s\n' "${signal_name}" >"${scenario_file}"
  signal_status="$(run_renewal)"
  [[ "${signal_status}" -ne 0 ]] || {
    printf 'ERROR: %s interruption unexpectedly succeeded\n' "${signal_name}" >&2
    sed -n '1,160p' "${output_file}" >&2
    exit 1
  }
  [[ ! -e "${test_recovery_directory}" && ! -e "${renewal_container_file}" ]] || {
    printf 'ERROR: %s interruption left rollback state or its writer active\n' "${signal_name}" >&2
    exit 1
  }
  [[ "$(<"${lineage_state_file}")" == previous && \
    "$(<"${served_state_file}")" == previous ]] || {
    printf 'ERROR: %s interruption did not restore the previous served lineage\n' "${signal_name}" >&2
    exit 1
  }
  grep -q 'certificate renewal interrupted' "${output_file}" || {
    printf 'ERROR: %s interruption was not reported\n' "${signal_name}" >&2
    exit 1
  }
  grep -q 'restored the previous certificate lineage and verified the served leaf' \
    "${output_file}" || {
    printf 'ERROR: %s interruption did not report verified rollback\n' "${signal_name}" >&2
    exit 1
  }
  assert_order snapshot bundle-stage bundle-commit renew stop-writer restore \
    nginx-test nginx-reload probe-previous#3 bundle-retire
done

# Test: a SIGKILL restart restores durable state before capturing a new baseline.
reset_state
printf 'kill-KILL\n' >"${scenario_file}"
kill_status="$(run_renewal)"
[[ "${kill_status}" -ne 0 ]] || {
  printf 'ERROR: SIGKILL simulation unexpectedly succeeded\n' >&2
  exit 1
}
[[ -s "${test_recovery_directory}/lineage-before.txt" && \
  -s "${test_recovery_directory}/previous-fullchain.pem" ]] || {
  printf 'ERROR: SIGKILL did not leave a durable rollback point\n' >&2
  exit 1
}
[[ -e "${renewal_container_file}" && "$(<"${lineage_state_file}")" == candidate ]] || {
  printf 'ERROR: SIGKILL simulation did not leave the expected interrupted writer state\n' >&2
  exit 1
}

: >"${events_file}"
printf 'recovery-only\n' >"${scenario_file}"
restart_status="$(run_renewal)"
[[ "${restart_status}" -ne 0 ]] || {
  printf 'ERROR: restart probe unexpectedly continued past its deliberate snapshot failure\n' >&2
  exit 1
}
[[ ! -e "${test_recovery_directory}" && ! -e "${renewal_container_file}" ]] || {
  printf 'ERROR: restart did not retire durable rollback state and reap its writer\n' >&2
  exit 1
}
[[ "$(<"${lineage_state_file}")" == previous && \
  "$(<"${served_state_file}")" == previous ]] || {
  printf 'ERROR: restart did not restore the pre-SIGKILL served lineage\n' >&2
  exit 1
}
grep -q 'recovered and verified the pre-renewal certificate state from durable storage' \
  "${output_file}" || {
  printf 'ERROR: durable restart recovery was not reported\n' >&2
  exit 1
}
assert_order stop-writer bundle-status bundle-read-lineage bundle-read-certificate \
  restore nginx-test nginx-reload probe-previous#1 bundle-retire bundle-clear snapshot

# Test: --recover-only restores pending state without starting a renewal.
reset_state
printf 'kill-KILL\n' >"${scenario_file}"
recover_only_crash_status="$(run_renewal)"
[[ "${recover_only_crash_status}" -ne 0 && -d "${test_recovery_directory}" ]] || {
  printf 'ERROR: recover-only setup did not leave a durable interrupted state\n' >&2
  exit 1
}
: >"${events_file}"
recover_only_status="$(run_renewal --recover-only)"
[[ "${recover_only_status}" == 0 ]] || {
  printf 'ERROR: --recover-only failed to restore durable state\n' >&2
  sed -n '1,160p' "${output_file}" >&2
  exit 1
}
[[ ! -e "${test_recovery_directory}" && ! -e "${renewal_container_file}" && \
  "$(<"${served_state_file}")" == previous ]] || {
  printf 'ERROR: --recover-only did not leave a clean previous served lineage\n' >&2
  exit 1
}
if grep -Eq '^(snapshot|renew|bundle-stage|bundle-commit)$' "${events_file}"; then
  printf 'ERROR: --recover-only started a new certificate renewal\n' >&2
  exit 1
fi
grep -q 'certificate renewal recovery state is clean' "${output_file}" || {
  printf 'ERROR: --recover-only did not report clean recovery state\n' >&2
  exit 1
}
assert_order stop-writer bundle-status bundle-read-lineage bundle-read-certificate \
  restore nginx-test nginx-reload probe-previous#1 bundle-retire bundle-clear

# Test: orphan cleanup refuses a same-name container owned by another Compose project.
reset_state
printf 'normal\n' >"${scenario_file}"
: >"${renewal_container_file}"
printf 'foreign-project|certbot\n' >"${renewal_container_identity_file}"
foreign_status="$(run_renewal)"
[[ "${foreign_status}" -ne 0 && -e "${renewal_container_file}" ]] || {
  printf 'ERROR: foreign same-name container was not preserved\n' >&2
  exit 1
}
grep -q 'refusing to remove foreign container named cometa-bank-certbot-renew' \
  "${output_file}" || {
  printf 'ERROR: foreign same-name container refusal was not reported\n' >&2
  exit 1
}
if [[ -e "${events_file}" ]] && grep -Eq '^(snapshot|renew)$' "${events_file}"; then
  printf 'ERROR: renewal mutated certificate state after detecting a foreign container\n' >&2
  exit 1
fi

# Test: candidate trust must remain valid through the full 21-day safety window.
reset_state
printf 'invalid-horizon\n' >"${scenario_file}"
horizon_status="$(run_renewal)"
[[ "${horizon_status}" -ne 0 ]] || {
  printf 'ERROR: candidate with an invalid trust horizon unexpectedly passed\n' >&2
  exit 1
}
[[ ! -e "${test_recovery_directory}" && \
  "$(<"${lineage_state_file}")" == previous && \
  "$(<"${served_state_file}")" == previous ]] || {
  printf 'ERROR: invalid trust horizon did not restore the previous served lineage\n' >&2
  exit 1
}
grep -q 'certificate lineage trust does not cover the 21-day safety window' \
  "${output_file}" || {
  printf 'ERROR: invalid candidate trust horizon was not reported\n' >&2
  exit 1
}
[[ "$(grep -c '^nginx-reload$' "${events_file}")" == 1 ]] || {
  printf 'ERROR: invalid trust-horizon candidate was reloaded before rollback\n' >&2
  exit 1
}
assert_order bundle-commit renew restore nginx-test nginx-reload probe-previous#3 bundle-retire

# Test: successful renewal retires recovery state only after served-leaf verification.
reset_state
printf 'normal\n' >"${scenario_file}"
: >"${helper_container_file}"
printf 'cometa-bank|certbot\n' >"${helper_container_identity_file}"
success_status="$(run_renewal)"
[[ "${success_status}" == 0 ]] || {
  printf 'ERROR: successful renewal scenario failed\n' >&2
  sed -n '1,160p' "${output_file}" >&2
  exit 1
}
[[ ! -e "${test_recovery_directory}" && ! -e "${renewal_container_file}" && \
  "$(<"${served_state_file}")" == candidate ]] || {
  printf 'ERROR: successful renewal did not commit only the verified candidate\n' >&2
  exit 1
}
assert_order stop-helper bundle-status bundle-clear snapshot bundle-stage bundle-commit \
  renew nginx-test nginx-reload probe-candidate#1 bundle-retire

printf 'Standalone renewal signal, crash-recovery, and orphan-safety harness passed.\n'
