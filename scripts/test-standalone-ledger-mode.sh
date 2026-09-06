#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
project_root="$(cd -- "${script_directory}/.." && pwd -P)"
readonly project_root
readonly release_script="${project_root}/deploy/standalone/scripts/release.sh"

harness_directory="$(mktemp -d)"
readonly harness_directory
readonly deploy_root="${harness_directory}/deploy"
readonly live_database_path="${deploy_root}/data/cometa-bank.sqlite"
readonly database_backup_root="${deploy_root}/backups"
readonly bot_uid='10001'
readonly release_id='20990102T000000Z'
readonly expected_current_release='20990102T000000Z'
readonly expected_previous_release='20990101T000000Z'
readonly event_file="${harness_directory}/events"
readonly output_file="${harness_directory}/output"
apply_rollback=false
compat_copy=''
trap 'rm -rf -- "${harness_directory}"' EXIT

mkdir -p "$(dirname -- "${live_database_path}")" "${database_backup_root}"
: >"${event_file}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

extract_function() {
  local -r function_name=$1
  awk -v signature="${function_name}() {" '
    $0 == signature { inside = 1 }
    inside { print }
    inside && $0 == "}" { exit }
  ' "${release_script}"
}

eval "$(extract_function read_database_ledger_mode)"
eval "$(extract_function verify_live_database_integrity | \
  sed '1s/^verify_live_database_integrity()/verify_live_database_integrity_impl()/')"
eval "$(extract_function assert_authority_bridge)"
eval "$(extract_function prepare_ledger_mode_backup)"
eval "$(extract_function verify_local_authority_backup_with_image | \
  sed '1s/^verify_local_authority_backup_with_image()/verify_local_authority_backup_with_image_impl()/')"
eval "$(extract_function switch_live_ledger_mode_to_server | \
  sed '1s/^switch_live_ledger_mode_to_server()/switch_live_ledger_mode_to_server_impl()/')"
eval "$(extract_function reconcile_failed_ledger_mode_switch)"
eval "$(extract_function guard_server_authority_release_transition)"
eval "$(extract_function restart_bot_for_server_commands)"
eval "$(extract_function enable_server_ledger_mode)"
eval "$(extract_function record_deployment | \
  sed '1s/^record_deployment()/record_deployment_impl()/')"

reset_database() {
  command rm -f -- "${live_database_path}"
  sqlite3 "${live_database_path}" <<'SQL'
CREATE TABLE service_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  ledger_mode TEXT NOT NULL CHECK (ledger_mode IN ('local', 'server'))
) STRICT;
INSERT INTO service_state (singleton, ledger_mode) VALUES (1, 'local');
CREATE TABLE bank_states (telegram_user_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE bank_operations (id INTEGER PRIMARY KEY) STRICT;
CREATE TABLE bank_outbox (id INTEGER PRIMARY KEY) STRICT;
CREATE TABLE conversation_sessions (telegram_user_id TEXT PRIMARY KEY) STRICT;
SQL
}

force_post_switch_integrity_failure=false
verify_live_database_integrity() {
  if [[ "${force_post_switch_integrity_failure}" == true ]] && \
    [[ "$(read_database_ledger_mode)" == 'server' ]]; then
    fail 'forced post-switch integrity failure'
  fi
  verify_live_database_integrity_impl
}

record_event() {
  printf '%s\n' "$1" >>"${event_file}"
}

verify_authority_release() {
  record_event "verify-release:$1"
}

backup_probe_failure_release=''
verify_local_authority_backup_with_image() {
  [[ -f "$2" ]] || return 1
  [[ "$(sqlite3 -readonly -batch -noheader "$2" 'PRAGMA journal_mode;')" == 'delete' ]] || {
    printf 'ERROR: WAL backup copy was not normalized to DELETE\n' >&2
    return 1
  }
  [[ "$(sqlite3 -readonly -batch -noheader "$2" \
    "PRAGMA quick_check; SELECT ledger_mode FROM service_state WHERE singleton = 1; SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('bank_operations', 'bank_outbox', 'bank_states', 'conversation_sessions', 'service_state');")" == \
    $'ok\nlocal\n5' ]] || return 1
  if [[ "$1" == "${backup_probe_failure_release}" ]]; then
    record_event "verify-backup-failed:$1"
    return 1
  fi
  verify_local_authority_backup_with_image_impl "$@" || {
    printf 'ERROR: shell-parsed authority backup JavaScript failed\n' >&2
    return 1
  }
  record_event "verify-backup:$1"
}

backup_normalization_failure=''
sqlite3() {
  if [[ "$*" == *'PRAGMA journal_mode=DELETE;' ]]; then
    case "${backup_normalization_failure}" in
      command) return 1 ;;
      unchanged) printf 'wal\n'; return 0 ;;
    esac
  fi
  command sqlite3 "$@"
}

stat() {
  [[ "$1" == '-c' && "$2" == '%u:%g:%a' && -f "$3" ]] || return 1
  printf '0:0:600\n'
}

chown() {
  [[ "$1" == '--' && "$2" == '+10001:+10001' && -f "$3" ]] || return 1
}

journal_sync_failure_context=''
backup_sync_should_fail=false
sync() {
  [[ "$1" == '-f' && -f "$2" ]] || return 1
  if [[ "$2" == "${deploy_root}/deployments.jsonl" ]]; then
    record_event "sync-journal:${journal_sync_context:-missing}"
    [[ "${journal_sync_failure_context}" != "${journal_sync_context:-missing}" ]] || return 1
    return 0
  fi
  [[ "$2" == "${database_backup_root}/"*.sqlite ]] || return 1
  record_event 'sync-backup'
  [[ "${backup_sync_should_fail}" != true ]] || return 1
}

date() {
  [[ "$1" == '-u' ]] || return 1
  case "$2" in
    +%Y%m%dT%H%M%SZ) printf '20990103T000000Z\n' ;;
    +%Y-%m-%dT%H:%M:%SZ) printf '2099-01-03T00:00:00Z\n' ;;
    *) return 1 ;;
  esac
}

docker() {
  if [[ "$1" == run || "$1" == exec ]]; then
    # Execute the actual --eval argument after Bash has parsed its quotes.
    # Only redirect container database paths to this harness SQLite fixture.
    local javascript="${!#}" database_path="${live_database_path}" argument
    [[ "${javascript}" == *'import { DatabaseSync } from "node:sqlite";'* ]] || return 1
    for argument in "$@"; do
      if [[ "${argument}" == type=bind,src=*,dst=/data/check.sqlite,readonly ]]; then
        database_path=${argument#type=bind,src=}
        database_path=${database_path%,dst=/data/check.sqlite,readonly}
      fi
    done
    [[ "${database_path}" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
    javascript=${javascript//\/data\/check.sqlite/${database_path}}
    javascript=${javascript//\/data\/cometa-bank.sqlite/${live_database_path}}
    node --input-type=module --eval "${javascript}"
    return $?
  fi
  [[ "$1" == 'image' && "$2" == 'inspect' && "$3" == '--format' && \
    "$4" == '{{.Id}}' ]] || return 1
  case "$5" in
    "cometa-bank-web:${expected_current_release}") printf 'sha256:%064d\n' 1 ;;
    "cometa-bank-bot:${expected_current_release}") printf 'sha256:%064d\n' 2 ;;
    *) return 1 ;;
  esac
}

compose_release() {
  [[ "$*" == "${expected_current_release} ps -q bot" ]] || return 1
  printf '%064d\n' 1
}

read_release_link() {
  case "$1" in
    current) printf '%s\n' "${expected_current_release}" ;;
    previous) printf '%s\n' "${expected_previous_release}" ;;
    *) return 1 ;;
  esac
}

service_health() {
  record_event "health:$1:$2"
}

assert_staged_edge_contract() {
  :
}

verify_release_compose_edge_contract() {
  record_event "verify-compose-edge:$1"
}

inner_upstream_https_smoke() {
  [[ "$1" == "${expected_current_release}" ]]
}

outer_caddy_https_smoke() {
  [[ "$1" == "${expected_current_release}" ]] || return 1
}

prepare_ledger_mode_backup_stub() {
  record_event 'prepare-backup'
  printf '%s/verified.sqlite\n' "${database_backup_root}"
}

record_deployment() {
  local record_status
  record_event "audit:$1:$2"
  journal_sync_context=$1
  if record_deployment_impl "$@"; then
    record_status=0
  else
    record_status=$?
  fi
  journal_sync_context=''
  return "${record_status}"
}

switch_behavior='success'
switch_live_ledger_mode_to_server() {
  record_event 'switch-server'
  case "${switch_behavior}" in
    success)
      sqlite3 "${live_database_path}" \
        "UPDATE service_state SET ledger_mode = 'server' WHERE singleton = 1 AND ledger_mode = 'local';"
      ;;
    fail-before-commit)
      return 1
      ;;
    fail-after-commit)
      sqlite3 "${live_database_path}" \
        "UPDATE service_state SET ledger_mode = 'server' WHERE singleton = 1 AND ledger_mode = 'local';"
      return 1
      ;;
    *) return 1 ;;
  esac
}

wait_for_services() {
  record_event 'wait-services'
}

bot_restart_should_fail=false
restart_bot_for_server_commands() {
  record_event "restart-bot:$1"
  [[ "${bot_restart_should_fail}" != true ]]
}

print_diagnostics() {
  record_event 'diagnostics'
}

log() {
  record_event "log:$*"
}

reset_database
[[ "$(read_database_ledger_mode)" == 'local' ]]
verify_live_database_integrity

# Exercise the real shell-parsed switch SQL against scratch data before the
# later orchestration failure-injection stubs. A repeated switch must reject.
switch_live_ledger_mode_to_server_impl "${expected_current_release}" || \
  fail 'shell-parsed ledger-mode switch JavaScript failed'
[[ "$(read_database_ledger_mode)" == 'server' ]] || exit 1
if (switch_live_ledger_mode_to_server_impl "${expected_current_release}") \
  >"${output_file}" 2>&1; then
  fail 'shell-parsed ledger-mode switch accepted an already-server database'
fi
grep -Fq 'ledger mode is not local' "${output_file}" || exit 1
[[ "$(read_database_ledger_mode)" == 'server' ]] || exit 1
reset_database

# The bridge must consist of two distinct authority-capable immutable releases,
# and the operator script itself must come from current.
: >"${event_file}"
assert_authority_bridge "${expected_current_release}" "${expected_previous_release}"
[[ "$(<"${event_file}")" == $'verify-release:20990102T000000Z\nverify-release:20990101T000000Z' ]]
if (assert_authority_bridge "${expected_current_release}" "${expected_current_release}") \
  >"${output_file}" 2>&1; then
  printf 'ERROR: same-release authority bridge was accepted\n' >&2
  exit 1
fi

# The production backup flow uses SQLite online backup, verifies quick_check,
# requires the local marker, probes both images, and only then fsyncs the file.
# Match production WAL, while requiring only its disposable copy to become a
# self-contained DELETE database readable by the read-only image probe.
[[ "$(sqlite3 "${live_database_path}" 'PRAGMA journal_mode=WAL;')" == 'wal' ]] || exit 1
: >"${event_file}"
backup_path="$(prepare_ledger_mode_backup \
  "${expected_current_release}" "${expected_previous_release}")"
[[ "${backup_path}" == \
  "${database_backup_root}/20990103T000000Z-before-ledger-mode-server.sqlite" ]]
[[ "$(sqlite3 -batch -noheader "${backup_path}" 'PRAGMA quick_check;')" == 'ok' ]]
[[ "$(sqlite3 -batch -noheader "${backup_path}" \
  'SELECT ledger_mode FROM service_state WHERE singleton = 1;')" == 'local' ]]
[[ "$(sqlite3 "${live_database_path}" 'PRAGMA journal_mode;')" == 'wal' ]] || exit 1
[[ "$(sqlite3 "${backup_path}" 'PRAGMA journal_mode;')" == 'wal' ]] || exit 1
[[ "$(sqlite3 "${backup_path}" .dump)" == "$(sqlite3 "${live_database_path}" .dump)" ]] || exit 1
[[ "$(<"${event_file}")" == $'verify-backup:20990102T000000Z\nverify-backup:20990101T000000Z\nsync-backup' ]]

# A failed conversion or a successful PRAGMA that retains WAL must stop before
# either image probe or the authority switch and remove the disposable copy.
for backup_normalization_failure in command unchanged; do
  command rm -f -- "${backup_path}"
  reset_database
  [[ "$(sqlite3 "${live_database_path}" 'PRAGMA journal_mode=WAL;')" == 'wal' ]] || exit 1
  apply_rollback=true
  : >"${event_file}"
  if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
    fail "failed backup journal normalization was accepted: ${backup_normalization_failure}"
  fi
  grep -Eq 'cannot normalize|must use DELETE journal mode' "${output_file}" || exit 1
  [[ "$(read_database_ledger_mode)" == 'local' ]] || exit 1
  [[ "$(sqlite3 "${live_database_path}" 'PRAGMA journal_mode;')" == 'wal' ]] || exit 1
  [[ "$(sqlite3 "${backup_path}" 'PRAGMA journal_mode;')" == 'wal' ]] || exit 1
  [[ ! -e "${backup_path}.compat" ]] || exit 1
  ! grep -Eq 'verify-backup:|switch-server|audit:' "${event_file}" || exit 1
done
backup_normalization_failure=''

# Either authority-image probe can fail after the service-owned compatibility
# copy exists. Its function-local EXIT trap must remove that copy before the
# failed preflight returns, and authority must remain local.
for backup_probe_failure_release in \
  "${expected_current_release}" \
  "${expected_previous_release}"; do
  command rm -f -- "${backup_path}" "${backup_path}.compat"
  reset_database
  apply_rollback=true
  : >"${event_file}"
  if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
    printf 'ERROR: failed authority-image backup probe was accepted: %s\n' \
      "${backup_probe_failure_release}" >&2
    exit 1
  fi
  grep -Fq 'authority image cannot verify the ledger-mode backup' "${output_file}"
  [[ "$(read_database_ledger_mode)" == 'local' ]]
  ! grep -Fq 'switch-server' "${event_file}"
  if find "${database_backup_root}" -maxdepth 1 -name '*.compat' -print -quit | grep -q .; then
    printf 'ERROR: failed authority-image backup probe left a compatibility copy: %s\n' \
      "${backup_probe_failure_release}" >&2
    exit 1
  fi
done
backup_probe_failure_release=''

# A failed backup fsync is fatal even though the function is called through a
# command substitution. No authority marker or pre-switch event may follow it.
command rm -f -- "${backup_path}"
reset_database
apply_rollback=true
backup_sync_should_fail=true
: >"${event_file}"
if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
  printf 'ERROR: unsynced ledger-mode backup was accepted\n' >&2
  exit 1
fi
backup_sync_should_fail=false
apply_rollback=false
grep -Fq 'cannot durably flush the ledger-mode backup' "${output_file}"
[[ "$(read_database_ledger_mode)" == 'local' ]]
! grep -Eq 'audit:|switch-server' "${event_file}"

# Dry-run is genuinely read-only and prints the exact apply command.
reset_database
: >"${event_file}"
prepare_ledger_mode_backup() { prepare_ledger_mode_backup_stub "$@"; }
enable_server_ledger_mode >"${output_file}"
grep -Fq 'Ledger authority plan: local -> server' "${output_file}"
grep -Fq 'release.sh ledger-mode server --apply' "${output_file}"
! grep -Eq 'prepare-backup|switch-server|audit:|wait-services' "${event_file}"
[[ "$(grep -Fc "verify-compose-edge:${expected_current_release}" "${event_file}")" == '1' ]]
[[ "$(grep -Fc "verify-compose-edge:${expected_previous_release}" "${event_file}")" == '1' ]]
[[ "$(read_database_ledger_mode)" == 'local' ]]

# Apply order is backup -> durable pre-event -> one-way switch -> final event ->
# stable service health. No local-mode write exists in the operator path.
apply_rollback=true
: >"${event_file}"
enable_server_ledger_mode
[[ "$(read_database_ledger_mode)" == 'server' ]]
events="$(<"${event_file}")"
for ordered_event in \
  prepare-backup \
  "audit:ledger-mode-server-ready:${expected_current_release}" \
  'sync-journal:ledger-mode-server-ready' \
  switch-server \
  "audit:ledger-mode-server:${expected_current_release}" \
  'sync-journal:ledger-mode-server' \
  "restart-bot:${expected_current_release}" \
  wait-services; do
  line="$(awk -v event="${ordered_event}" '$0 == event { print NR; exit }' <<<"${events}")"
  [[ "${line}" =~ ^[0-9]+$ ]] || {
    printf 'ERROR: missing ledger-mode event: %s\n' "${ordered_event}" >&2
    exit 1
  }
  if [[ -n "${prior_line:-}" ]]; then
    (( line > prior_line )) || {
      printf 'ERROR: ledger-mode event order failed at %s\n' "${ordered_event}" >&2
      exit 1
    }
  fi
  prior_line=${line}
done
[[ "$(grep -Fc 'switch-server' <<<"${events}")" == '1' ]]
[[ "$(grep -Fc "restart-bot:${expected_current_release}" <<<"${events}")" == '1' ]]
[[ "$(grep -Fc 'wait-services' <<<"${events}")" == '1' ]]

# A helper can fail after SQLite COMMIT. The caller must inspect the persisted
# mode and integrity, then complete the final journal and health audit.
reset_database
switch_behavior='fail-after-commit'
: >"${event_file}"
enable_server_ledger_mode >"${output_file}" 2>&1
[[ "$(read_database_ledger_mode)" == 'server' ]]
events="$(<"${event_file}")"
ready_sync_line="$(awk '$0 == "sync-journal:ledger-mode-server-ready" { print NR; exit }' \
  <<<"${events}")"
switch_line="$(awk '$0 == "switch-server" { print NR; exit }' <<<"${events}")"
final_sync_line="$(awk '$0 == "sync-journal:ledger-mode-server" { print NR; exit }' \
  <<<"${events}")"
[[ "${ready_sync_line}" =~ ^[0-9]+$ && "${switch_line}" =~ ^[0-9]+$ ]]
(( ready_sync_line < switch_line ))
[[ "${final_sync_line}" =~ ^[0-9]+$ ]]
(( switch_line < final_sync_line ))
grep -Fq \
  'log:ledger-mode helper failed after the server marker committed; integrity is verified and final audit will continue' \
  <<<"${events}"
[[ "$(grep -Fc 'switch-server' <<<"${events}")" == '1' ]]
[[ "$(grep -Fc "restart-bot:${expected_current_release}" <<<"${events}")" == '1' ]]
[[ "$(grep -Fc 'wait-services' <<<"${events}")" == '1' ]]

# If the helper may have committed but SQLite integrity cannot be established,
# the result is indeterminate and no final audit or health claim is allowed.
reset_database
switch_behavior='fail-after-commit'
force_post_switch_integrity_failure=true
: >"${event_file}"
if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
  printf 'ERROR: post-commit integrity failure was accepted\n' >&2
  exit 1
fi
force_post_switch_integrity_failure=false
grep -Fq \
  'ledger-mode helper failed and SQLite integrity is unverified; no automatic reversal was attempted' \
  "${output_file}"
[[ "$(read_database_ledger_mode)" == 'server' ]]
[[ "$(grep -Fc 'switch-server' "${event_file}")" == '1' ]]
! grep -Fq 'audit:ledger-mode-server:' "${event_file}"
! grep -Fq 'wait-services' "${event_file}"

# A journal flush failure is a real pre-commit failure: it cannot be swallowed
# by wrapper cleanup, and the database must remain local.
reset_database
switch_behavior='success'
journal_sync_failure_context='ledger-mode-server-ready'
: >"${event_file}"
if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
  printf 'ERROR: unsynced pre-switch journal was accepted\n' >&2
  exit 1
fi
journal_sync_failure_context=''
grep -Fq 'ledger-mode pre-switch audit could not be recorded; database remains local' \
  "${output_file}"
[[ "$(read_database_ledger_mode)" == 'local' ]]
! grep -Fq 'switch-server' "${event_file}"

# A final audit flush can fail after COMMIT. The next explicit --apply rerun
# must append a durable reconciliation event and re-run stable health.
reset_database
switch_behavior='success'
journal_sync_failure_context='ledger-mode-server'
: >"${event_file}"
if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
  printf 'ERROR: unsynced final ledger-mode journal was accepted\n' >&2
  exit 1
fi
[[ "$(read_database_ledger_mode)" == 'server' ]]
! grep -Fq 'wait-services' "${event_file}"
journal_sync_failure_context=''
: >"${event_file}"
enable_server_ledger_mode
grep -Fq "audit:ledger-mode-server-reconciled:${expected_current_release}" "${event_file}"
grep -Fq 'sync-journal:ledger-mode-server-reconciled' "${event_file}"
grep -Fq "restart-bot:${expected_current_release}" "${event_file}"
grep -Fq 'wait-services' "${event_file}"
grep -Fq 'log:server ledger authority and its durable audit trail are reconciled' \
  "${event_file}"

# The mode remains one-way if the controlled restart that republishes the
# server-only command menu fails. No healthy claim is allowed, and rerunning
# --apply provides the explicit recovery path.
bot_restart_should_fail=true
: >"${event_file}"
if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
  printf 'ERROR: failed server-command bot restart was accepted\n' >&2
  exit 1
fi
bot_restart_should_fail=false
grep -Fq 'bot command profile restart failed; mode was not reversed' "${output_file}"
[[ "$(read_database_ledger_mode)" == 'server' ]]
grep -Fq "restart-bot:${expected_current_release}" "${event_file}"
! grep -Fq 'wait-services' "${event_file}"

# A pre-commit helper failure must likewise report the verified local mode.
reset_database
switch_behavior='fail-before-commit'
: >"${event_file}"
if (enable_server_ledger_mode) >"${output_file}" 2>&1; then
  printf 'ERROR: pre-commit helper failure was accepted\n' >&2
  exit 1
fi
grep -Fq 'ledger-mode helper failed; verified database remains local' "${output_file}"
[[ "$(read_database_ledger_mode)" == 'local' ]]
[[ "$(grep -Fc 'switch-server' "${event_file}")" == '1' ]]
! grep -Fq 'audit:ledger-mode-server:' "${event_file}"
! grep -Fq 'wait-services' "${event_file}"

# Once server authority is live, release transitions require authority-capable
# target and fallback images. Local mode keeps the legacy migration path open.
sqlite3 "${live_database_path}" \
  "UPDATE service_state SET ledger_mode = 'server' WHERE singleton = 1 AND ledger_mode = 'local';"
: >"${event_file}"
guard_server_authority_release_transition \
  "${expected_current_release}" "${expected_previous_release}"
[[ "$(<"${event_file}")" == $'verify-release:20990102T000000Z\nverify-release:20990101T000000Z' ]]
sqlite3 "${live_database_path}" "UPDATE service_state SET ledger_mode = 'local' WHERE singleton = 1;"
: >"${event_file}"
guard_server_authority_release_transition \
  "${expected_current_release}" "${expected_previous_release}"
[[ ! -s "${event_file}" ]]

printf 'Standalone ledger-mode harness passed.\n'
