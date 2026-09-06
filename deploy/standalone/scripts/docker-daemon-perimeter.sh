# Shared, read-only Docker daemon perimeter checks for host and release gates.

docker_cli_config_candidate="$(dirname -- "${BASH_SOURCE[0]}")/../docker-cli"
[[ -d "${docker_cli_config_candidate}" && ! -L "${docker_cli_config_candidate}" ]] || \
  fail 'versioned Docker CLI config directory is missing or symlinked'
docker_cli_config_directory="$(cd -- "${docker_cli_config_candidate}" && pwd -P)"
readonly docker_cli_config_directory
unset docker_cli_config_candidate
readonly docker_perimeter_recovery_marker='/etc/docker/.cometa-bank-perimeter.pending'
readonly docker_perimeter_recovery_marker_next='/etc/docker/.cometa-bank-perimeter.pending.next'
readonly docker_perimeter_config_next='/etc/docker/daemon.json.cometa-bank.next'

perimeter_systemctl() {
  timeout --foreground --signal=TERM --kill-after=2s 8s systemctl "$@"
}

perimeter_ss() {
  timeout --foreground --signal=TERM --kill-after=2s 8s ss "$@"
}

perimeter_dockerd_validate() {
  timeout --foreground --signal=TERM --kill-after=2s 8s \
    dockerd --validate --config-file="$1"
}

docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
    /usr/bin/docker \
      --config "${docker_cli_config_directory}" \
      --host unix:///run/docker.sock \
      "$@"
}

validate_docker_cli_config() {
  local config_json=$1
  jq -e 'type == "object" and length == 0' <<<"${config_json}" >/dev/null || \
    fail 'versioned Docker CLI config must be an empty JSON object with no currentContext'
}

validate_docker_socket_metadata() {
  local metadata=$1
  local socket_gid socket_group socket_mode
  [[ "${metadata}" =~ ^0:([0-9]+):(root|docker):([0-7]{3,4})$ ]] || \
    fail 'pinned local Docker Unix socket must be owned by root and the root or docker group'
  socket_gid=${BASH_REMATCH[1]}
  socket_group=${BASH_REMATCH[2]}
  socket_mode=${BASH_REMATCH[3]}
  if [[ "${socket_group}" == root ]]; then
    [[ "${socket_gid}" == '0' ]] || fail 'Docker socket root group has an unexpected numeric GID'
  else
    [[ "${socket_gid}" != '0' ]] || fail 'Docker socket docker group has an unexpected numeric GID'
  fi
  [[ "${socket_mode}" == '600' || "${socket_mode}" == '0600' || \
    "${socket_mode}" == '660' || "${socket_mode}" == '0660' ]] || \
    fail 'Docker socket permissions must be exactly 0600 or 0660'
}

validate_docker_config_start_binding() {
  local config_mtime=$1
  local config_ctime=$2
  local daemon_started_epoch=$3
  [[ "${config_mtime}" =~ ^[0-9]+$ && "${config_ctime}" =~ ^[0-9]+$ && \
    "${daemon_started_epoch}" =~ ^[0-9]+$ ]] || \
    fail 'Docker daemon config or process timestamps are invalid'
  (( config_mtime < daemon_started_epoch && config_ctime < daemon_started_epoch )) || \
    fail 'Docker daemon config changed after the running daemon started; restart Docker before release work'
}

validate_docker_socket_listener() {
  local listener_line=$1
  local daemon_pid=$2
  local line_prefix owner_order_one owner_order_two
  [[ "${daemon_pid}" =~ ^[0-9]+$ ]] && (( daemon_pid > 1 )) || \
    fail 'Docker socket listener daemon PID is invalid'
  line_prefix='^u_str[[:space:]]+LISTEN[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+/run/docker[.]sock[[:space:]]+[0-9]+[[:space:]]+[*][[:space:]]+[0-9]+[[:space:]]+'
  owner_order_one="users:\(\(\"dockerd\",pid=${daemon_pid},fd=[0-9]+\),\(\"systemd\",pid=1,fd=[0-9]+\)\)[[:blank:]]*$"
  owner_order_two="users:\(\(\"systemd\",pid=1,fd=[0-9]+\),\(\"dockerd\",pid=${daemon_pid},fd=[0-9]+\)\)[[:blank:]]*$"
  [[ "${listener_line}" =~ ${line_prefix}${owner_order_one} || \
    "${listener_line}" =~ ${line_prefix}${owner_order_two} ]] || \
    fail 'pinned Docker socket is not owned exclusively by docker.service and systemd socket activation'
}

docker_socket_listener_for_pid() {
  local daemon_pid=$1
  local listeners matching_listeners listener_count listener_line
  local socket_active socket_enabled socket_listen pid_one_comm

  socket_active="$(perimeter_systemctl show --property ActiveState --value docker.socket)" || \
    fail 'could not inspect docker.socket state'
  [[ "${socket_active}" == 'active' ]] || fail 'docker.socket must be active'
  socket_enabled="$(perimeter_systemctl is-enabled docker.socket 2>/dev/null)" || \
    fail 'could not inspect docker.socket enablement'
  [[ "${socket_enabled}" == 'enabled' ]] || fail 'docker.socket must be enabled'
  socket_listen="$(perimeter_systemctl show --property Listen --value docker.socket)" || \
    fail 'could not inspect docker.socket listener path'
  [[ "${socket_listen}" == '/run/docker.sock (Stream)' ]] || \
    fail 'docker.socket must listen only on /run/docker.sock'
  pid_one_comm="$(tr -d '\n' </proc/1/comm)" || fail 'could not inspect PID 1'
  [[ "${pid_one_comm}" == systemd ]] || fail 'docker.socket owner PID 1 is not systemd'

  listeners="$(perimeter_ss -H -lxnp)" || fail 'could not inspect local Unix listeners'
  matching_listeners="$(awk '
    $1 == "u_str" && $2 == "LISTEN" {
      for (field = 1; field <= NF; field += 1) {
        if ($field == "/run/docker.sock") print
      }
    }
  ' <<<"${listeners}")" || fail 'could not parse local Unix listeners'
  listener_count="$(awk 'NF { count += 1 } END { print count + 0 }' \
    <<<"${matching_listeners}")" || fail 'could not count Docker socket listeners'
  [[ "${listener_count}" == '1' ]] || \
    fail "expected exactly one /run/docker.sock listener; found ${listener_count}"
  listener_line="$(awk 'NF { print; exit }' <<<"${matching_listeners}")" || \
    fail 'could not read the Docker socket listener'
  validate_docker_socket_listener "${listener_line}" "${daemon_pid}"
  printf '%s\n' "${listener_line}"
}

assert_no_docker_cli_target_overrides() {
  [[ -z "${DOCKER_HOST+x}" ]] || fail 'Docker CLI target override is forbidden: DOCKER_HOST'
  [[ -z "${DOCKER_CONTEXT+x}" ]] || fail 'Docker CLI target override is forbidden: DOCKER_CONTEXT'
  [[ -z "${DOCKER_CONFIG+x}" ]] || fail 'Docker CLI target override is forbidden: DOCKER_CONFIG'
}

assert_no_pending_docker_perimeter_recovery() {
  [[ ! -e "${docker_perimeter_recovery_marker}" && \
    ! -L "${docker_perimeter_recovery_marker}" && \
    ! -e "${docker_perimeter_recovery_marker_next}" && \
    ! -L "${docker_perimeter_recovery_marker_next}" && \
    ! -e "${docker_perimeter_config_next}" && \
    ! -L "${docker_perimeter_config_next}" ]] || \
    fail 'Docker perimeter recovery or a staged candidate is pending under /etc/docker'
}

assert_docker_cli_local_contract() {
  local socket_metadata socket_gid socket_group group_record
  local group_name group_password group_gid group_members group_remainder primary_gid_count
  local config_metadata config_json
  local config_path="${docker_cli_config_directory}/config.json"

  assert_no_docker_cli_target_overrides
  [[ -x /usr/bin/docker ]] || fail 'pinned local Docker CLI is unavailable at /usr/bin/docker'
  [[ -S /run/docker.sock && ! -L /run/docker.sock ]] || \
    fail 'pinned local Docker Unix socket is missing or symlinked'
  socket_metadata="$(stat -c '%u:%g:%G:%a' -- /run/docker.sock)" || \
    fail 'could not inspect the pinned local Docker Unix socket'
  validate_docker_socket_metadata "${socket_metadata}"
  IFS=: read -r _ socket_gid socket_group _ <<<"${socket_metadata}"
  if [[ "${socket_group}" == docker ]]; then
    group_record="$(getent group "${socket_gid}")" || \
      fail 'could not resolve the Docker socket group'
    IFS=: read -r group_name group_password group_gid group_members group_remainder \
      <<<"${group_record}"
    [[ "${group_name}" == docker && "${group_gid}" == "${socket_gid}" && \
      -z "${group_members}" && -z "${group_remainder}" ]] || \
      fail 'Docker socket group must have no supplemental members'
    primary_gid_count="$(awk -F: -v expected_gid="${socket_gid}" '
      $4 == expected_gid && $3 != 0 { count += 1 }
      END { print count + 0 }
    ' /etc/passwd)" || fail 'could not audit Docker socket primary-group membership'
    [[ "${primary_gid_count}" == '0' ]] || \
      fail 'Docker socket group must have no non-root primary members'
  fi
  [[ -f "${config_path}" && ! -L "${config_path}" ]] || \
    fail 'versioned Docker CLI config is missing or symlinked'
  config_metadata="$(stat -c '%u:%a' -- "${config_path}")" || \
    fail 'could not inspect versioned Docker CLI config metadata'
  [[ "${config_metadata}" =~ ^0:([0-7]{3,4})$ ]] || \
    fail 'versioned Docker CLI config must be owned by root'
  (( (8#${BASH_REMATCH[1]} & 022) == 0 )) || \
    fail 'versioned Docker CLI config must not be group- or world-writable'
  config_json="$(jq -ces '
    if length == 1 and (.[0] | type) == "object" then .[0]
    else error("expected exactly one JSON object")
    end
  ' -- "${config_path}")" || \
    fail 'versioned Docker CLI config must contain exactly one JSON object'
  validate_docker_cli_config "${config_json}"
}

docker_daemon_config_path_from_args() {
  local cmdline_text=$1
  local argument config_path=''
  local explicit=false
  local expecting_path=false
  local config_argument_count=0

  [[ -n "${cmdline_text}" ]] || fail 'Docker daemon command line is empty'
  while IFS= read -r argument || [[ -n "${argument}" ]]; do
    if [[ "${expecting_path}" == true ]]; then
      [[ -n "${argument}" ]] || fail 'Docker daemon --config-file has an empty value'
      config_path=${argument}
      explicit=true
      expecting_path=false
      (( config_argument_count += 1 ))
      continue
    fi
    case "${argument}" in
      --config-file|-c)
        expecting_path=true
        ;;
      --config-file=*|-c=*)
        config_path=${argument#*=}
        [[ -n "${config_path}" ]] || fail 'Docker daemon --config-file has an empty value'
        explicit=true
        (( config_argument_count += 1 ))
        ;;
    esac
  done <<<"${cmdline_text}"

  [[ "${expecting_path}" == false ]] || fail 'Docker daemon --config-file has no value'
  (( config_argument_count <= 1 )) || fail 'Docker daemon has multiple --config-file arguments'
  if [[ "${explicit}" == false ]]; then
    config_path='/etc/docker/daemon.json'
  fi
  [[ "${config_path}" == /* && "${config_path}" != '/' && \
    "${config_path}" != *'//'* && "${config_path}" != *'/./'* && \
    "${config_path}" != *'/../'* && "${config_path}" != */. && \
    "${config_path}" != */.. && \
    "${config_path}" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
    fail 'Docker daemon config path must be a narrow absolute path'

  printf '%s\t%s\n' "${explicit}" "${config_path}"
}

validate_docker_daemon_process_values() {
  local cmdline_text=$1
  local environment_text=$2
  local argument value environment_entry
  local host_endpoint=''
  local expecting_host_endpoint=false
  local host_endpoint_count=0

  while IFS= read -r argument || [[ -n "${argument}" ]]; do
    if [[ "${expecting_host_endpoint}" == true ]]; then
      [[ -n "${argument}" ]] || fail 'Docker daemon host endpoint is empty'
      host_endpoint=${argument}
      (( host_endpoint_count += 1 ))
      expecting_host_endpoint=false
      continue
    fi
    case "${argument}" in
      -H|--host)
        expecting_host_endpoint=true
        ;;
      -H=*|--host=*)
        host_endpoint=${argument#*=}
        [[ -n "${host_endpoint}" ]] || fail 'Docker daemon host endpoint is empty'
        (( host_endpoint_count += 1 ))
        ;;
      -H?*)
        host_endpoint=${argument#-H}
        [[ -n "${host_endpoint}" ]] || fail 'Docker daemon host endpoint is empty'
        (( host_endpoint_count += 1 ))
        ;;
      --allow-direct-routing)
        fail 'Docker daemon direct routing must remain disabled'
        ;;
      --allow-direct-routing=*)
        value=${argument#*=}
        case "${value}" in
          false|False|FALSE|f|F|0) ;;
          true|True|TRUE|t|T|1) fail 'Docker daemon direct routing must remain disabled' ;;
          *) fail 'Docker daemon has an invalid --allow-direct-routing value' ;;
        esac
        ;;
      --iptables)
        ;;
      --iptables=*)
        value=${argument#*=}
        case "${value}" in
          true|True|TRUE|t|T|1) ;;
          false|False|FALSE|f|F|0) fail 'Docker daemon IPv4 iptables management must remain enabled' ;;
          *) fail 'Docker daemon has an invalid --iptables value' ;;
        esac
        ;;
      --ip6tables)
        ;;
      --ip6tables=*)
        value=${argument#*=}
        case "${value}" in
          true|True|TRUE|t|T|1) ;;
          false|False|FALSE|f|F|0) fail 'Docker daemon IPv6 iptables management must remain enabled' ;;
          *) fail 'Docker daemon has an invalid --ip6tables value' ;;
        esac
        ;;
      --bridge-accept-fwmark)
        fail 'Docker daemon bridge firewall-mark bypass must remain disabled'
        ;;
      --bridge-accept-fwmark=*)
        value=${argument#*=}
        [[ -z "${value}" ]] || \
          fail 'Docker daemon bridge firewall-mark bypass must remain disabled'
        ;;
      --default-network-opt|--default-network-opt=*)
        fail 'Docker daemon default network options are forbidden for the release perimeter'
        ;;
    esac
  done <<<"${cmdline_text}"
  [[ "${expecting_host_endpoint}" == false ]] || fail 'Docker daemon -H has no value'
  [[ "${host_endpoint_count}" == '1' && "${host_endpoint}" == 'fd://' ]] || \
    fail 'Docker daemon must expose exactly one systemd-activated fd:// API endpoint'

  while IFS= read -r environment_entry || [[ -n "${environment_entry}" ]]; do
    [[ "${environment_entry}" != DOCKER_INSECURE_NO_IPTABLES_RAW=* ]] || \
      fail 'Docker daemon must not use DOCKER_INSECURE_NO_IPTABLES_RAW'
  done <<<"${environment_text}"
}

validate_docker_daemon_config_values() {
  local config_json=$1
  jq -e '
    type == "object"
    and (keys | sort) == ["allow-direct-routing", "ip6tables", "iptables"]
    and .["allow-direct-routing"] == false
    and .iptables == true
    and .ip6tables == true
  ' <<<"${config_json}" >/dev/null || \
    fail 'Docker daemon JSON config must match the exact release perimeter baseline'
}

validate_docker_daemon_perimeter_values() {
  local cmdline_text=$1
  local environment_text=$2
  local config_json=$3
  validate_docker_daemon_process_values "${cmdline_text}" "${environment_text}"
  validate_docker_daemon_config_values "${config_json}"
}

check_docker_daemon_perimeter_contract() {
  local daemon_pid_before daemon_pid_after daemon_comm daemon_started_text daemon_started_epoch
  local cmdline_text environment_text config_descriptor
  local config_explicit config_path descriptor_remainder
  local config_stat_before config_stat_after config_owner config_mode config_mtime config_ctime
  local config_directory_stat_before config_directory_stat_after config_directory_owner
  local config_directory_mode
  local config_hash_before config_hash_after config_json
  local socket_stat_before socket_stat_after socket_listener_before socket_listener_after

  assert_docker_cli_local_contract
  daemon_pid_before="$(perimeter_systemctl show --property MainPID --value docker.service)" || \
    fail 'could not resolve the running Docker daemon PID'
  [[ "${daemon_pid_before}" =~ ^[0-9]+$ ]] && (( daemon_pid_before > 1 )) || \
    fail 'Docker service has no valid main daemon PID'
  daemon_started_text="$(perimeter_systemctl show \
    --property ExecMainStartTimestamp --value docker.service)" || \
    fail 'could not resolve the Docker daemon start timestamp'
  [[ -n "${daemon_started_text}" && "${daemon_started_text}" != 'n/a' ]] || \
    fail 'Docker service has no valid start timestamp'
  daemon_started_epoch="$(date -d "${daemon_started_text}" +%s)" || \
    fail 'could not parse the Docker daemon start timestamp'
  [[ "${daemon_started_epoch}" =~ ^[0-9]+$ ]] || \
    fail 'Docker daemon start timestamp is invalid'
  [[ -r "/proc/${daemon_pid_before}/comm" && -r "/proc/${daemon_pid_before}/cmdline" && \
    -r "/proc/${daemon_pid_before}/environ" ]] || \
    fail 'Docker daemon process metadata is unavailable'
  daemon_comm="$(tr -d '\n' <"/proc/${daemon_pid_before}/comm")" || \
    fail 'could not read the Docker daemon process name'
  [[ "${daemon_comm}" == 'dockerd' ]] || \
    fail "Docker service MainPID is not dockerd: ${daemon_comm}"
  cmdline_text="$(tr '\0' '\n' <"/proc/${daemon_pid_before}/cmdline")" || \
    fail 'could not read the Docker daemon command line'
  environment_text="$(tr '\0' '\n' <"/proc/${daemon_pid_before}/environ")" || \
    fail 'could not read the Docker daemon environment'
  socket_stat_before="$(stat -Lc '%d:%i:%u:%g:%a:%Z' -- /run/docker.sock)" || \
    fail 'could not inspect the pinned Docker socket identity'
  socket_listener_before="$(docker_socket_listener_for_pid "${daemon_pid_before}")" || \
    fail 'could not bind the pinned Docker socket to docker.service'

  config_descriptor="$(docker_daemon_config_path_from_args "${cmdline_text}")" || \
    fail 'could not resolve the effective Docker daemon config path'
  IFS=$'\t' read -r config_explicit config_path descriptor_remainder \
    <<<"${config_descriptor}"
  [[ ( "${config_explicit}" == true || "${config_explicit}" == false ) && \
    -n "${config_path}" && -z "${descriptor_remainder}" ]] || \
    fail 'Docker daemon config descriptor is invalid'
  [[ "${config_path}" == '/etc/docker/daemon.json' ]] || \
    fail 'Docker daemon must use the canonical /etc/docker/daemon.json config path'
  [[ -d /etc/docker && ! -L /etc/docker ]] || \
    fail 'Docker daemon config directory must be a real directory'
  config_directory_stat_before="$(stat -c '%d:%i:%u:%a:%Y:%Z' -- /etc/docker)" || \
    fail 'could not inspect Docker daemon config directory metadata'
  IFS=: read -r _ _ config_directory_owner config_directory_mode _ _ \
    <<<"${config_directory_stat_before}"
  [[ "${config_directory_owner}" == '0' && \
    "${config_directory_mode}" =~ ^[0-7]{3,4}$ ]] || \
    fail 'Docker daemon config directory must be owned by root'
  (( (8#${config_directory_mode} & 022) == 0 )) || \
    fail 'Docker daemon config directory must not be group- or world-writable'
  [[ -e "${config_path}" || -L "${config_path}" ]] || \
    fail "Docker daemon requires an explicit safe config at ${config_path}"
  [[ -f "${config_path}" && ! -L "${config_path}" ]] || \
    fail 'Docker daemon config must be a regular non-symlink file'

  config_stat_before="$(stat -c '%d:%i:%u:%a:%s:%Y:%Z' -- "${config_path}")" || \
    fail 'could not inspect Docker daemon config metadata'
  IFS=: read -r _ _ config_owner config_mode _ config_mtime config_ctime \
    <<<"${config_stat_before}"
  [[ "${config_owner}" == '0' ]] || fail 'Docker daemon config must be owned by root'
  [[ "${config_mode}" =~ ^[0-7]{3,4}$ ]] || \
    fail 'Docker daemon config permissions are invalid'
  (( (8#${config_mode} & 022) == 0 )) || \
    fail 'Docker daemon config must not be group- or world-writable'
  validate_docker_config_start_binding \
    "${config_mtime}" "${config_ctime}" "${daemon_started_epoch}"
  config_hash_before="$(sha256sum "${config_path}" | awk '{print $1}')" || \
    fail 'could not hash the Docker daemon config'
  [[ "${config_hash_before}" =~ ^[a-f0-9]{64}$ ]] || \
    fail 'Docker daemon config hash is invalid'
  config_json="$(jq -ces '
    if length == 1 and (.[0] | type) == "object" then .[0]
    else error("expected exactly one JSON object")
    end
  ' -- "${config_path}")" || \
    fail 'Docker daemon config must contain exactly one JSON object'
  perimeter_dockerd_validate "${config_path}" >/dev/null || \
    fail 'dockerd rejected the Docker daemon config'
  config_hash_after="$(sha256sum "${config_path}" | awk '{print $1}')" || \
    fail 'could not re-hash the Docker daemon config'
  config_stat_after="$(stat -c '%d:%i:%u:%a:%s:%Y:%Z' -- "${config_path}")" || \
    fail 'could not re-inspect Docker daemon config metadata'
  config_directory_stat_after="$(stat -c '%d:%i:%u:%a:%Y:%Z' -- /etc/docker)" || \
    fail 'could not re-inspect Docker daemon config directory metadata'
  [[ "${config_hash_before}" == "${config_hash_after}" && \
    "${config_stat_before}" == "${config_stat_after}" && \
    "${config_directory_stat_before}" == "${config_directory_stat_after}" ]] || \
    fail 'Docker daemon config or its parent directory changed while it was inspected'

  validate_docker_daemon_perimeter_values \
    "${cmdline_text}" "${environment_text}" "${config_json}"
  daemon_pid_after="$(perimeter_systemctl show --property MainPID --value docker.service)" || \
    fail 'could not re-resolve the running Docker daemon PID'
  [[ "${daemon_pid_after}" == "${daemon_pid_before}" ]] || \
    fail 'Docker daemon restarted while its perimeter was inspected'
  socket_stat_after="$(stat -Lc '%d:%i:%u:%g:%a:%Z' -- /run/docker.sock)" || \
    fail 'could not re-inspect the pinned Docker socket identity'
  socket_listener_after="$(docker_socket_listener_for_pid "${daemon_pid_after}")" || \
    fail 'could not re-bind the pinned Docker socket to docker.service'
  [[ "${socket_stat_after}" == "${socket_stat_before}" && \
    "${socket_listener_after}" == "${socket_listener_before}" ]] || \
    fail 'Docker socket identity changed while its daemon perimeter was inspected'
  assert_docker_cli_local_contract
}
