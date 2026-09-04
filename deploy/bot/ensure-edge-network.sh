#!/usr/bin/env bash
set -Eeuo pipefail

readonly edge_network='cometa_bank_edge'
readonly proxy_container='cometa-proxy'
readonly expected_driver='bridge'
readonly expected_role='cometa-bank-edge'

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

is_allowed_member() {
  local container_id=$1
  local container_name compose_project compose_service

  container_name="$(docker inspect --format '{{.Name}}' "${container_id}")"
  container_name="${container_name#/}"
  if [[ "${container_name}" == "${proxy_container}" ]]; then
    return 0
  fi

  compose_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${container_id}")"
  compose_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${container_id}")"
  [[ "${compose_project}" == 'cometa-bank-bot' && "${compose_service}" == 'bot' ]]
}

verify_members() {
  local container_id
  while IFS= read -r container_id; do
    [[ -z "${container_id}" ]] && continue
    if ! is_allowed_member "${container_id}"; then
      fail "network ${edge_network} has an unexpected attached container; inspect it before continuing"
    fi
  done < <(docker network inspect --format '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' "${edge_network}")
}

require_command docker
require_command grep

if ! docker network inspect "${edge_network}" >/dev/null 2>&1; then
  docker network create \
    --driver "${expected_driver}" \
    --internal \
    --label "cometa.bank.role=${expected_role}" \
    "${edge_network}" >/dev/null
fi

network_facts="$(docker network inspect \
  --format '{{.Driver}}|{{.Internal}}|{{.Scope}}|{{index .Labels "cometa.bank.role"}}' \
  "${edge_network}")"
if [[ "${network_facts}" != "${expected_driver}|true|local|${expected_role}" ]]; then
  fail "network ${edge_network} exists with unexpected driver, isolation, scope, or ownership label"
fi

verify_members

proxy_running="$(docker inspect --format '{{.State.Running}}' "${proxy_container}" 2>/dev/null)" || \
  fail "proxy container ${proxy_container} does not exist"
[[ "${proxy_running}" == 'true' ]] || fail "proxy container ${proxy_container} is not running"

if ! docker inspect \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
  "${proxy_container}" | grep -Fxq -- "${edge_network}"; then
  docker network connect --alias "${proxy_container}" "${edge_network}" "${proxy_container}"
fi

verify_members
printf 'Edge network %s is ready; only the proxy and Cometa bot service are allowed.\n' "${edge_network}"
