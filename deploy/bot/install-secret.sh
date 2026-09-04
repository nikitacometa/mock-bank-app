#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly secret_directory='/etc/cometa-bank/secrets'
readonly secret_path="${secret_directory}/bot_token"
readonly previous_secret_path="${secret_directory}/bot_token.previous"
readonly expected_bot_username='MyBankApp_Bot'
readonly service_uid="${COMETA_BOT_UID:-1000}"

declare -a temporary_paths=()
bot_token=''

cleanup() {
  bot_token=''
  unset bot_token
  local path
  for path in "${temporary_paths[@]}"; do
    if [[ -n "${path}" && -f "${path}" ]]; then
      rm -f -- "${path}"
    fi
  done
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

track_temporary_file() {
  temporary_paths+=("$1")
}

assert_safe_secret_paths() {
  if [[ -L "${secret_directory}" || -L "${secret_path}" || -L "${previous_secret_path}" ]]; then
    fail 'refusing a symlinked secret path'
  fi
  if [[ -e "${secret_path}" && ! -f "${secret_path}" ]]; then
    fail 'current bot token path is not a regular file'
  fi
  if [[ -e "${previous_secret_path}" && ! -f "${previous_secret_path}" ]]; then
    fail 'previous bot token path is not a regular file'
  fi
}

# The token-bearing URL exists only in a root-readable temporary curl config.
# It is never placed in argv, stdout, stderr, or the service logs.
validate_candidate_token() {
  local -r candidate_path=$1
  local -r scratch_directory=${2:-${secret_directory}}
  local request_config response_file token
  local valid=false

  request_config="$(mktemp "${scratch_directory}/.get-me-request.XXXXXX")" || return 1
  track_temporary_file "${request_config}"
  response_file="$(mktemp "${scratch_directory}/.get-me-response.XXXXXX")" || return 1
  track_temporary_file "${response_file}"
  chmod 0600 "${request_config}" "${response_file}" || return 1

  IFS= read -r token <"${candidate_path}" || return 1
  if [[ ! "${token}" =~ ^[0-9]{6,20}:[A-Za-z0-9_-]{30,}$ ]]; then
    token=''
    unset token
    return 1
  fi
  if ! printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "${token}" >"${request_config}"; then
    token=''
    unset token
    return 1
  fi
  token=''
  unset token

  if curl \
    --disable \
    --silent \
    --fail \
    --proto '=https' \
    --tlsv1.2 \
    --connect-timeout 5 \
    --max-time 10 \
    --output "${response_file}" \
    --config "${request_config}" \
    2>/dev/null &&
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "${response_file}" &&
    grep -Eiq '"username"[[:space:]]*:[[:space:]]*"MyBankApp_Bot"' "${response_file}"; then
    valid=true
  fi

  rm -f -- "${request_config}" "${response_file}" || return 1
  [[ "${valid}" == true ]]
}

backup_current_secret() {
  [[ -f "${secret_path}" ]] || return 0
  local backup_path
  backup_path="$(mktemp "${secret_directory}/.bot_token.previous.XXXXXX")"
  track_temporary_file "${backup_path}"
  install -m 0600 -o root -g root -- "${secret_path}" "${backup_path}"
  mv -f -- "${backup_path}" "${previous_secret_path}"
}

install_candidate_secret() {
  local candidate_path

  IFS= read -r -s -p 'Paste the rotated BotFather token: ' bot_token </dev/tty
  printf '\n' >&2
  if [[ ! "${bot_token}" =~ ^[0-9]{6,20}:[A-Za-z0-9_-]{30,}$ ]]; then
    fail 'token format is invalid; the live token was not changed'
  fi

  candidate_path="$(mktemp "${secret_directory}/.bot_token.candidate.XXXXXX")"
  track_temporary_file "${candidate_path}"
  printf '%s\n' "${bot_token}" >"${candidate_path}"
  bot_token=''
  unset bot_token
  chown root:root -- "${candidate_path}"
  chmod 0600 -- "${candidate_path}"

  if ! validate_candidate_token "${candidate_path}"; then
    fail \
      "candidate token was not accepted by @${expected_bot_username}; the live token was not changed"
  fi

  backup_current_secret
  chown "${service_uid}:${service_uid}" -- "${candidate_path}"
  chmod 0600 -- "${candidate_path}"
  mv -f -- "${candidate_path}" "${secret_path}"

  printf 'Validated and installed the bot token with mode 0600 for container UID %s.\n' \
    "${service_uid}"
  if [[ -f "${previous_secret_path}" ]]; then
    printf 'The previous token is retained root-only for activation rollback.\n'
  fi
}

restore_previous_secret() {
  [[ -f "${previous_secret_path}" ]] || fail 'no previous bot token is available for rollback'
  local restored_path
  restored_path="$(mktemp "${secret_directory}/.bot_token.restore.XXXXXX")"
  track_temporary_file "${restored_path}"
  install -m 0600 -o "${service_uid}" -g "${service_uid}" -- \
    "${previous_secret_path}" "${restored_path}"
  mv -f -- "${restored_path}" "${secret_path}"
  printf 'Restored the previous bot token for rollback.\n'
}

main() {
  if (( EUID != 0 )); then
    fail 'run this helper as root so ownership and permissions are deterministic'
  fi
  if (( $# > 1 )); then
    fail 'usage: install-secret.sh [--restore-previous]'
  fi
  if [[ ! "${service_uid}" =~ ^[1-9][0-9]{0,8}$ ]]; then
    fail 'COMETA_BOT_UID must be a positive numeric UID'
  fi

  require_command chown
  require_command chmod
  require_command curl
  require_command grep
  require_command install
  require_command mktemp
  require_command mv
  require_command rm

  assert_safe_secret_paths
  install -d -m 0700 -o root -g root -- "${secret_directory}"
  assert_safe_secret_paths

  case "${1:-}" in
    '') install_candidate_secret ;;
    --restore-previous) restore_previous_secret ;;
    *) fail 'usage: install-secret.sh [--restore-previous]' ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup EXIT
  main "$@"
fi
