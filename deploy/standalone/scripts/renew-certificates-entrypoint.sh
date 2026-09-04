#!/usr/bin/env bash
set -Eeuo pipefail

readonly deploy_root='/srv/cometa-bank'
readonly renewal_record="${deploy_root}/state/renewal-bundle.release"
readonly renewal_pending_record="${deploy_root}/state/renewal-bundle.pending"
readonly renewal_legacy_timer_journal="${deploy_root}/state/renewal-bundle.legacy-timer"
readonly renewal_entrypoint='/usr/local/sbin/cometa-bank-renew-certificates'
readonly renewal_worker='/usr/local/libexec/cometa-bank-renew-certificates-worker'
readonly renewal_service='/etc/systemd/system/cometa-bank-cert-renew.service'
readonly renewal_timer='/etc/systemd/system/cometa-bank-cert-renew.timer'

fail() {
  printf '[%s] ERROR: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" >&2
  exit 1
}

verify_recorded_file() {
  local -r source_path=$1
  local -r host_path=$2
  local -r expected_mode=$3

  [[ -f "${source_path}" && ! -L "${source_path}" ]] || return 1
  [[ -f "${host_path}" && ! -L "${host_path}" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "${host_path}")" == "0:0:${expected_mode}" ]] || return 1
  cmp -s "${source_path}" "${host_path}"
}

for command_name in cmp stat tr wc; do
  command -v "${command_name}" >/dev/null 2>&1 || \
    fail "required command not found: ${command_name}"
done

[[ ! -e "${renewal_pending_record}" && ! -L "${renewal_pending_record}" ]] || \
  fail 'host-owned certificate-renewal bundle migration is incomplete'
[[ ! -e "${renewal_legacy_timer_journal}" && ! -L "${renewal_legacy_timer_journal}" ]] || \
  fail 'legacy certificate-renewal timer migration is incomplete'
[[ -f "${renewal_record}" && ! -L "${renewal_record}" ]] || \
  fail 'host-owned certificate-renewal source record is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' "${renewal_record}")" == '0:0:600' ]] || \
  fail 'host-owned certificate-renewal source record has unsafe ownership or mode'
record_line_count="$(wc -l <"${renewal_record}" | tr -d '[:space:]')" || \
  fail 'could not read the certificate-renewal source record'
[[ "${record_line_count}" == '1' ]] || \
  fail 'host-owned certificate-renewal source record is malformed'
read -r recorded_release extra <"${renewal_record}" || \
  fail 'could not parse the certificate-renewal source record'
[[ -z "${extra:-}" && "${recorded_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
  fail 'host-owned certificate-renewal source record is malformed'
readonly recorded_release
readonly recorded_root="${deploy_root}/releases/${recorded_release}/deploy/standalone"

verify_recorded_file \
  "${recorded_root}/scripts/renew-certificates-entrypoint.sh" \
  "${renewal_entrypoint}" 755 || \
  fail 'host-owned certificate-renewal entrypoint differs from its recorded source'
verify_recorded_file \
  "${recorded_root}/scripts/renew-certificates.sh" \
  "${renewal_worker}" 755 || \
  fail 'host-owned certificate-renewal worker differs from its recorded source'
verify_recorded_file \
  "${recorded_root}/systemd/cometa-bank-cert-renew.service" \
  "${renewal_service}" 644 || \
  fail 'host-owned certificate-renewal service differs from its recorded source'
verify_recorded_file \
  "${recorded_root}/systemd/cometa-bank-cert-renew.timer" \
  "${renewal_timer}" 644 || \
  fail 'host-owned certificate-renewal timer differs from its recorded source'

exec "${renewal_worker}" "$@"
