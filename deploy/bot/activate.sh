#!/usr/bin/env bash
set -Eeuo pipefail

readonly health_url='http://127.0.0.1:8787/healthz'
# Startup can spend the full setup deadline before the first long poll marks the
# worker ready. Keep an explicit 65-second margin for image and host overhead.
readonly bot_setup_deadline_seconds=150
readonly initial_long_poll_timeout_seconds=25
readonly health_readiness_margin_seconds=65
readonly health_deadline_seconds=$((
  bot_setup_deadline_seconds +
  initial_long_poll_timeout_seconds +
  health_readiness_margin_seconds
))
readonly health_probe_interval_seconds='0.5'
readonly data_directory='/home/metaflexer/euphoria.bot/bot-data'
readonly secret_path='/etc/cometa-bank/secrets/bot_token'
readonly activation_lock='/run/lock/cometa-bank-bot.activate.lock'

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
release_root="$(cd "${script_directory}/../.." && pwd -P)"
readonly release_root
readonly compose_file="${script_directory}/compose.yaml"
image_tag="${COMETA_BOT_IMAGE_TAG:-$(basename "${release_root}")}"
readonly image_tag

rotate_token=false
previous_running=false
previous_image_tag=''
had_live_secret=false
token_changed=false

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

compose_for_tag() {
  local -r tag=$1
  shift
  COMETA_BOT_IMAGE_TAG="${tag}" docker compose -f "${compose_file}" "$@"
}

print_sanitized_diagnostics() {
  local -r tag=$1
  printf 'Container status:\n' >&2
  compose_for_tag "${tag}" ps >&2 || true
  printf 'Sanitized recent bot logs:\n' >&2
  compose_for_tag "${tag}" logs --no-color --tail=80 bot 2>&1 | \
    sed -E \
      -e 's/[0-9]{6,20}:[A-Za-z0-9_-]{30,}/[REDACTED_BOT_TOKEN]/g' \
      -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' >&2 || true
}

wait_for_health() {
  local -r deadline=$((SECONDS + health_deadline_seconds))
  while true; do
    if curl --disable --fail --silent --show-error --connect-timeout 0.25 --max-time 0.5 \
      "${health_url}" >/dev/null 2>&1; then
      return 0
    fi
    (( SECONDS < deadline )) || return 1
    sleep "${health_probe_interval_seconds}"
  done
}

capture_previous_state() {
  local raw_container_ids previous_container_id previous_image
  raw_container_ids="$(docker ps \
    --filter 'label=com.docker.compose.project=cometa-bank-bot' \
    --filter 'label=com.docker.compose.service=bot' \
    --format '{{.ID}}')" || fail 'could not inspect the running bot service'
  [[ -n "${raw_container_ids}" ]] || return 0
  if [[ "${raw_container_ids}" == *$'\n'* ]]; then
    fail 'more than one running Cometa bot container exists'
  fi

  previous_container_id="${raw_container_ids}"
  previous_image="$(docker inspect --format '{{.Config.Image}}' "${previous_container_id}")" || \
    fail 'could not inspect the running bot image'
  if [[ ! "${previous_image}" =~ ^cometa-bank-bot:([0-9]{8}T[0-9]{6}Z)$ ]]; then
    fail 'the running bot does not use an immutable release image tag'
  fi
  previous_image_tag="${BASH_REMATCH[1]}"
  previous_running=true
}

capture_secret_state() {
  if [[ -L "${secret_path}" ]]; then
    fail 'refusing a symlinked live bot token'
  fi
  if [[ -e "${secret_path}" ]]; then
    [[ -f "${secret_path}" ]] || fail 'live bot token path is not a regular file'
    had_live_secret=true
  fi
  if [[ "${previous_running}" == true && "${had_live_secret}" != true ]]; then
    fail 'a bot is running but its live token file is missing'
  fi
}

restore_previous_token() {
  "${script_directory}/install-secret.sh" --restore-previous
}

rollback_previous_state() {
  if [[ "${previous_running}" != true ]]; then
    printf 'No previously running bot release exists; stopping the failed candidate.\n' >&2
    compose_for_tag "${image_tag}" stop --timeout 20 bot >/dev/null 2>&1 || true
    return 1
  fi

  printf 'Restoring previous bot release %s.\n' "${previous_image_tag}" >&2
  if [[ "${token_changed}" == true && "${had_live_secret}" == true ]]; then
    if ! restore_previous_token; then
      printf 'ERROR: previous token restoration failed.\n' >&2
      return 1
    fi
  fi

  if ! compose_for_tag "${previous_image_tag}" \
    up -d --no-build --force-recreate bot; then
    printf 'ERROR: previous image recreation failed.\n' >&2
    print_sanitized_diagnostics "${previous_image_tag}"
    return 1
  fi
  if ! wait_for_health; then
    printf 'ERROR: previous release did not recover readiness.\n' >&2
    print_sanitized_diagnostics "${previous_image_tag}"
    return 1
  fi

  printf 'Rollback complete: Cometa bot %s is healthy.\n' "${previous_image_tag}" >&2
  return 0
}

handle_activation_failure() {
  local -r reason=$1
  printf 'ERROR: activation of Cometa bot %s failed: %s.\n' "${image_tag}" "${reason}" >&2
  print_sanitized_diagnostics "${image_tag}"
  if rollback_previous_state; then
    fail "candidate ${image_tag} was rejected; the previous release is healthy"
  fi
  fail 'candidate activation and automatic rollback both failed; inspect the sanitized diagnostics'
}

main() {
  if (( EUID != 0 )); then
    fail 'run this activation helper through sudo'
  fi
  if (( $# > 1 )); then
    fail 'usage: activate.sh [--rotate-token]'
  fi
  case "${1:-}" in
    '') ;;
    --rotate-token) rotate_token=true ;;
    *) fail 'usage: activate.sh [--rotate-token]' ;;
  esac
  [[ "${image_tag}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
    fail 'release directory or COMETA_BOT_IMAGE_TAG must be an immutable UTC release ID'

  require_command curl
  require_command docker
  require_command flock
  require_command install
  require_command sed
  require_command sleep
  exec 9>"${activation_lock}"
  flock --nonblock 9 || fail 'another Cometa bot activation is already running'
  test -x "${script_directory}/ensure-edge-network.sh" || \
    fail 'edge-network helper is missing or not executable'
  test -x "${script_directory}/install-secret.sh" || \
    fail 'secret installer is missing or not executable'
  docker image inspect "cometa-bank-bot:${image_tag}" >/dev/null 2>&1 || \
    fail "prebuilt image cometa-bank-bot:${image_tag} does not exist"
  if ! compose_for_tag "${image_tag}" config --quiet; then
    fail 'Compose configuration validation failed'
  fi

  capture_previous_state
  capture_secret_state
  "${script_directory}/ensure-edge-network.sh"
  install -d -m 0700 -o 1000 -g 1000 -- "${data_directory}"

  if [[ "${rotate_token}" == true || "${had_live_secret}" != true ]]; then
    "${script_directory}/install-secret.sh"
    token_changed=true
  fi

  if ! compose_for_tag "${image_tag}" \
    up -d --no-build --force-recreate bot; then
    handle_activation_failure 'container recreation failed'
  fi
  if ! wait_for_health; then
    handle_activation_failure 'readiness deadline expired'
  fi

  printf 'Cometa bot %s is healthy and ready.\n' "${image_tag}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
