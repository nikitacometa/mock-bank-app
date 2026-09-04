#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
project_root="$(cd -- "${script_directory}/.." && pwd -P)"
readonly project_root
readonly release_script="${project_root}/deploy/standalone/scripts/release.sh"
readonly entrypoint_script="${project_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh"

harness_directory="$(mktemp -d)"
readonly harness_directory
readonly deploy_root="${harness_directory}/deploy"
readonly scratch_directory="${harness_directory}/scratch"
readonly old_release='20990101T000000Z'
readonly new_release='20990102T000000Z'
readonly next_release='20990103T000000Z'
readonly host_renewal_entrypoint="${harness_directory}/host/usr/local/sbin/cometa-bank-renew-certificates"
readonly host_renewal_worker="${harness_directory}/host/usr/local/libexec/cometa-bank-renew-certificates-worker"
readonly host_renewal_service="${harness_directory}/host/etc/systemd/system/cometa-bank-cert-renew.service"
readonly host_renewal_timer="${harness_directory}/host/etc/systemd/system/cometa-bank-cert-renew.timer"
readonly host_renewal_record="${deploy_root}/state/renewal-bundle.release"
readonly host_renewal_pending_record="${deploy_root}/state/renewal-bundle.pending"
readonly host_renewal_legacy_timer_journal="${deploy_root}/state/renewal-bundle.legacy-timer"
readonly host_renewal_guard_directory="${harness_directory}/host/etc/systemd/system/cometa-bank-cert-renew.service.d"
readonly host_renewal_guard="${host_renewal_guard_directory}/10-bundle-migration.conf"
readonly renewal_service_unit='cometa-bank-cert-renew.service'
readonly renewal_timer_unit='cometa-bank-cert-renew.timer'
readonly renewal_container='cometa-bank-certbot-renew'
readonly recovery_helper_container='cometa-bank-certbot-recovery'
readonly letsencrypt_volume='cometa-bank_letsencrypt'
readonly recovery_volume_root='/etc/letsencrypt/.cometa-bank-renewal'
readonly certbot_image='certbot/certbot:test@sha256:test'
readonly renewal_recovery_instruction='sudo /usr/local/sbin/cometa-bank-renew-certificates --recover-only'
readonly events_file="${harness_directory}/events"
readonly output_file="${harness_directory}/output"
readonly volume_present_file="${harness_directory}/volume-present"
readonly volume_dirty_file="${harness_directory}/volume-dirty"
readonly volume_inspect_error_file="${harness_directory}/volume-inspect-error"
readonly renewal_orphan_file="${harness_directory}/renewal-orphan"
readonly helper_orphan_file="${harness_directory}/helper-orphan"
readonly container_list_error_file="${harness_directory}/container-list-error"
readonly fail_wrapper_commit_file="${harness_directory}/fail-wrapper-commit"
readonly fail_timer_disable_file="${harness_directory}/fail-timer-disable"
readonly timer_enabled_file="${harness_directory}/timer-enabled"
readonly timer_runtime_enabled_file="${harness_directory}/timer-runtime-enabled"
readonly timer_active_file="${harness_directory}/timer-active"
readonly service_active_file="${harness_directory}/service-active"
trap 'rm -rf -- "${harness_directory}"' EXIT

mkdir -p \
  "${deploy_root}/releases" \
  "${deploy_root}/state" \
  "${scratch_directory}" \
  "$(dirname -- "${host_renewal_entrypoint}")" \
  "$(dirname -- "${host_renewal_worker}")" \
  "$(dirname -- "${host_renewal_service}")"
: >"${events_file}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  return 1
}

log() {
  printf 'LOG: %s\n' "$*" >&2
}

record_event() {
  printf '%s\n' "$1" >>"${events_file}"
}

install() {
  local mode='0755' directory_mode=false
  local -a operands=()

  while (( $# > 0 )); do
    case "$1" in
      -d)
        directory_mode=true
        shift
        ;;
      -m|-o|-g)
        [[ "$1" != -m ]] || mode=$2
        shift 2
        ;;
      --)
        shift
        operands+=("$@")
        break
        ;;
      -*)
        printf 'unexpected install option: %s\n' "$1" >&2
        return 1
        ;;
      *)
        operands+=("$1")
        shift
        ;;
    esac
  done

  if [[ "${directory_mode}" == true ]]; then
    command mkdir -p -- "${operands[${#operands[@]} - 1]}"
    return
  fi
  (( ${#operands[@]} == 2 )) || return 1
  case "${operands[1]}" in
    "${host_renewal_worker}.next") record_event 'install-worker' ;;
    "${host_renewal_entrypoint}.next") record_event 'install-wrapper' ;;
    "${host_renewal_service}.next") record_event 'install-service' ;;
    "${host_renewal_timer}.next") record_event 'install-timer' ;;
  esac
  command install -m "${mode}" -- "${operands[0]}" "${operands[1]}"
}

mv() {
  local source_path='' target_path=''
  local event=''

  while (( $# > 0 )); do
    case "$1" in
      -fT|--)
        shift
        ;;
      -*)
        printf 'unexpected mv option: %s\n' "$1" >&2
        return 1
        ;;
      *)
        if [[ -z "${source_path}" ]]; then
          source_path=$1
        elif [[ -z "${target_path}" ]]; then
          target_path=$1
        else
          return 1
        fi
        shift
        ;;
    esac
  done
  [[ -n "${source_path}" && -n "${target_path}" ]] || return 1
  case "${target_path}" in
    "${host_renewal_worker}") event='commit-worker' ;;
    "${host_renewal_entrypoint}")
      [[ ! -e "${fail_wrapper_commit_file}" ]] || return 1
      event='commit-wrapper'
      ;;
    "${host_renewal_record}") event='commit-record' ;;
    "${host_renewal_pending_record}") event='commit-pending' ;;
  esac
  command mv -f -- "${source_path}" "${target_path}" || return 1
  [[ -z "${event}" ]] || record_event "${event}"
}

stat() {
  local target_path=''
  local argument

  for argument in "$@"; do
    target_path=${argument}
  done
  case "${target_path}" in
    "${host_renewal_record}"|"${host_renewal_pending_record}"|\
      "${host_renewal_legacy_timer_journal}") printf 'root:root:600\n' ;;
    "${host_renewal_entrypoint}"|"${host_renewal_worker}") printf 'root:root:755\n' ;;
    "${host_renewal_service}"|"${host_renewal_timer}"|"${host_renewal_guard}") \
      printf 'root:root:644\n'
      ;;
    *) command stat "$@" ;;
  esac
}

sync() {
  return 0
}

systemctl() {
  case "$*" in
    daemon-reload)
      record_event 'daemon-reload'
      ;;
    "is-enabled ${renewal_timer_unit}")
      if [[ -e "${timer_enabled_file}" ]]; then
        printf 'enabled\n'
      elif [[ -e "${timer_runtime_enabled_file}" ]]; then
        printf 'enabled-runtime\n'
      else
        printf 'disabled\n'
        return 1
      fi
      ;;
    "disable --now ${renewal_timer_unit}")
      record_event 'disable-timer'
      [[ ! -e "${fail_timer_disable_file}" ]] || return 1
      rm -f -- "${timer_enabled_file}" "${timer_runtime_enabled_file}" \
        "${timer_active_file}"
      ;;
    "stop ${renewal_service_unit}")
      record_event 'stop-service'
      rm -f -- "${service_active_file}"
      ;;
    "show --property ActiveState --value ${renewal_timer_unit}")
      [[ ! -e "${timer_active_file}" ]] || {
        printf 'active\n'
        return 0
      }
      printf 'inactive\n'
      ;;
    "show --property ActiveState --value ${renewal_service_unit}")
      [[ ! -e "${service_active_file}" ]] || {
        printf 'active\n'
        return 0
      }
      printf 'inactive\n'
      ;;
    "enable --now ${renewal_timer_unit}")
      record_event 'enable-timer'
      : >"${timer_enabled_file}"
      : >"${timer_active_file}"
      ;;
    "enable --runtime --now ${renewal_timer_unit}")
      record_event 'enable-runtime-timer'
      : >"${timer_runtime_enabled_file}"
      : >"${timer_active_file}"
      ;;
    *)
      printf 'unexpected systemctl call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}

systemd-analyze() {
  [[ "${1:-}" == verify ]]
}

docker() {
  if [[ "$*" == info ]]; then
    return 0
  fi
  if [[ "${1:-}" == container && "${2:-}" == ls ]]; then
    [[ ! -e "${container_list_error_file}" ]] || return 1
    [[ ! -e "${renewal_orphan_file}" ]] || printf '%s\n' "${renewal_container}"
    [[ ! -e "${helper_orphan_file}" ]] || printf '%s\n' "${recovery_helper_container}"
    return 0
  fi
  if [[ "${1:-}" == volume && "${2:-}" == ls ]]; then
    [[ ! -e "${volume_present_file}" ]] || printf '%s\n' "${letsencrypt_volume}"
    return 0
  fi
  if [[ "${1:-}" == volume && "${2:-}" == inspect && "${3:-}" == "${letsencrypt_volume}" ]]; then
    [[ -e "${volume_present_file}" && ! -e "${volume_inspect_error_file}" ]]
    return
  fi
  if [[ "${1:-}" == run ]]; then
    record_event 'probe-recovery-volume'
    [[ ! -e "${volume_dirty_file}" ]]
    return
  fi
  printf 'unexpected docker call: %s\n' "$*" >&2
  return 1
}

make_bundle() {
  local -r fixture_release=$1
  local -r bundle_kind=$2
  local -r worker_version=$3
  local -r fixture_root="${deploy_root}/releases/${fixture_release}/deploy/standalone"

  mkdir -p "${fixture_root}/scripts" "${fixture_root}/systemd"
  if [[ "${bundle_kind}" == stable ]]; then
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      "readonly renewal_worker='${host_renewal_worker}'" \
      'exec "${renewal_worker}" "$@"' \
      >"${fixture_root}/scripts/renew-certificates-entrypoint.sh"
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      "# worker ${worker_version}" \
      'readonly renewal_record="${deploy_root}/state/renewal-bundle.release"' \
      'readonly release_root="${deploy_root}/releases/${release_id}"' \
      'case $# in' \
      '  1)' \
      '    [[ "$1" == '\''--recover-only'\'' ]] || fail "unknown argument: $1"' \
      '    ;;' \
      'esac' \
      >"${fixture_root}/scripts/renew-certificates.sh"
  else
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      '# legacy release-local entrypoint' \
      >"${fixture_root}/scripts/renew-certificates-entrypoint.sh"
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      '# legacy release-local worker' \
      >"${fixture_root}/scripts/renew-certificates.sh"
  fi
  chmod 0755 \
    "${fixture_root}/scripts/renew-certificates-entrypoint.sh" \
    "${fixture_root}/scripts/renew-certificates.sh"
  printf '%s\n' \
    '[Unit]' \
    'Description=fixture' \
    '[Service]' \
    'Type=oneshot' \
    'ExecStart=/usr/local/sbin/cometa-bank-renew-certificates' \
    >"${fixture_root}/systemd/cometa-bank-cert-renew.service"
  printf '%s\n' \
    '[Unit]' \
    'Description=fixture timer' \
    '[Timer]' \
    'OnCalendar=daily' \
    >"${fixture_root}/systemd/cometa-bank-cert-renew.timer"
}

assert_event_order() {
  local prior=0 event line

  for event in "$@"; do
    line="$(awk -v event="${event}" '$0 == event { print NR; exit }' "${events_file}")"
    [[ "${line}" =~ ^[0-9]+$ && "${line}" -gt "${prior}" ]] || {
      printf 'ERROR: event order failed at %s\n' "${event}" >&2
      sed -n '1,120p' "${events_file}" >&2
      exit 1
    }
    prior=${line}
  done
}

# Exercise the exact production functions without running release.sh's privileged main path.
eval "$(sed -n '/^verify_renewal_bundle() {$/,/^prepare_release() {$/p' "${release_script}" | sed '$d')"

make_bundle "${old_release}" legacy old
make_bundle "${new_release}" stable hardened
make_bundle "${next_release}" stable next

# Test: legacy prepare rejects unknown recovery state before installing a new worker.
: >"${volume_present_file}"
: >"${volume_dirty_file}"
if assert_prepare_renewal_state_clean >"${output_file}" 2>&1; then
  printf 'ERROR: legacy prepare accepted pending recovery before stable-worker migration\n' >&2
  exit 1
fi
grep -Fq 'manual recovery is required' "${output_file}" || {
  printf 'ERROR: legacy pre-migration recovery failure was not reported safely\n' >&2
  exit 1
}
[[ ! -e "${host_renewal_worker}" && ! -e "${host_renewal_pending_record}" ]] || {
  printf 'ERROR: legacy recovery preflight mutated the host renewal bundle\n' >&2
  exit 1
}
rm -f -- "${volume_present_file}" "${volume_dirty_file}"

# Test: a verified legacy install migrates atomically, worker first and wrapper last.
command install -m 0755 -- \
  "${deploy_root}/releases/${old_release}/deploy/standalone/scripts/renew-certificates-entrypoint.sh" \
  "${host_renewal_entrypoint}"
command install -m 0644 -- \
  "${deploy_root}/releases/${old_release}/deploy/standalone/systemd/cometa-bank-cert-renew.service" \
  "${host_renewal_service}"
command install -m 0644 -- \
  "${deploy_root}/releases/${old_release}/deploy/standalone/systemd/cometa-bank-cert-renew.timer" \
  "${host_renewal_timer}"
: >"${timer_enabled_file}"
: >"${timer_active_file}"
: >"${fail_timer_disable_file}"
: >"${fail_wrapper_commit_file}"
if ensure_host_renewal_bundle "${new_release}" "${old_release}" >"${output_file}" 2>&1; then
  printf 'ERROR: injected legacy-timer disable failure unexpectedly completed migration\n' >&2
  exit 1
fi
[[ "$(<"${host_renewal_legacy_timer_journal}")" == "${new_release} enabled" && \
  -f "${host_renewal_guard}" && -e "${timer_enabled_file}" && \
  ! -e "${host_renewal_pending_record}" && ! -e "${host_renewal_worker}" ]] || {
  printf 'ERROR: timer-disable failure did not leave a guarded durable migration journal\n' >&2
  exit 1
}
grep -Fxq "ConditionPathExists=!${host_renewal_legacy_timer_journal}" \
  "${host_renewal_guard}" || {
  printf 'ERROR: legacy timer guard does not fail closed on its durable journal\n' >&2
  exit 1
}
rm -f -- "${fail_timer_disable_file}"
if ensure_host_renewal_bundle "${new_release}" "${old_release}" >"${output_file}" 2>&1; then
  printf 'ERROR: injected wrapper-commit failure unexpectedly completed migration\n' >&2
  exit 1
fi
[[ "$(<"${host_renewal_pending_record}")" == "${new_release}" && \
  ! -e "${host_renewal_record}" && \
  "$(<"${host_renewal_legacy_timer_journal}")" == "${new_release} enabled" && \
  -f "${host_renewal_guard}" && ! -e "${timer_enabled_file}" ]] || {
  printf 'ERROR: interrupted migration did not preserve its durable target journal\n' >&2
  exit 1
}
cmp -s \
  "${deploy_root}/releases/${new_release}/deploy/standalone/scripts/renew-certificates.sh" \
  "${host_renewal_worker}" || {
  printf 'ERROR: interrupted migration did not install the worker before its wrapper\n' >&2
  exit 1
}
cmp -s \
  "${deploy_root}/releases/${old_release}/deploy/standalone/scripts/renew-certificates-entrypoint.sh" \
  "${host_renewal_entrypoint}" || {
  printf 'ERROR: interrupted migration replaced its wrapper before the worker was durable\n' >&2
  exit 1
}
rm -f -- "${fail_wrapper_commit_file}"
ensure_host_renewal_bundle "${new_release}" "${old_release}" || {
  printf 'ERROR: controlled legacy renewal-bundle migration did not resume\n' >&2
  exit 1
}
[[ "$(<"${host_renewal_record}")" == "${new_release}" && \
  ! -e "${host_renewal_pending_record}" && \
  ! -e "${host_renewal_legacy_timer_journal}" && \
  ! -e "${host_renewal_guard}" && -e "${timer_enabled_file}" ]] || {
  printf 'ERROR: migration did not atomically record the installed bundle\n' >&2
  exit 1
}
verify_candidate_host_renewal_bundle "${new_release}" || {
  printf 'ERROR: installed candidate bundle failed recorded integrity verification\n' >&2
  exit 1
}
assert_event_order disable-timer stop-service commit-pending install-worker commit-worker \
  install-wrapper commit-wrapper commit-record enable-timer

# Test: stable upgrades reject pending recovery before replacing the recorded worker.
: >"${volume_present_file}"
: >"${volume_dirty_file}"
stable_worker_hash="$(sha256sum "${host_renewal_worker}" | awk '{print $1}')"
if assert_prepare_renewal_state_clean >"${output_file}" 2>&1; then
  printf 'ERROR: stable prepare accepted pending recovery before worker upgrade\n' >&2
  exit 1
fi
grep -Fq "run: ${renewal_recovery_instruction}" "${output_file}" || {
  printf 'ERROR: stable pre-upgrade gate omitted its exact recovery-only instruction\n' >&2
  exit 1
}
[[ "$(sha256sum "${host_renewal_worker}" | awk '{print $1}')" == \
  "${stable_worker_hash}" ]] || {
  printf 'ERROR: stable recovery preflight replaced the recorded worker\n' >&2
  exit 1
}
rm -f -- "${volume_present_file}" "${volume_dirty_file}"

# Test: new -> old rollback preserves the hardened worker and its immutable source record.
worker_hash_before="$(sha256sum "${host_renewal_worker}" | awk '{print $1}')"
verify_recorded_host_renewal_bundle || {
  printf 'ERROR: rollback would reject the recorded hardened host worker\n' >&2
  exit 1
}
[[ "$(<"${host_renewal_record}")" == "${new_release}" && \
  "$(sha256sum "${host_renewal_worker}" | awk '{print $1}')" == "${worker_hash_before}" ]] || {
  printf 'ERROR: rollback changed the hardened worker or its source record\n' >&2
  exit 1
}
if verify_host_renewal_files "${old_release}"; then
  printf 'ERROR: hardened host bundle unexpectedly matched the old rollback target\n' >&2
  exit 1
fi

# Test: the old release's reverse rollback checks still accept the new wrapper and unchanged units.
for relative_path in \
  scripts/renew-certificates-entrypoint.sh \
  systemd/cometa-bank-cert-renew.service \
  systemd/cometa-bank-cert-renew.timer; do
  case "${relative_path}" in
    scripts/*) host_path=${host_renewal_entrypoint} ;;
    *service) host_path=${host_renewal_service} ;;
    *timer) host_path=${host_renewal_timer} ;;
  esac
  cmp -s \
    "${deploy_root}/releases/${new_release}/deploy/standalone/${relative_path}" \
    "${host_path}" || {
    printf 'ERROR: old release reverse-rollback compatibility failed for %s\n' \
      "${relative_path}" >&2
    exit 1
  }
done

# Test: an upgrade verifies the recorded immutable worker before opening a new migration journal.
command cp -- "${host_renewal_worker}" "${harness_directory}/worker.backup"
printf '# tampered\n' >>"${host_renewal_worker}"
if ensure_host_renewal_bundle "${next_release}" "${old_release}" >"${output_file}" 2>&1; then
  printf 'ERROR: upgrade accepted a tampered recorded host worker\n' >&2
  exit 1
fi
[[ ! -e "${host_renewal_pending_record}" ]] || {
  printf 'ERROR: failed integrity preflight opened a migration journal\n' >&2
  exit 1
}
command cp -- "${harness_directory}/worker.backup" "${host_renewal_worker}"
ensure_host_renewal_bundle "${next_release}" "${old_release}" || {
  printf 'ERROR: verified host bundle could not upgrade to the next worker\n' >&2
  exit 1
}
[[ "$(<"${host_renewal_record}")" == "${next_release}" ]] || {
  printf 'ERROR: upgrade did not record the next immutable worker source\n' >&2
  exit 1
}

# Test: activation/rollback state gate rejects deterministic orphans and durable recovery state.
rm -f -- "${volume_present_file}" "${volume_dirty_file}" \
  "${volume_inspect_error_file}" "${renewal_orphan_file}" "${helper_orphan_file}" \
  "${container_list_error_file}"
renewal_state_is_clean || {
  printf 'ERROR: clean host without an ACME volume failed the renewal-state gate\n' >&2
  exit 1
}
: >"${renewal_orphan_file}"
if assert_renewal_state_clean >"${output_file}" 2>&1; then
  printf 'ERROR: deterministic renewal orphan passed the release-state gate\n' >&2
  exit 1
fi
grep -Fq "run: ${renewal_recovery_instruction}" "${output_file}" || {
  printf 'ERROR: orphan rejection omitted the exact recovery-only instruction\n' >&2
  exit 1
}
rm -f -- "${renewal_orphan_file}"
: >"${container_list_error_file}"
if renewal_state_is_clean; then
  printf 'ERROR: container metadata error was treated as absence of renewal orphans\n' >&2
  exit 1
fi
rm -f -- "${container_list_error_file}"
: >"${volume_present_file}"
: >"${volume_dirty_file}"
if assert_renewal_state_clean >"${output_file}" 2>&1; then
  printf 'ERROR: durable pending recovery state passed the release-state gate\n' >&2
  exit 1
fi
grep -Fq "run: ${renewal_recovery_instruction}" "${output_file}" || {
  printf 'ERROR: pending-state rejection omitted the exact recovery-only instruction\n' >&2
  exit 1
}
rm -f -- "${volume_dirty_file}"
renewal_state_is_clean || {
  printf 'ERROR: clean existing ACME volume failed the renewal-state gate\n' >&2
  exit 1
}
: >"${volume_inspect_error_file}"
if renewal_state_is_clean; then
  printf 'ERROR: ACME volume metadata error was treated as an absent volume\n' >&2
  exit 1
fi
rm -f -- "${volume_inspect_error_file}"

# Test: the real stable entrypoint verifies its recorded bundle before forwarding arguments.
readonly entrypoint_deploy_root="${harness_directory}/entrypoint-deploy"
readonly entrypoint_host_root="${harness_directory}/entrypoint-host"
readonly entrypoint_release='20990104T000000Z'
readonly entrypoint_under_test="${entrypoint_host_root}/usr/local/sbin/cometa-bank-renew-certificates"
readonly entrypoint_worker="${entrypoint_host_root}/usr/local/libexec/cometa-bank-renew-certificates-worker"
readonly entrypoint_service="${entrypoint_host_root}/etc/systemd/system/cometa-bank-cert-renew.service"
readonly entrypoint_timer="${entrypoint_host_root}/etc/systemd/system/cometa-bank-cert-renew.timer"
readonly entrypoint_record="${entrypoint_deploy_root}/state/renewal-bundle.release"
readonly entrypoint_pending="${entrypoint_deploy_root}/state/renewal-bundle.pending"
readonly entrypoint_recorded_root="${entrypoint_deploy_root}/releases/${entrypoint_release}/deploy/standalone"
readonly entrypoint_arguments="${harness_directory}/entrypoint-arguments"
readonly entrypoint_fake_bin="${harness_directory}/entrypoint-bin"

mkdir -p \
  "$(dirname -- "${entrypoint_under_test}")" \
  "$(dirname -- "${entrypoint_worker}")" \
  "$(dirname -- "${entrypoint_service}")" \
  "${entrypoint_deploy_root}/state" \
  "${entrypoint_recorded_root}/scripts" \
  "${entrypoint_recorded_root}/systemd" \
  "${entrypoint_fake_bin}"
sed \
  -e "s#readonly deploy_root='/srv/cometa-bank'#readonly deploy_root='${entrypoint_deploy_root}'#" \
  -e "s#readonly renewal_entrypoint='/usr/local/sbin/cometa-bank-renew-certificates'#readonly renewal_entrypoint='${entrypoint_under_test}'#" \
  -e "s#readonly renewal_worker='/usr/local/libexec/cometa-bank-renew-certificates-worker'#readonly renewal_worker='${entrypoint_worker}'#" \
  -e "s#readonly renewal_service='/etc/systemd/system/cometa-bank-cert-renew.service'#readonly renewal_service='${entrypoint_service}'#" \
  -e "s#readonly renewal_timer='/etc/systemd/system/cometa-bank-cert-renew.timer'#readonly renewal_timer='${entrypoint_timer}'#" \
  "${entrypoint_script}" >"${entrypoint_under_test}"
chmod 0755 "${entrypoint_under_test}"
command cp -- \
  "${entrypoint_under_test}" \
  "${entrypoint_recorded_root}/scripts/renew-certificates-entrypoint.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''%s\n'\'' "$@" >"${ENTRYPOINT_ARGUMENTS}"' \
  >"${entrypoint_worker}"
chmod 0755 "${entrypoint_worker}"
command cp -- "${entrypoint_worker}" \
  "${entrypoint_recorded_root}/scripts/renew-certificates.sh"
printf '[Unit]\nDescription=fixture\n' >"${entrypoint_service}"
printf '[Unit]\nDescription=fixture timer\n' >"${entrypoint_timer}"
command cp -- "${entrypoint_service}" \
  "${entrypoint_recorded_root}/systemd/cometa-bank-cert-renew.service"
command cp -- "${entrypoint_timer}" \
  "${entrypoint_recorded_root}/systemd/cometa-bank-cert-renew.timer"
printf '%s\n' "${entrypoint_release}" >"${entrypoint_record}"
chmod 0600 "${entrypoint_record}"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "${3:-}" in' \
  '  "${ENTRYPOINT_RECORD}") printf '\''0:0:600\n'\'' ;;' \
  '  "${ENTRYPOINT_SCRIPT}"|"${ENTRYPOINT_WORKER}") printf '\''0:0:755\n'\'' ;;' \
  '  "${ENTRYPOINT_SERVICE}"|"${ENTRYPOINT_TIMER}") printf '\''0:0:644\n'\'' ;;' \
  '  *) exit 1 ;;' \
  'esac' \
  >"${entrypoint_fake_bin}/stat"
chmod 0755 "${entrypoint_fake_bin}/stat"

run_entrypoint() {
  env \
    ENTRYPOINT_ARGUMENTS="${entrypoint_arguments}" \
    ENTRYPOINT_RECORD="${entrypoint_record}" \
    ENTRYPOINT_SCRIPT="${entrypoint_under_test}" \
    ENTRYPOINT_WORKER="${entrypoint_worker}" \
    ENTRYPOINT_SERVICE="${entrypoint_service}" \
    ENTRYPOINT_TIMER="${entrypoint_timer}" \
    PATH="${entrypoint_fake_bin}:${PATH}" \
    bash "${entrypoint_under_test}" "$@"
}

run_entrypoint --recover-only || {
  printf 'ERROR: valid recorded entrypoint bundle did not execute its worker\n' >&2
  exit 1
}
[[ "$(<"${entrypoint_arguments}")" == '--recover-only' ]] || {
  printf 'ERROR: stable entrypoint did not forward its worker argument\n' >&2
  exit 1
}
rm -f -- "${entrypoint_arguments}"
: >"${entrypoint_pending}"
if run_entrypoint --recover-only >"${output_file}" 2>&1; then
  printf 'ERROR: stable entrypoint ran during an incomplete bundle migration\n' >&2
  exit 1
fi
[[ ! -e "${entrypoint_arguments}" ]] || {
  printf 'ERROR: stable entrypoint reached its worker during bundle migration\n' >&2
  exit 1
}
rm -f -- "${entrypoint_pending}"
printf '# tampered\n' >>"${entrypoint_worker}"
if run_entrypoint --recover-only >"${output_file}" 2>&1; then
  printf 'ERROR: stable entrypoint executed a worker that differs from its recorded source\n' >&2
  exit 1
fi
[[ ! -e "${entrypoint_arguments}" ]] || {
  printf 'ERROR: tampered host worker was executed\n' >&2
  exit 1
}

printf 'Standalone host renewal-bundle migration and rollback harness passed.\n'
