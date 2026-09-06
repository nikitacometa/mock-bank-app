#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
umask 077

readonly target_config='/etc/docker/daemon.json'
readonly config_directory='/etc/docker'
readonly recovery_marker='/etc/docker/.cometa-bank-perimeter.pending'
readonly recovery_marker_next='/etc/docker/.cometa-bank-perimeter.pending.next'
readonly target_config_next='/etc/docker/daemon.json.cometa-bank.next'
readonly deploy_lock='/run/lock/cometa-bank.deploy.lock'
readonly deploy_root='/srv/cometa-bank'
readonly minimum_docker_version='28.0.0'
readonly health_stability_seconds='31'
readonly health_attempts='105'
readonly live_database_path="${deploy_root}/data/cometa-bank.sqlite"
readonly activation_intent_path="${deploy_root}/state/activation-recovery/pending"
readonly rollback_intent_path="${deploy_root}/state/rollback-recovery/pending"
readonly edge_recovery_marker="${deploy_root}/state/edge-hardening-recovery/pending"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
release_root="$(cd -- "${script_directory}/../../.." && pwd -P)"
readonly release_root
release_id="$(basename -- "${release_root}")"
readonly release_id
readonly source_config="${release_root}/deploy/standalone/docker/daemon.json"

apply=false
current_daemon_pid=''
current_daemon_cmdline=''
current_daemon_environment=''
marker_phase=''
marker_current_release=''
marker_web_container=''
marker_web_restart_count=''
marker_bot_container=''
marker_bot_restart_count=''
docker_transition_settled=true

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

usage() {
  printf '%s\n' \
    'Usage: install-docker-perimeter.sh [--apply]' \
    '' \
    'Without --apply, validates the existing daemon and prints the narrow restart plan.'
}

if (( $# > 1 )); then
  fail 'expected no arguments or --apply'
fi
if (( $# == 1 )); then
  case "$1" in
    --apply) apply=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
fi

[[ "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ && \
  "${release_root}" == /srv/cometa-bank/releases/"${release_id}" ]] || \
  fail 'run this installer from an immutable /srv/cometa-bank release'
(( EUID == 0 )) || fail 'run this installer through sudo'

# shellcheck source=deploy/standalone/scripts/docker-daemon-perimeter.sh
source "${script_directory}/docker-daemon-perimeter.sh"

for command_name in awk chmod chown cmp curl date dirname docker dockerd env flock getent install jq \
  mv readlink sed sha256sum sleep sqlite3 ss stat sync systemctl timeout tr unlink; do
  command -v "${command_name}" >/dev/null 2>&1 || \
    fail "required command not found: ${command_name}"
done
exec 9>"${deploy_lock}"
flock --nonblock 9 || fail 'another Cometa deployment command is running'
assert_no_docker_cli_target_overrides

validate_secure_regular_file() {
  local path=$1
  local expected_owner=$2
  local metadata owner mode
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat -c '%u:%a' -- "${path}")" || return 1
  IFS=: read -r owner mode <<<"${metadata}"
  [[ "${owner}" == "${expected_owner}" && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 022) == 0 ))
}

validate_secure_directory() {
  local path=$1
  local metadata owner mode
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat -c '%u:%a' -- "${path}")" || return 1
  IFS=: read -r owner mode <<<"${metadata}"
  [[ "${owner}" == '0' && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 022) == 0 ))
}

validate_secure_directory "${config_directory}" || \
  fail "${config_directory} must be a real root-owned directory that is not group- or world-writable"
validate_secure_directory "$(dirname -- "${source_config}")" || \
  fail 'versioned Docker config directory must be root-owned and not group- or world-writable'
validate_secure_regular_file "${source_config}" 0 || \
  fail 'versioned Docker daemon config must be a root-owned, non-writable regular file'

source_hash="$(sha256sum "${source_config}" | awk '{print $1}')" || \
  fail 'could not hash the versioned Docker daemon config'
[[ "${source_hash}" =~ ^[a-f0-9]{64}$ ]] || fail 'versioned Docker daemon config hash is invalid'
source_json="$(jq -ces '
  if length == 1 and (.[0] | type) == "object" then .[0]
  else error("expected exactly one JSON object")
  end
' -- "${source_config}")" || fail 'versioned Docker daemon config is invalid JSON'
validate_docker_daemon_config_values "${source_json}"
perimeter_dockerd_validate "${source_config}" >/dev/null || \
  fail 'dockerd rejected the versioned Docker daemon config'

version_at_least() {
  local actual=$1
  local minimum=$2
  local actual_major actual_minor actual_patch
  local minimum_major minimum_minor minimum_patch

  [[ "${actual}" =~ ^v?([0-9]+)\.([0-9]+)(\.([0-9]+))? ]] || return 2
  actual_major=${BASH_REMATCH[1]}
  actual_minor=${BASH_REMATCH[2]}
  actual_patch=${BASH_REMATCH[4]:-0}
  [[ "${minimum}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 2
  minimum_major=${BASH_REMATCH[1]}
  minimum_minor=${BASH_REMATCH[2]}
  minimum_patch=${BASH_REMATCH[3]}
  (( 10#${actual_major} > 10#${minimum_major} )) && return 0
  (( 10#${actual_major} < 10#${minimum_major} )) && return 1
  (( 10#${actual_minor} > 10#${minimum_minor} )) && return 0
  (( 10#${actual_minor} < 10#${minimum_minor} )) && return 1
  (( 10#${actual_patch} >= 10#${minimum_patch} ))
}

docker_bounded() {
  timeout --foreground --signal=TERM --kill-after=2s 10s \
    env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
      /usr/bin/docker \
        --config "${docker_cli_config_directory}" \
        --host unix:///run/docker.sock \
        "$@"
}

docker_engine_version() {
  docker_bounded version --format '{{.Server.Version}}'
}

assert_minimum_docker_engine() {
  local actual
  actual="$(docker_engine_version)" || return 1
  version_at_least "${actual}" "${minimum_docker_version}" || return 1
}

systemctl_bounded() {
  timeout --foreground --signal=TERM --kill-after=2s 5s systemctl "$@"
}

docker_unit_is_settled() {
  local jobs
  jobs="$(systemctl_bounded list-jobs --no-legend --plain docker.service)" || return 2
  [[ -z "${jobs}" ]]
}

wait_for_docker_unit_state() {
  local expected=$1
  local maximum_seconds=${2:-90}
  local active_state sub_state main_pid now deadline
  [[ "${expected}" == running || "${expected}" == stopped ]] || return 1
  [[ "${maximum_seconds}" =~ ^[0-9]+$ ]] && (( maximum_seconds >= 1 )) || return 1
  now="$(date +%s)" || return 1
  deadline=$((now + maximum_seconds))
  while (( now <= deadline )); do
    active_state="$(systemctl_bounded show --property ActiveState --value docker.service)" || return 1
    sub_state="$(systemctl_bounded show --property SubState --value docker.service)" || return 1
    main_pid="$(systemctl_bounded show --property MainPID --value docker.service)" || return 1
    if docker_unit_is_settled; then
      case "${expected}" in
        running)
          if [[ "${active_state}" == active && "${sub_state}" == running && \
            "${main_pid}" =~ ^[0-9]+$ ]] && (( main_pid > 1 )); then
            return 0
          fi
          ;;
        stopped)
          if [[ ( "${active_state}" == inactive || "${active_state}" == failed ) && \
            ( "${sub_state}" == dead || "${sub_state}" == failed ) && \
            "${main_pid}" == '0' ]]; then
            return 0
          fi
          ;;
      esac
    fi
    sleep 1
    now="$(date +%s)" || return 1
  done
  return 1
}

settle_failed_docker_transition() {
  systemctl_bounded stop --no-block docker.service || return 1
  wait_for_docker_unit_state stopped 30
}

settle_docker_for_recovery() {
  local settled_status=0
  docker_unit_is_settled || settled_status=$?
  if (( settled_status == 0 )); then
    docker_transition_settled=true
    return 0
  fi
  docker_transition_settled=false
  if settle_failed_docker_transition; then
    docker_transition_settled=true
    return 0
  fi
  return 1
}

restart_docker_service() {
  docker_transition_settled=false
  if ! systemctl_bounded restart --no-block docker.service; then
    if settle_failed_docker_transition; then
      docker_transition_settled=true
    fi
    return 1
  fi
  if wait_for_docker_unit_state running; then
    docker_transition_settled=true
    return 0
  fi
  if settle_failed_docker_transition; then
    docker_transition_settled=true
  fi
  return 1
}

assert_no_other_recovery_intents() {
  local path
  for path in \
    "${activation_intent_path}" "${activation_intent_path}.next" \
    "${rollback_intent_path}" "${rollback_intent_path}.next" \
    "${edge_recovery_marker}" "${edge_recovery_marker}.next"; do
    [[ ! -e "${path}" && ! -L "${path}" ]] || return 1
  done
}

capture_current_daemon() {
  local daemon_comm config_descriptor config_explicit config_path descriptor_remainder
  local daemon_pid_after argument

  current_daemon_pid="$(systemctl_bounded show --property MainPID --value docker.service)" || \
    fail 'could not resolve the running Docker daemon PID'
  [[ "${current_daemon_pid}" =~ ^[0-9]+$ ]] && (( current_daemon_pid > 1 )) || \
    fail 'Docker service has no valid main daemon PID'
  daemon_comm="$(tr -d '\n' <"/proc/${current_daemon_pid}/comm")" || \
    fail 'could not read the Docker daemon process name'
  [[ "${daemon_comm}" == dockerd ]] || fail 'docker.service MainPID is not dockerd'
  current_daemon_cmdline="$(tr '\0' '\n' <"/proc/${current_daemon_pid}/cmdline")" || \
    fail 'could not read the Docker daemon command line'
  current_daemon_environment="$(tr '\0' '\n' <"/proc/${current_daemon_pid}/environ")" || \
    fail 'could not read the Docker daemon environment'
  validate_docker_daemon_process_values \
    "${current_daemon_cmdline}" "${current_daemon_environment}"
  config_descriptor="$(docker_daemon_config_path_from_args \
    "${current_daemon_cmdline}")" || fail 'could not resolve Docker daemon config path'
  IFS=$'\t' read -r config_explicit config_path descriptor_remainder \
    <<<"${config_descriptor}"
  [[ ( "${config_explicit}" == true || "${config_explicit}" == false ) && \
    "${config_path}" == "${target_config}" && -z "${descriptor_remainder}" ]] || \
    fail "Docker daemon must use ${target_config} before automatic hardening"
  while IFS= read -r argument || [[ -n "${argument}" ]]; do
    case "${argument}" in
      --allow-direct-routing|--allow-direct-routing=*|--iptables|--iptables=*|--ip6tables|--ip6tables=*)
        fail 'Docker daemon CLI flags conflict with the versioned daemon config keys'
        ;;
    esac
  done <<<"${current_daemon_cmdline}"
  docker_socket_listener_for_pid "${current_daemon_pid}" >/dev/null
  daemon_pid_after="$(systemctl_bounded show --property MainPID --value docker.service)" || \
    fail 'could not re-resolve the Docker daemon PID'
  [[ "${daemon_pid_after}" == "${current_daemon_pid}" ]] || \
    fail 'Docker daemon restarted during installer inspection'
}

config_matches_source() {
  [[ -f "${target_config}" && ! -L "${target_config}" ]] || return 1
  [[ "$(stat -c '%u:%a' -- "${target_config}")" == '0:644' ]] || return 1
  cmp -s -- "${source_config}" "${target_config}"
}

read_current_release() {
  local current_link="${deploy_root}/current"
  local target current_release
  [[ -L "${current_link}" ]] || return 1
  target="$(readlink -- "${current_link}")" || return 1
  [[ "${target}" =~ ^releases/([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  current_release=${BASH_REMATCH[1]}
  [[ -d "${deploy_root}/${target}" && ! -L "${deploy_root}/${target}" ]] || return 1
  printf '%s\n' "${current_release}"
}

read_release_image_manifest() {
  local current_release=$1
  local manifest="${deploy_root}/state/images/${current_release}.sha256"
  local line_count web_line bot_line web_image bot_image extra=''
  [[ "${current_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  validate_secure_regular_file "${manifest}" 0 || return 1
  line_count="$(awk 'END { print NR + 0 }' "${manifest}")" || return 1
  [[ "${line_count}" == '2' ]] || return 1
  IFS= read -r web_line <"${manifest}" || return 1
  bot_line="$(sed -n '2p' "${manifest}")" || return 1
  IFS=' ' read -r _ web_image extra <<<"${web_line}"
  [[ "${web_line}" == "web ${web_image}" && "${web_image}" =~ ^sha256:[a-f0-9]{64}$ && \
    -z "${extra}" ]] || return 1
  IFS=' ' read -r _ bot_image extra <<<"${bot_line}"
  [[ "${bot_line}" == "bot ${bot_image}" && "${bot_image}" =~ ^sha256:[a-f0-9]{64}$ && \
    -z "${extra}" ]] || return 1
  printf '%s\t%s\n' "${web_image}" "${bot_image}"
}

inspect_current_service() {
  local current_release=$1
  local service=$2
  local expected_image=$3
  local container_ids container_count container_id inspection restart_count
  [[ "${current_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  [[ "${service}" == web || "${service}" == bot ]] || return 1
  [[ "${expected_image}" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  container_ids="$(docker_bounded ps --no-trunc \
    --filter 'label=com.docker.compose.project=cometa-bank' \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}')" || return 1
  container_count="$(awk 'NF { count += 1 } END { print count + 0 }' \
    <<<"${container_ids}")" || return 1
  [[ "${container_count}" == '1' ]] || return 1
  container_id="$(awk 'NF { print; exit }' <<<"${container_ids}")" || return 1
  [[ "${container_id}" =~ ^[a-f0-9]{64}$ ]] || return 1
  inspection="$(docker_bounded inspect "${container_id}")" || return 1
  jq -e \
    --arg id "${container_id}" \
    --arg service "${service}" \
    --arg release "${current_release}" \
    --arg expected_image "${expected_image}" '
      type == "array" and length == 1
      and .[0].Id == $id
      and .[0].Image == $expected_image
      and .[0].Config.Labels["com.docker.compose.project"] == "cometa-bank"
      and .[0].Config.Labels["com.docker.compose.service"] == $service
      and .[0].Config.Labels["org.opencontainers.image.version"] == $release
      and .[0].State.Running == true
      and .[0].State.Status == "running"
      and .[0].State.Paused == false
      and .[0].State.Restarting == false
      and .[0].State.Dead == false
      and .[0].State.Health.Status == "healthy"
      and (.[0].RestartCount | type == "number" and . >= 0 and floor == .)
      and (.[0].HostConfig.NetworkMode as $network_mode |
      if $service == "web" then
        .[0].HostConfig.PortBindings == {
          "8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}],
          "8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]
        }
        and (.[0].NetworkSettings.Networks | keys | sort)
          == ["cometa-bank_edge", "cometa-bank_public"]
        and (["cometa-bank_edge", "cometa-bank_public"] | index($network_mode)) != null
      else
        ((.[0].HostConfig.PortBindings // {}) | length) == 0
        and (.[0].NetworkSettings.Networks | keys | sort)
          == ["cometa-bank_edge", "cometa-bank_egress"]
        and (["cometa-bank_edge", "cometa-bank_egress"] | index($network_mode)) != null
      end)
    ' <<<"${inspection}" >/dev/null || return 1
  restart_count="$(jq -er '.[0].RestartCount | tostring' <<<"${inspection}")" || return 1
  [[ "${restart_count}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\t%s\n' "${container_id}" "${restart_count}"
}

capture_current_application() {
  local service_record image_record web_image bot_image remainder=''
  marker_current_release="$(read_current_release)" || return 1
  image_record="$(read_release_image_manifest "${marker_current_release}")" || return 1
  IFS=$'\t' read -r web_image bot_image remainder <<<"${image_record}"
  [[ "${web_image}" =~ ^sha256:[a-f0-9]{64}$ && \
    "${bot_image}" =~ ^sha256:[a-f0-9]{64}$ && -z "${remainder}" ]] || return 1
  service_record="$(inspect_current_service \
    "${marker_current_release}" web "${web_image}")" || return 1
  IFS=$'\t' read -r marker_web_container marker_web_restart_count remainder \
    <<<"${service_record}"
  [[ -n "${marker_web_container}" && -n "${marker_web_restart_count}" && \
    -z "${remainder}" ]] || return 1
  service_record="$(inspect_current_service \
    "${marker_current_release}" bot "${bot_image}")" || return 1
  IFS=$'\t' read -r marker_bot_container marker_bot_restart_count remainder \
    <<<"${service_record}"
  [[ -n "${marker_bot_container}" && -n "${marker_bot_restart_count}" && \
    -z "${remainder}" ]] || return 1
}

verify_network_object() {
  local network_name=$1
  local logical_name=$2
  local internal=$3
  local expected_icc=$4
  local network_names network_count network_json
  [[ "${network_name}" == "cometa-bank_${logical_name}" ]] || return 1
  [[ "${logical_name}" == edge || "${logical_name}" == egress || \
    "${logical_name}" == public ]] || return 1
  [[ "${internal}" == true || "${internal}" == false ]] || return 1
  [[ "${expected_icc}" == true || "${expected_icc}" == false ]] || return 1
  network_names="$(docker_bounded network ls --format '{{.Name}}')" || return 1
  network_count="$(awk -v expected="${network_name}" \
    '$0 == expected { count += 1 } END { print count + 0 }' <<<"${network_names}")" || return 1
  [[ "${network_count}" == '1' ]] || return 1
  network_json="$(docker_bounded network inspect --format '{{json .}}' "${network_name}")" || return 1
  jq -e \
    --arg network_name "${network_name}" \
    --arg logical_name "${logical_name}" \
    --arg expected_icc "${expected_icc}" \
    --argjson internal "${internal}" '
      .Name == $network_name
      and .Driver == "bridge"
      and .Scope == "local"
      and .Internal == $internal
      and ((.Ingress // false) == false)
      and ((.Attachable // false) == false)
      and ((.ConfigOnly // false) == false)
      and ((.ConfigFrom.Network // "") == "")
      and .EnableIPv4 == true
      and .EnableIPv6 == false
      and .IPAM.Driver == "default"
      and ((.IPAM.Options // {}) == {})
      and (.IPAM.Config | type == "array" and length == 1)
      and (.IPAM.Config[0] | keys | sort) == ["Gateway", "Subnet"]
      and (.IPAM.Config[0].Subnet | test(
        "^(10([.][0-9]{1,3}){3}/(8|9|[12][0-9]|3[0-2])"
        + "|172[.](1[6-9]|2[0-9]|3[01])([.][0-9]{1,3}){2}/(1[2-9]|2[0-9]|3[0-2])"
        + "|192[.]168([.][0-9]{1,3}){2}/(1[6-9]|2[0-9]|3[0-2]))$"
      ))
      and (.IPAM.Config[0].Gateway | test("^(10[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|192[.]168[.])"))
      and .Labels["com.docker.compose.project"] == "cometa-bank"
      and .Labels["com.docker.compose.network"] == $logical_name
      and .Options == {"com.docker.network.bridge.enable_icc": $expected_icc}
    ' <<<"${network_json}" >/dev/null
}

verify_current_network_objects() {
  verify_network_object cometa-bank_edge edge true true || return 1
  verify_network_object cometa-bank_egress egress false false || return 1
  verify_network_object cometa-bank_public public false false
}

read_recovery_marker_path() {
  local marker_path=$1
  local release_line hash_line current_line web_line bot_line original_line phase_line extra_line=''
  local parsed_current parsed_web parsed_web_restarts parsed_bot parsed_bot_restarts parsed_phase
  [[ "${marker_path}" == "${recovery_marker}" || \
    "${marker_path}" == "${recovery_marker_next}" ]] || return 1
  [[ -f "${marker_path}" && ! -L "${marker_path}" ]] || return 1
  [[ "$(stat -c '%u:%a' -- "${marker_path}")" == '0:600' ]] || return 1
  [[ "$(awk 'END { print NR + 0 }' "${marker_path}")" == '7' ]] || return 1
  IFS= read -r release_line <"${marker_path}" || return 1
  hash_line="$(sed -n '2p' "${marker_path}")" || return 1
  current_line="$(sed -n '3p' "${marker_path}")" || return 1
  web_line="$(sed -n '4p' "${marker_path}")" || return 1
  bot_line="$(sed -n '5p' "${marker_path}")" || return 1
  original_line="$(sed -n '6p' "${marker_path}")" || return 1
  phase_line="$(sed -n '7p' "${marker_path}")" || return 1
  extra_line="$(sed -n '8p' "${marker_path}")" || return 1
  [[ "${release_line}" == "operator ${release_id}" && \
    "${hash_line}" == "source-sha256 ${source_hash}" && \
    "${original_line}" == 'original absent' && -z "${extra_line}" ]] || return 1
  [[ "${current_line}" =~ ^original-current[[:space:]]([0-9]{8}T[0-9]{6}Z)$ ]] || return 1
  parsed_current=${BASH_REMATCH[1]}
  [[ "${web_line}" =~ ^web-container[[:space:]]([a-f0-9]{64})[[:space:]]restart-count[[:space:]]([0-9]+)$ ]] || return 1
  parsed_web=${BASH_REMATCH[1]}
  parsed_web_restarts=${BASH_REMATCH[2]}
  [[ "${bot_line}" =~ ^bot-container[[:space:]]([a-f0-9]{64})[[:space:]]restart-count[[:space:]]([0-9]+)$ ]] || return 1
  parsed_bot=${BASH_REMATCH[1]}
  parsed_bot_restarts=${BASH_REMATCH[2]}
  [[ "${phase_line}" =~ ^phase[[:space:]](install|rollback)$ ]] || return 1
  parsed_phase=${BASH_REMATCH[1]}
  [[ -d "${deploy_root}/releases/${parsed_current}" && \
    ! -L "${deploy_root}/releases/${parsed_current}" ]] || return 1
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${parsed_phase}" "${parsed_current}" "${parsed_web}" "${parsed_web_restarts}" \
    "${parsed_bot}" "${parsed_bot_restarts}"
}

set_marker_record() {
  local record=$1
  local remainder=''
  IFS=$'\t' read -r marker_phase marker_current_release marker_web_container \
    marker_web_restart_count marker_bot_container marker_bot_restart_count remainder <<<"${record}"
  [[ ( "${marker_phase}" == install || "${marker_phase}" == rollback ) && \
    "${marker_current_release}" =~ ^[0-9]{8}T[0-9]{6}Z$ && \
    "${marker_web_container}" =~ ^[a-f0-9]{64}$ && \
    "${marker_web_restart_count}" =~ ^[0-9]+$ && \
    "${marker_bot_container}" =~ ^[a-f0-9]{64}$ && \
    "${marker_bot_restart_count}" =~ ^[0-9]+$ && -z "${remainder}" ]]
}

marker_record_matches_transaction() {
  local record=$1
  local expected_phase=$2
  local actual_phase actual_current actual_web actual_web_restarts actual_bot actual_bot_restarts extra=''
  IFS=$'\t' read -r actual_phase actual_current actual_web actual_web_restarts \
    actual_bot actual_bot_restarts extra <<<"${record}"
  [[ "${actual_phase}" == "${expected_phase}" && \
    "${actual_current}" == "${marker_current_release}" && \
    "${actual_web}" == "${marker_web_container}" && \
    "${actual_web_restarts}" == "${marker_web_restart_count}" && \
    "${actual_bot}" == "${marker_bot_container}" && \
    "${actual_bot_restarts}" == "${marker_bot_restart_count}" && -z "${extra}" ]]
}

load_recovery_marker() {
  local main_record='' next_record=''
  local main_phase next_phase
  local next_is_valid=false
  local load_status=10
  if [[ -e "${recovery_marker}" || -L "${recovery_marker}" ]]; then
    main_record="$(read_recovery_marker_path "${recovery_marker}")" || return 1
    set_marker_record "${main_record}" || return 1
    main_phase=${marker_phase}
    load_status=0
  fi
  if [[ -e "${recovery_marker_next}" || -L "${recovery_marker_next}" ]]; then
    if next_record="$(read_recovery_marker_path "${recovery_marker_next}")"; then
      next_is_valid=true
    else
      [[ -f "${recovery_marker_next}" && ! -L "${recovery_marker_next}" && \
        "$(stat -c '%u:%a' -- "${recovery_marker_next}")" == '0:600' ]] || return 1
      if (( load_status == 0 )); then
        if [[ "${apply:-false}" == true ]]; then
          unlink -- "${recovery_marker_next}" || return 1
          sync -f "${config_directory}" || return 1
        fi
        return 0
      fi
      [[ ! -e "${target_config}" && ! -L "${target_config}" ]] || return 1
      if [[ "${apply:-false}" == true ]]; then
        unlink -- "${recovery_marker_next}" || return 1
        sync -f "${config_directory}" || return 1
        return 10
      fi
      return 11
    fi
    [[ "${next_is_valid}" == true ]] || return 1
    if (( load_status == 10 )); then
      set_marker_record "${next_record}" || return 1
      mv -fT -- "${recovery_marker_next}" "${recovery_marker}" || return 1
      sync -f "${config_directory}" || return 1
      return 0
    fi
    next_phase=${next_record%%$'\t'*}
    marker_record_matches_transaction "${next_record}" "${next_phase}" || return 1
    case "${main_phase}:${next_phase}" in
      install:rollback)
        mv -fT -- "${recovery_marker_next}" "${recovery_marker}" || return 1
        sync -f "${config_directory}" || return 1
        set_marker_record "${next_record}" || return 1
        ;;
      install:install|rollback:rollback)
        unlink -- "${recovery_marker_next}" || return 1
        sync -f "${config_directory}" || return 1
        ;;
      *) return 1 ;;
    esac
  fi
  return "${load_status}"
}

persist_recovery_phase() {
  local desired_phase=$1
  local candidate_record
  [[ "${desired_phase}" == install || "${desired_phase}" == rollback ]] || return 1
  if [[ -e "${recovery_marker_next}" || -L "${recovery_marker_next}" ]]; then
    candidate_record="$(read_recovery_marker_path "${recovery_marker_next}")" || return 1
    marker_record_matches_transaction "${candidate_record}" "${desired_phase}" || return 1
  else
    printf 'operator %s\nsource-sha256 %s\noriginal-current %s\nweb-container %s restart-count %s\nbot-container %s restart-count %s\noriginal absent\nphase %s\n' \
      "${release_id}" "${source_hash}" "${marker_current_release}" \
      "${marker_web_container}" "${marker_web_restart_count}" \
      "${marker_bot_container}" "${marker_bot_restart_count}" "${desired_phase}" \
      >"${recovery_marker_next}" || return 1
    chmod 0600 "${recovery_marker_next}" || return 1
    chown root:root "${recovery_marker_next}" || return 1
    sync -f "${recovery_marker_next}" || return 1
  fi
  mv -fT -- "${recovery_marker_next}" "${recovery_marker}" || return 1
  sync -f "${config_directory}" || return 1
  marker_phase=${desired_phase}
}

arm_recovery_marker() {
  [[ ! -e "${recovery_marker}" && ! -L "${recovery_marker}" ]] || return 1
  persist_recovery_phase install
}

retire_recovery_marker() {
  local record
  record="$(read_recovery_marker_path "${recovery_marker}")" || return 1
  marker_record_matches_transaction "${record}" "${marker_phase}" || return 1
  [[ ! -e "${recovery_marker_next}" && ! -L "${recovery_marker_next}" ]] || return 1
  unlink -- "${recovery_marker}" || return 1
  sync -f "${config_directory}"
}

staged_config_matches_source() {
  [[ -f "${target_config_next}" && ! -L "${target_config_next}" ]] || return 1
  [[ "$(stat -c '%u:%a' -- "${target_config_next}")" == '0:644' ]] || return 1
  cmp -s -- "${source_config}" "${target_config_next}" || return 1
  perimeter_dockerd_validate "${target_config_next}" >/dev/null
}

staged_config_is_discardable() {
  local metadata owner mode
  [[ -f "${target_config_next}" && ! -L "${target_config_next}" ]] || return 1
  metadata="$(stat -c '%u:%a' -- "${target_config_next}")" || return 1
  IFS=: read -r owner mode <<<"${metadata}"
  [[ "${owner}" == '0' && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 022) == 0 ))
}

reconcile_staged_config() {
  if [[ ! -e "${target_config_next}" && ! -L "${target_config_next}" ]]; then
    return 0
  fi
  if ! staged_config_matches_source; then
    [[ -e "${recovery_marker}" && ! -L "${recovery_marker}" ]] || return 1
    read_recovery_marker_path "${recovery_marker}" >/dev/null || return 1
    staged_config_is_discardable || return 1
    unlink -- "${target_config_next}" || return 1
    sync -f "${config_directory}" || return 1
    return 0
  fi
  if [[ -e "${target_config}" || -L "${target_config}" ]]; then
    config_matches_source || return 1
    unlink -- "${target_config_next}" || return 1
  else
    mv -fT -- "${target_config_next}" "${target_config}" || return 1
  fi
  sync -f "${config_directory}"
}

wait_until_config_predates_restart() {
  local attempt now config_times config_mtime config_ctime remainder=''
  config_times="$(stat -c '%Y:%Z' -- "${target_config}")" || return 1
  IFS=: read -r config_mtime config_ctime remainder <<<"${config_times}"
  [[ "${config_mtime}" =~ ^[0-9]+$ && "${config_ctime}" =~ ^[0-9]+$ && \
    -z "${remainder}" ]] || return 1
  for attempt in 1 2 3; do
    now="$(date +%s)" || return 1
    [[ "${now}" =~ ^[0-9]+$ ]] || return 1
    if config_timestamps_precede_restart \
      "${config_mtime}" "${config_ctime}" "${now}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

config_timestamps_precede_restart() {
  local config_mtime=$1
  local config_ctime=$2
  local restart_epoch=$3
  [[ "${config_mtime}" =~ ^[0-9]+$ && "${config_ctime}" =~ ^[0-9]+$ && \
    "${restart_epoch}" =~ ^[0-9]+$ ]] || return 1
  (( config_mtime < restart_epoch && config_ctime < restart_epoch ))
}

wait_for_docker() {
  local attempt
  for (( attempt = 1; attempt <= 30; attempt += 1 )); do
    if timeout --foreground --signal=TERM --kill-after=2s 5s \
      systemctl is-active --quiet docker.service && \
      [[ -S /run/docker.sock && ! -L /run/docker.sock ]] && \
      docker_engine_version >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_and_verify_safe_config() {
  wait_until_config_predates_restart || return 1
  restart_docker_service || return 1
  wait_for_docker || return 1
  verify_safe_runtime_stable
}

verify_safe_runtime_stable() {
  local daemon_pid_before_health
  assert_docker_cli_local_contract
  assert_minimum_docker_engine || return 1
  check_docker_daemon_perimeter_contract
  capture_current_daemon
  daemon_pid_before_health=${current_daemon_pid}
  verify_current_application_recovered || return 1
  check_docker_daemon_perimeter_contract || return 1
  capture_current_daemon
  [[ "${current_daemon_pid}" == "${daemon_pid_before_health}" ]]
}

verify_application_boundaries() {
  local quick_check
  [[ -f "${live_database_path}" && ! -L "${live_database_path}" ]] || return 1
  quick_check="$(timeout --foreground --signal=TERM --kill-after=2s 10s \
    sqlite3 -batch -noheader "${live_database_path}" 'PRAGMA quick_check;')" || return 1
  [[ "${quick_check}" == ok ]] || return 1
  curl --disable --fail --silent --show-error --noproxy '*' \
    --connect-timeout 5 --max-time 15 --proto '=https' --tlsv1.2 \
    --resolve 'euphoria.bot:8443:127.0.0.1' \
    'https://euphoria.bot:8443/healthz' >/dev/null || return 1
  curl --disable --fail --silent --show-error --noproxy '*' \
    --connect-timeout 5 --max-time 15 --proto '=https' --tlsv1.2 \
    --resolve 'euphoria.bot:443:127.0.0.1' \
    'https://euphoria.bot:443/healthz' >/dev/null
}

marker_application_is_healthy() {
  local actual_current image_record web_image bot_image web_record bot_record remainder=''
  actual_current="$(read_current_release)" || return 1
  [[ "${actual_current}" == "${marker_current_release}" ]] || return 1
  image_record="$(read_release_image_manifest "${actual_current}")" || return 1
  IFS=$'\t' read -r web_image bot_image remainder <<<"${image_record}"
  [[ "${web_image}" =~ ^sha256:[a-f0-9]{64}$ && \
    "${bot_image}" =~ ^sha256:[a-f0-9]{64}$ && -z "${remainder}" ]] || return 1
  web_record="$(inspect_current_service "${actual_current}" web "${web_image}")" || return 1
  bot_record="$(inspect_current_service "${actual_current}" bot "${bot_image}")" || return 1
  [[ "${web_record}" == "${marker_web_container}"$'\t'"${marker_web_restart_count}" && \
    "${bot_record}" == "${marker_bot_container}"$'\t'"${marker_bot_restart_count}" ]]
}

verify_current_application_recovered() {
  local attempt healthy_since=0 now
  verify_current_network_objects || return 1
  for (( attempt = 1; attempt <= health_attempts; attempt += 1 )); do
    if marker_application_is_healthy; then
      now="$(date +%s)" || return 1
      [[ "${now}" =~ ^[0-9]+$ ]] || return 1
      if (( healthy_since == 0 )); then
        healthy_since=${now}
      fi
      if (( now - healthy_since >= health_stability_seconds )); then
        verify_application_boundaries || return 1
        verify_current_network_objects
        return
      fi
    else
      healthy_since=0
    fi
    sleep 2
  done
  return 1
}

install_source_config() {
  reconcile_staged_config || return 1
  if [[ ! -e "${target_config}" && ! -L "${target_config}" ]]; then
    [[ ! -e "${target_config_next}" && ! -L "${target_config_next}" ]] || return 1
    install -m 0644 -o root -g root -- "${source_config}" "${target_config_next}" || return 1
    perimeter_dockerd_validate "${target_config_next}" >/dev/null || return 1
    sync -f "${target_config_next}" || return 1
    mv -fT -- "${target_config_next}" "${target_config}" || return 1
    sync -f "${config_directory}" || return 1
  fi
  config_matches_source
}

restore_absent_config() {
  local daemon_pid_before_health
  [[ "${marker_phase}" == install || "${marker_phase}" == rollback ]] || return 1
  [[ "${docker_transition_settled}" == true ]] || return 1
  persist_recovery_phase rollback || return 1
  if [[ -e "${target_config_next}" || -L "${target_config_next}" ]]; then
    if ! staged_config_matches_source; then
      staged_config_is_discardable || return 1
    fi
    unlink -- "${target_config_next}" || return 1
    sync -f "${config_directory}" || return 1
  fi
  if [[ -e "${target_config}" || -L "${target_config}" ]]; then
    config_matches_source || return 1
    unlink -- "${target_config}" || return 1
    sync -f "${config_directory}" || return 1
  fi
  restart_docker_service || return 1
  wait_for_docker || return 1
  assert_docker_cli_local_contract
  assert_minimum_docker_engine || return 1
  capture_current_daemon
  daemon_pid_before_health=${current_daemon_pid}
  [[ ! -e "${target_config}" && ! -L "${target_config}" ]] || return 1
  verify_current_application_recovered || return 1
  assert_docker_cli_local_contract || return 1
  assert_minimum_docker_engine || return 1
  capture_current_daemon
  [[ "${current_daemon_pid}" == "${daemon_pid_before_health}" ]] || return 1
  [[ ! -e "${target_config}" && ! -L "${target_config}" ]] || return 1
  retire_recovery_marker
}

docker_runtime_is_available() {
  timeout --foreground --signal=TERM --kill-after=2s 5s \
    systemctl is-active --quiet docker.service && \
    [[ -S /run/docker.sock && ! -L /run/docker.sock ]] && \
    docker_engine_version >/dev/null 2>&1
}

recover_armed_perimeter() {
  local actual_current
  actual_current="$(read_current_release)" || return 1
  [[ "${actual_current}" == "${marker_current_release}" ]] || return 1
  assert_no_other_recovery_intents || return 1
  settle_docker_for_recovery || return 1
  case "${marker_phase}" in
    install)
      if config_matches_source && docker_runtime_is_available && \
        verify_safe_runtime_stable; then
        retire_recovery_marker || return 1
        log 'Docker daemon perimeter recovery completed from an already-safe runtime'
        return 0
      fi
      install_source_config || return 1
      if restart_and_verify_safe_config; then
        retire_recovery_marker || return 1
        log 'Docker daemon perimeter recovered and installed'
        return 0
      fi
      log 'safe Docker recovery failed; entering durable rollback phase'
      if restore_absent_config; then
        return 2
      fi
      return 1
      ;;
    rollback)
      if restore_absent_config; then
        return 2
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

recovery_status=0
assert_no_other_recovery_intents || fail 'another Cometa recovery transaction is pending'
load_recovery_marker || recovery_status=$?
if (( recovery_status == 0 )); then
  [[ "${apply}" == true ]] || {
    printf '%s\n' \
      "Docker perimeter recovery is armed in phase ${marker_phase}." \
      'Rerun with: install-docker-perimeter.sh --apply'
    exit 0
  }
  recovery_result=0
  recover_armed_perimeter || recovery_result=$?
  case "${recovery_result}" in
    0) exit 0 ;;
    2) fail 'Docker perimeter recovery restored the original absent config and recovered the current application' ;;
    *) fail "Docker perimeter recovery is incomplete; preserve ${recovery_marker} and repair Docker manually" ;;
  esac
elif (( recovery_status == 11 )); then
  printf '%s\n' \
    'An uncommitted Docker perimeter journal candidate needs cleanup.' \
    'Rerun with: install-docker-perimeter.sh --apply'
  exit 0
elif (( recovery_status != 10 )); then
  fail 'Docker perimeter recovery journal is unreadable or unsafe'
fi

[[ ! -e "${target_config_next}" && ! -L "${target_config_next}" ]] || \
  fail 'staged Docker daemon config has no recovery journal'
assert_no_other_recovery_intents || fail 'another Cometa recovery transaction is pending'
docker_unit_is_settled || fail 'docker.service has an active or unreadable systemd job'
docker_runtime_is_available || fail 'Docker is unavailable without a valid perimeter recovery journal'
assert_docker_cli_local_contract
assert_minimum_docker_engine || \
  fail "Docker Engine ${minimum_docker_version} or newer is required"
capture_current_daemon
verify_current_network_objects || fail 'current Cometa Docker networks are not exact isolated bridges'
capture_current_application || fail 'current Cometa web and bot must be singular and healthy'
verify_application_boundaries || fail 'current Cometa database or HTTPS boundary is unhealthy'

if config_matches_source && (check_docker_daemon_perimeter_contract) >/dev/null 2>&1; then
  printf 'Docker daemon perimeter is already installed and bound to the running PID.\n'
  exit 0
fi

if [[ -e "${target_config}" || -L "${target_config}" ]]; then
  config_matches_source || fail "refusing to replace existing ${target_config}; review it manually"
  fail 'versioned daemon config is not bound to the current daemon and has no recovery journal'
fi

if [[ "${apply}" != true ]]; then
  printf '%s\n' \
    'Docker perimeter install plan:' \
    "- atomically install the exact versioned config at ${target_config}" \
    '- journal the current release plus exact web and bot container identities' \
    '- restart only docker.service with a bounded deadline after the config timestamp barrier' \
    '- require Docker 28+, 31 stable app-health seconds, SQLite quick_check, and both HTTPS boundaries' \
    '- bind /run/docker.sock back to that exact dockerd PID and retire the recovery journal' \
    'Rerun with: install-docker-perimeter.sh --apply'
  exit 0
fi

arm_recovery_marker || fail 'could not arm Docker perimeter recovery marker'
install_source_config || fail 'could not commit the versioned Docker daemon config'

restart_result=0
restart_and_verify_safe_config || restart_result=$?
if (( restart_result != 0 )); then
  log 'safe Docker restart failed; restoring the original absent config'
  [[ "${docker_transition_settled}" == true ]] || \
    fail "Docker transition did not settle; preserve ${recovery_marker} and ${target_config}"
  restore_result=0
  restore_absent_config || restore_result=$?
  if (( restore_result == 0 )); then
    fail 'Docker perimeter install failed; original daemon defaults were restored'
  fi
  fail "Docker perimeter recovery is incomplete; preserve ${recovery_marker} and repair Docker manually"
fi
retire_recovery_marker || \
  fail "safe Docker daemon is live but recovery marker remains at ${recovery_marker}"
log 'Docker daemon perimeter install complete'
