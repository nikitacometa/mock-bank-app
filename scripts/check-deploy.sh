#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
project_root="$(cd -- "${script_directory}/.." && pwd -P)"
readonly project_root

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

reject_rg_match() {
  local -r failure_message=$1
  shift
  local rg_status
  if rg --quiet "$@"; then
    fail "${failure_message}"
  else
    rg_status=$?
  fi
  (( rg_status == 1 )) || \
    fail "ripgrep guard failed with status ${rg_status}: ${failure_message}"
}

command -v rg >/dev/null 2>&1 || fail 'required command not found: rg'
command -v sha256sum >/dev/null 2>&1 || fail 'required command not found: sha256sum'
command -v jq >/dev/null 2>&1 || fail 'required command not found: jq'

rg --fixed-strings --quiet "repository: 'bot/repository.ts'" \
  "${project_root}/vite.bot.config.ts" || \
  fail 'bot bundle must expose repository.js for release database probes'
for bot_dockerfile in \
  "${project_root}/deploy/bot/Dockerfile" \
  "${project_root}/deploy/standalone/Bot.Dockerfile"; do
  rg --fixed-strings --quiet \
    'COPY scripts/check-bot-bundle.mjs ./scripts/check-bot-bundle.mjs' \
    "${bot_dockerfile}" || \
    fail "bot build image is missing its bundle contract verifier: ${bot_dockerfile}"
done
rg --fixed-strings --quiet \
  'PUBLIC_WEB_APP_URL: https://euphoria.bot/app/${COMETA_RELEASE_ID:?COMETA_RELEASE_ID is required}/' \
  "${project_root}/deploy/standalone/compose.yaml" || \
  fail 'standalone bot must use a release-scoped Mini App entry URL'
rg --fixed-strings --quiet \
  'ledgerMode: repository.ledgerMode(),' \
  "${project_root}/bot/main.ts" || \
  fail 'bot startup must publish commands for the persisted ledger authority mode'

standalone_web_dockerfile="${project_root}/deploy/standalone/Web.Dockerfile"
awk '
  $0 == "ARG COMETA_RELEASE_ID" && release_arg == 0 { release_arg = NR }
  $0 == "ENV VITE_COMETA_RELEASE_ID=\"${COMETA_RELEASE_ID}\"" { release_env = NR }
  $0 ~ /^RUN pnpm build:web/ { web_build = NR }
  END { exit !(release_arg > 0 && release_arg < release_env && release_env < web_build) }
' "${standalone_web_dockerfile}" || \
  fail 'standalone web build must inject its release ID before compiling the client marker'
for scoped_entry_step in \
  'install -d "dist/app/${COMETA_RELEASE_ID}"' \
  'cp dist/index.html "dist/app/${COMETA_RELEASE_ID}/index.html"'; do
  rg --fixed-strings --quiet "${scoped_entry_step}" "${standalone_web_dockerfile}" || \
    fail "standalone web image is missing scoped entry materialization: ${scoped_entry_step}"
done
for standalone_nginx_config in \
  "${project_root}/deploy/standalone/nginx/http.conf" \
  "${project_root}/deploy/standalone/nginx/https.conf"; do
  rg --fixed-strings --quiet 'location ~ "^/app/[0-9]{8}T[0-9]{6}Z/$" {' \
    "${standalone_nginx_config}" || \
    fail "release-scoped Mini App route is missing from ${standalone_nginx_config}"
  rg --fixed-strings --quiet 'try_files $uri/index.html /index.html =404;' \
    "${standalone_nginx_config}" || \
    fail "release-scoped Mini App route has no rollback-safe fallback in ${standalone_nginx_config}"
  rg --fixed-strings --quiet 'location /app/ {' "${standalone_nginx_config}" || \
    fail "unknown Mini App release paths are not rejected in ${standalone_nginx_config}"
done
rg --fixed-strings --quiet \
  'const candidate = import.meta.env.VITE_COMETA_RELEASE_ID;' \
  "${project_root}/src/platform/ledgerClientContract.ts" || \
  fail 'Telegram client-contract marker must bind to the release-scoped web build'
rg --fixed-strings --quiet \
  'markClientContract: markLedgerClientContract,' \
  "${project_root}/src/app/launchPreferences.ts" || \
  fail 'Telegram launch sync must wire the persisted client-contract marker'
rg --fixed-strings --quiet \
  'if (!target.markClientContract(launch.telegramId)) return '\''retry'\'';' \
  "${project_root}/src/app/launchPreferences.ts" || \
  fail 'Telegram launch sync must fail closed when its client-contract marker cannot persist'

assert_sha256() {
  local -r file=$1
  local -r labelled_expected=$2
  local expected
  local actual

  [[ "${labelled_expected}" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "expected checksum must use sha256:<64 lowercase hex>: ${file}"
  expected=${labelled_expected#sha256:}
  actual="$(sha256sum "${file}" | awk '{print $1}')" || \
    fail "could not hash stable deployment artifact: ${file}"
  [[ "${actual}" == "${expected}" ]] || \
    fail "stable deployment artifact changed and would break image rollback: ${file}"
}

while IFS= read -r -d '' script; do
  bash -n "${script}"
done < <(find "${project_root}/deploy" -type f -name '*.sh' -print0)

for script in \
  deploy/standalone/scripts/host-preflight.sh \
  deploy/standalone/scripts/install-docker-perimeter.sh \
  deploy/standalone/scripts/package-release.sh \
  deploy/standalone/scripts/provision-host.sh \
  deploy/standalone/scripts/release.sh \
  deploy/standalone/scripts/renew-certificates-entrypoint.sh \
  deploy/standalone/scripts/renew-certificates.sh; do
  test -x "${project_root}/${script}" || fail "deployment script is not executable: ${script}"
done

docker_perimeter_installer="${project_root}/deploy/standalone/scripts/install-docker-perimeter.sh"
for required_installer_contract in \
  "readonly target_config='/etc/docker/daemon.json'" \
  "readonly recovery_marker='/etc/docker/.cometa-bank-perimeter.pending'" \
  "readonly deploy_lock='/run/lock/cometa-bank.deploy.lock'" \
  "readonly minimum_docker_version='28.0.0'" \
  "readonly health_stability_seconds='31'" \
  'run this installer from an immutable /srv/cometa-bank release' \
  'source "${script_directory}/docker-daemon-perimeter.sh"' \
  'flock --nonblock 9' \
  'assert_docker_cli_local_contract' \
  'assert_minimum_docker_engine' \
  'validate_docker_daemon_process_values' \
  'validate_docker_daemon_config_values' \
  'docker_socket_listener_for_pid "${current_daemon_pid}"' \
  'original-current %s' \
  'web-container %s restart-count %s' \
  'bot-container %s restart-count %s' \
  'phase %s' \
  'arm_recovery_marker || fail' \
  'install -m 0644 -o root -g root -- "${source_config}" "${target_config_next}"' \
  'perimeter_dockerd_validate "${target_config_next}"' \
  "stat -c '%Y:%Z' -- \"\${target_config}\"" \
  'wait_until_config_predates_restart' \
  'config_timestamps_precede_restart' \
  'systemctl_bounded restart --no-block docker.service' \
  'wait_for_docker_unit_state running' \
  'settle_failed_docker_transition' \
  'settle_docker_for_recovery' \
  'check_docker_daemon_perimeter_contract' \
  'verify_safe_runtime_stable' \
  'verify_current_application_recovered' \
  'read_release_image_manifest "${marker_current_release}"' \
  'and .[0].Image == $expected_image' \
  '"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]' \
  '"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]' \
  '== ["cometa-bank_edge", "cometa-bank_public"]' \
  '== ["cometa-bank_edge", "cometa-bank_egress"]' \
  'verify_network_object cometa-bank_edge edge true true' \
  'verify_network_object cometa-bank_egress egress false false' \
  'verify_network_object cometa-bank_public public false false' \
  'recover_armed_perimeter' \
  'persist_recovery_phase rollback' \
  'restore_absent_config' \
  'retire_recovery_marker'; do
  grep -Fq -- "${required_installer_contract}" "${docker_perimeter_installer}" || \
    fail "Docker perimeter installer contract is missing: ${required_installer_contract}"
done

installer_function_body() {
  local function_name=$1
  sed -n "/^${function_name}() {\$/,/^}\$/p" "${docker_perimeter_installer}"
}

installer_function_step_line() {
  local function_name=$1
  local needle=$2
  local occurrence=${3:-first}
  local function_body line
  function_body="$(installer_function_body "${function_name}")"
  [[ -n "${function_body}" ]] || fail "Docker perimeter installer function is missing: ${function_name}"
  case "${occurrence}" in
    first)
      line="$(awk -v needle="${needle}" 'index($0, needle) { print NR; exit }' \
        <<<"${function_body}")"
      ;;
    last)
      line="$(awk -v needle="${needle}" 'index($0, needle) { line = NR } \
        END { if (line) print line }' <<<"${function_body}")"
      ;;
    *) fail "unknown Docker installer step occurrence: ${occurrence}" ;;
  esac
  [[ "${line}" =~ ^[0-9]+$ ]] || \
    fail "Docker perimeter installer step is missing in ${function_name}: ${needle}"
  printf '%s\n' "${line}"
}

installer_inspect_service_flow="$(installer_function_body inspect_current_service)"
installer_network_object_flow="$(installer_function_body verify_network_object)"
installer_current_networks_flow="$(installer_function_body verify_current_network_objects)"
[[ -n "${installer_inspect_service_flow}" && -n "${installer_network_object_flow}" && \
  -n "${installer_current_networks_flow}" ]] || \
  fail 'Docker perimeter installer runtime inspection helpers are missing'

awk '
  index($0, "load_recovery_marker || recovery_status=$?") { recovery = NR }
  index($0, "docker_unit_is_settled || fail \047docker.service has an active or unreadable systemd job\047") { settled = NR }
  index($0, "docker_runtime_is_available || fail \047Docker is unavailable without a valid perimeter recovery journal\047") { live = NR }
  END { exit !(recovery > 0 && settled > recovery && live > settled) }
' "${docker_perimeter_installer}" || \
  fail 'Docker perimeter installer must dispatch a journal and reject active systemd jobs before live Docker'
awk '
  index($0, "arm_recovery_marker || fail \047could not arm Docker perimeter recovery marker\047") { arm = NR }
  index($0, "install_source_config || fail \047could not commit the versioned Docker daemon config\047") { commit = NR }
  index($0, "restart_and_verify_safe_config || restart_result=$?") { restart = NR }
  index($0, "retire_recovery_marker ||") { retire = NR }
  END { exit !(arm > 0 && arm < commit && commit < restart && restart < retire) }
' "${docker_perimeter_installer}" || \
  fail 'Docker perimeter installer must arm recovery before commit, restart, and retirement'
awk '
  index($0, "restart_and_verify_safe_config || restart_result=$?") { restart = NR }
  index($0, "[[ \"${docker_transition_settled}\" == true ]]") { settled = NR }
  index($0, "restore_absent_config || restore_result=$?") { restore = NR }
  END { exit !(restart > 0 && settled > restart && restore > settled) }
' "${docker_perimeter_installer}" || \
  fail 'Docker perimeter installer must refuse rollback after an unsettled Docker transition'

installer_rollback_phase_line="$(installer_function_step_line restore_absent_config \
  'persist_recovery_phase rollback')"
installer_rollback_staged_remove_line="$(installer_function_step_line restore_absent_config \
  'unlink -- "${target_config_next}"')"
installer_rollback_target_remove_line="$(installer_function_step_line restore_absent_config \
  'unlink -- "${target_config}"')"
installer_rollback_restart_line="$(installer_function_step_line restore_absent_config \
  'restart_docker_service')"
installer_rollback_health_line="$(installer_function_step_line restore_absent_config \
  'verify_current_application_recovered')"
installer_rollback_retire_line="$(installer_function_step_line restore_absent_config \
  'retire_recovery_marker')"
(( installer_rollback_phase_line < installer_rollback_staged_remove_line && \
  installer_rollback_phase_line < installer_rollback_target_remove_line && \
  installer_rollback_target_remove_line < installer_rollback_restart_line && \
  installer_rollback_restart_line < installer_rollback_health_line && \
  installer_rollback_health_line < installer_rollback_retire_line )) || \
  fail 'Docker perimeter rollback must journal phase before removal and retire only after app recovery'

installer_recovery_settle_line="$(installer_function_step_line recover_armed_perimeter \
  'settle_docker_for_recovery')"
installer_recovery_install_line="$(installer_function_step_line recover_armed_perimeter \
  'install_source_config')"
installer_recovery_restore_line="$(installer_function_step_line recover_armed_perimeter \
  'restore_absent_config' first)"
(( installer_recovery_settle_line < installer_recovery_install_line && \
  installer_recovery_settle_line < installer_recovery_restore_line )) || \
  fail 'Docker perimeter recovery must settle any inherited systemd job before mutation'

installer_safe_perimeter_first_line="$(installer_function_step_line verify_safe_runtime_stable \
  'check_docker_daemon_perimeter_contract' first)"
installer_safe_capture_first_line="$(installer_function_step_line verify_safe_runtime_stable \
  'capture_current_daemon' first)"
installer_safe_pid_line="$(installer_function_step_line verify_safe_runtime_stable \
  'daemon_pid_before_health=${current_daemon_pid}')"
installer_safe_health_line="$(installer_function_step_line verify_safe_runtime_stable \
  'verify_current_application_recovered')"
installer_safe_perimeter_last_line="$(installer_function_step_line verify_safe_runtime_stable \
  'check_docker_daemon_perimeter_contract' last)"
installer_safe_capture_last_line="$(installer_function_step_line verify_safe_runtime_stable \
  'capture_current_daemon' last)"
installer_safe_pid_match_line="$(installer_function_step_line verify_safe_runtime_stable \
  '[[ "${current_daemon_pid}" == "${daemon_pid_before_health}" ]]')"
(( installer_safe_perimeter_first_line < installer_safe_capture_first_line && \
  installer_safe_capture_first_line < installer_safe_pid_line && \
  installer_safe_pid_line < installer_safe_health_line && \
  installer_safe_health_line < installer_safe_perimeter_last_line && \
  installer_safe_perimeter_last_line < installer_safe_capture_last_line && \
  installer_safe_capture_last_line < installer_safe_pid_match_line )) || \
  fail 'Docker perimeter stable runtime must rebind the same daemon PID after app recovery'

installer_app_network_first_line="$(installer_function_step_line verify_current_application_recovered \
  'verify_current_network_objects' first)"
installer_app_boundaries_line="$(installer_function_step_line verify_current_application_recovered \
  'verify_application_boundaries')"
installer_app_network_last_line="$(installer_function_step_line verify_current_application_recovered \
  'verify_current_network_objects' last)"
(( installer_app_network_first_line < installer_app_boundaries_line && \
  installer_app_boundaries_line < installer_app_network_last_line )) || \
  fail 'Docker perimeter app recovery must bind exact networks before and after HTTPS health'

bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  current_release=20990301T000000Z
  web_id="$(printf "a%.0s" {1..64})"
  bot_id="$(printf "b%.0s" {1..64})"
  web_image="sha256:$(printf "c%.0s" {1..64})"
  bot_image="sha256:$(printf "d%.0s" {1..64})"
  wrong_image="sha256:$(printf "e%.0s" {1..64})"
  mock_paused=false
  mock_status=running
  mock_running=true
  mock_health=healthy
  mock_restart_count=2
  mock_image_override=
  mock_bot_ports='\''{}'\''
  mock_web_networks='\''{"cometa-bank_edge":{},"cometa-bank_public":{}}'\''
  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{}}'\''
  mock_web_network_mode=cometa-bank_edge
  mock_bot_network_mode=cometa-bank_edge
  mock_ps_count=1
  mock_network_fault=
  duplicate_network=

  emit_container_inspection() {
    local -r container_id=$1
    local -r service=$2
    local image port_bindings networks network_mode
    if [[ "${service}" == web ]]; then
      image=${web_image}
      port_bindings='\''{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}],"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}'\''
      networks=${mock_web_networks}
      network_mode=${mock_web_network_mode}
    else
      image=${bot_image}
      port_bindings=${mock_bot_ports}
      networks=${mock_bot_networks}
      network_mode=${mock_bot_network_mode}
    fi
    [[ -z "${mock_image_override}" ]] || image=${mock_image_override}
    printf '\''[{"Id":"%s","Image":"%s","Config":{"Labels":{"com.docker.compose.project":"cometa-bank","com.docker.compose.service":"%s","org.opencontainers.image.version":"%s"}},"State":{"Running":%s,"Status":"%s","Paused":%s,"Restarting":false,"Dead":false,"Health":{"Status":"%s"}},"RestartCount":%s,"HostConfig":{"NetworkMode":"%s","PortBindings":%s},"NetworkSettings":{"Networks":%s}}]\n'\'' \
      "${container_id}" "${image}" "${service}" "${current_release}" \
      "${mock_running}" "${mock_status}" "${mock_paused}" "${mock_health}" \
      "${mock_restart_count}" "${network_mode}" "${port_bindings}" "${networks}"
  }
  emit_network_inspection() {
    local -r network_name=$1
    local logical_name=${network_name#cometa-bank_}
    local internal=false expected_icc=false driver=bridge subnet=172.30.0.0/16
    [[ "${logical_name}" != edge ]] || {
      internal=true
      expected_icc=true
    }
    case "${mock_network_fault}:${logical_name}" in
      driver:edge) driver=overlay ;;
      public-ipam:public) subnet=203.0.113.0/24 ;;
      egress-icc:egress) expected_icc=true ;;
      internal:public) internal=true ;;
    esac
    printf '\''{"Name":"%s","Driver":"%s","Scope":"local","Internal":%s,"Ingress":false,"Attachable":false,"ConfigOnly":false,"ConfigFrom":{"Network":""},"EnableIPv4":true,"EnableIPv6":false,"IPAM":{"Driver":"default","Options":{},"Config":[{"Subnet":"%s","Gateway":"172.30.0.1"}]},"Labels":{"com.docker.compose.project":"cometa-bank","com.docker.compose.network":"%s"},"Options":{"com.docker.network.bridge.enable_icc":"%s"}}\n'\'' \
      "${network_name}" "${driver}" "${internal}" "${subnet}" \
      "${logical_name}" "${expected_icc}"
  }
  docker_bounded() {
    if [[ "$1" == ps ]]; then
      local service container_id count
      case " $* " in
        *"label=com.docker.compose.service=web"*) service=web; container_id=${web_id} ;;
        *"label=com.docker.compose.service=bot"*) service=bot; container_id=${bot_id} ;;
        *) return 1 ;;
      esac
      for (( count = 0; count < mock_ps_count; count += 1 )); do
        printf "%s\n" "${container_id}"
      done
      return
    fi
    if [[ "$1" == inspect ]]; then
      case "$2" in
        "${web_id}") emit_container_inspection "${web_id}" web ;;
        "${bot_id}") emit_container_inspection "${bot_id}" bot ;;
        *) return 1 ;;
      esac
      return
    fi
    if [[ "$1" == network && "$2" == ls ]]; then
      printf "%s\n" cometa-bank_edge cometa-bank_egress cometa-bank_public
      [[ -z "${duplicate_network}" ]] || printf "%s\n" "${duplicate_network}"
      return
    fi
    if [[ "$1" == network && "$2" == inspect ]]; then
      emit_network_inspection "${@: -1}"
      return
    fi
    return 1
  }
  reset_container_faults() {
    mock_paused=false
    mock_status=running
    mock_running=true
    mock_health=healthy
    mock_restart_count=2
    mock_image_override=
    mock_bot_ports='\''{}'\''
    mock_web_networks='\''{"cometa-bank_edge":{},"cometa-bank_public":{}}'\''
    mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{}}'\''
    mock_web_network_mode=cometa-bank_edge
    mock_bot_network_mode=cometa-bank_edge
    mock_ps_count=1
  }

  [[ "$(inspect_current_service "${current_release}" web "${web_image}")" == \
    "${web_id}"$'\''\t'\''2 ]]
  [[ "$(inspect_current_service "${current_release}" bot "${bot_image}")" == \
    "${bot_id}"$'\''\t'\''2 ]]

  for invalid_kind in paused wrong-image bot-port extra-network missing-network wrong-primary duplicate stopped unhealthy; do
    reset_container_faults
    service=web
    expected_image=${web_image}
    case "${invalid_kind}" in
      paused) mock_paused=true ;;
      wrong-image) mock_image_override=${wrong_image} ;;
      bot-port)
        service=bot
        expected_image=${bot_image}
        mock_bot_ports='\''{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]}'\''
        ;;
      extra-network)
        service=bot
        expected_image=${bot_image}
        mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{},"cometa-bank_public":{}}'\''
        ;;
      missing-network)
        mock_web_networks='\''{"cometa-bank_edge":{}}'\''
        ;;
      wrong-primary) mock_web_network_mode=host ;;
      duplicate) mock_ps_count=2 ;;
      stopped) mock_running=false; mock_status=exited ;;
      unhealthy) mock_health=unhealthy ;;
    esac
    if (inspect_current_service "${current_release}" "${service}" \
      "${expected_image}" >/dev/null 2>&1); then
      exit 1
    fi
  done

  verify_current_network_objects
  for mock_network_fault in driver public-ipam egress-icc internal; do
    if (verify_current_network_objects >/dev/null 2>&1); then exit 1; fi
  done
  mock_network_fault=
  duplicate_network=cometa-bank_edge
  if (verify_current_network_objects >/dev/null 2>&1); then exit 1; fi
' _ "${installer_inspect_service_flow}" "${installer_network_object_flow}" \
  "${installer_current_networks_flow}" || \
  fail 'Docker perimeter installer service and exact-network inspection harness failed'

installer_marker_path_flow="$(installer_function_body read_recovery_marker_path)"
installer_marker_set_flow="$(installer_function_body set_marker_record)"
installer_marker_match_flow="$(installer_function_body marker_record_matches_transaction)"
installer_marker_load_flow="$(installer_function_body load_recovery_marker)"
installer_marker_persist_flow="$(installer_function_body persist_recovery_phase)"
installer_marker_arm_flow="$(installer_function_body arm_recovery_marker)"
installer_marker_retire_flow="$(installer_function_body retire_recovery_marker)"
installer_config_match_flow="$(installer_function_body config_matches_source)"
installer_staged_config_flow="$(installer_function_body staged_config_matches_source)"
installer_staged_discard_flow="$(installer_function_body staged_config_is_discardable)"
installer_config_reconcile_flow="$(installer_function_body reconcile_staged_config)"
for installer_flow in \
  "${installer_marker_path_flow}" \
  "${installer_marker_set_flow}" \
  "${installer_marker_match_flow}" \
  "${installer_marker_load_flow}" \
  "${installer_marker_persist_flow}" \
  "${installer_marker_arm_flow}" \
  "${installer_marker_retire_flow}" \
  "${installer_config_match_flow}" \
  "${installer_staged_config_flow}" \
  "${installer_staged_discard_flow}" \
  "${installer_config_reconcile_flow}"; do
  [[ -n "${installer_flow}" ]] || fail 'Docker perimeter installer retry function is missing'
done
bash -c '
  set -Eeuo pipefail
  for function_source in "$@"; do eval "${function_source}"; done
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  umask 077
  config_directory="${harness_root}/etc-docker"
  deploy_root="${harness_root}/srv-cometa-bank"
  recovery_marker="${config_directory}/pending"
  recovery_marker_next="${config_directory}/pending.next"
  target_config="${config_directory}/daemon.json"
  target_config_next="${config_directory}/daemon.json.next"
  source_config="${harness_root}/source.json"
  release_id=20990101T000000Z
  marker_current_release=20981231T235959Z
  marker_web_container="$(printf "%064d" 0)"
  marker_web_restart_count=2
  marker_bot_container="$(printf "%064d" 1)"
  marker_bot_restart_count=3
  marker_phase=""
  apply=false
  marker_mode=600
  target_mode=644
  mkdir -p "${config_directory}" \
    "${deploy_root}/releases/${marker_current_release}"
  printf '\''{"allow-direct-routing":false,"iptables":true,"ip6tables":true}\n'\'' \
    >"${source_config}"
  source_hash="$(sha256sum "${source_config}" | awk '\''{print $1}'\'')"
  fail() { exit 91; }
  mutation_log="${harness_root}/mutations.log"
  : >"${mutation_log}"
  sync() { printf "sync\n" >>"${mutation_log}"; }
  perimeter_dockerd_validate() { :; }
  chown() { :; }
  stat() {
    local path
    for path in "$@"; do :; done
    case "${path}" in
      "${recovery_marker}"|"${recovery_marker_next}") printf "0:%s\n" "${marker_mode}" ;;
      "${target_config}"|"${target_config_next}") printf "0:%s\n" "${target_mode}" ;;
      *) return 1 ;;
    esac
  }
  mv() { printf "mv\n" >>"${mutation_log}"; command mv -- "$3" "$4"; }
  unlink() { printf "unlink\n" >>"${mutation_log}"; command rm -f -- "$2"; }

  write_marker_candidate() {
    local destination=$1
    local phase=$2
    local current=${3:-${marker_current_release}}
    printf "operator %s\nsource-sha256 %s\noriginal-current %s\nweb-container %s restart-count %s\nbot-container %s restart-count %s\noriginal absent\nphase %s\n" \
      "${release_id}" "${source_hash}" "${current}" \
      "${marker_web_container}" "${marker_web_restart_count}" \
      "${marker_bot_container}" "${marker_bot_restart_count}" "${phase}" \
      >"${destination}"
  }

  write_partial_marker() {
    printf "operator %s\nsource-sha256 %s\noriginal-current " \
      "${release_id}" "${source_hash}" >"${recovery_marker_next}"
  }

  assert_candidate_dry_run() {
    local expected_phase=$1
    local main_before=absent next_before marker_status=0
    if [[ -f "${recovery_marker}" ]]; then
      main_before="$(sha256sum "${recovery_marker}")" || exit 1
    fi
    next_before="$(sha256sum "${recovery_marker_next}")" || exit 1
    : >"${mutation_log}"
    apply=false
    load_recovery_marker || marker_status=$?
    [[ "${marker_status}" == 12 && "${marker_phase}" == "${expected_phase}" && \
      ! -s "${mutation_log}" && -f "${recovery_marker_next}" ]] || exit 1
    [[ "$(sha256sum "${recovery_marker_next}")" == "${next_before}" ]] || exit 1
    if [[ "${main_before}" == absent ]]; then
      [[ ! -e "${recovery_marker}" ]] || exit 1
    else
      [[ "$(sha256sum "${recovery_marker}")" == "${main_before}" ]] || exit 1
    fi
  }

  write_partial_marker
  if read_recovery_marker_path "${recovery_marker_next}" >/dev/null 2>&1; then exit 1; fi
  : >"${mutation_log}"
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 11 && -f "${recovery_marker_next}" && \
    ! -e "${recovery_marker}" && ! -s "${mutation_log}" ]]
  apply=true
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 10 && ! -e "${recovery_marker_next}" && \
    ! -e "${recovery_marker}" ]]
  apply=false

  arm_recovery_marker
  [[ -f "${recovery_marker}" && ! -e "${recovery_marker_next}" && \
    "${marker_phase}" == install ]]

  write_partial_marker
  : >"${mutation_log}"
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 0 && -f "${recovery_marker}" && \
    -f "${recovery_marker_next}" && "${marker_phase}" == install && \
    ! -s "${mutation_log}" ]]
  apply=true
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 0 && -f "${recovery_marker}" && \
    ! -e "${recovery_marker_next}" && "${marker_phase}" == install ]]
  apply=false

  write_marker_candidate "${recovery_marker_next}" install
  assert_candidate_dry_run install
  apply=true
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 0 && ! -e "${recovery_marker_next}" && \
    "${marker_phase}" == install ]]
  apply=false

  write_marker_candidate "${recovery_marker_next}" rollback
  assert_candidate_dry_run rollback
  apply=true
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 0 && ! -e "${recovery_marker_next}" && \
    "${marker_phase}" == rollback ]]
  grep -Fxq "phase rollback" "${recovery_marker}"
  apply=false

  persist_recovery_phase rollback
  [[ "${marker_phase}" == rollback && ! -e "${recovery_marker_next}" ]]
  grep -Fxq "phase rollback" "${recovery_marker}"

  write_marker_candidate "${recovery_marker_next}" rollback
  assert_candidate_dry_run rollback
  apply=true
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 0 && ! -e "${recovery_marker_next}" && \
    "${marker_phase}" == rollback ]]
  apply=false

  write_marker_candidate "${recovery_marker_next}" install
  if load_recovery_marker >/dev/null 2>&1; then exit 1; fi
  [[ -f "${recovery_marker}" && -f "${recovery_marker_next}" ]]
  command rm -f -- "${recovery_marker_next}"

  retire_recovery_marker
  [[ ! -e "${recovery_marker}" && ! -e "${recovery_marker_next}" ]]

  write_marker_candidate "${recovery_marker_next}" install
  assert_candidate_dry_run install
  apply=true
  marker_status=0
  load_recovery_marker || marker_status=$?
  [[ "${marker_status}" == 0 && -f "${recovery_marker}" && \
    ! -e "${recovery_marker_next}" && "${marker_phase}" == install ]]
  apply=false
  retire_recovery_marker

  printf "operator %s\nsource-sha256 %s\noriginal absent\nphase install\n" \
    "${release_id}" "${source_hash}" >"${recovery_marker_next}"
  if read_recovery_marker_path "${recovery_marker_next}" >/dev/null 2>&1; then exit 1; fi
  command rm -f -- "${recovery_marker_next}"

  write_marker_candidate "${recovery_marker_next}" unsafe
  if read_recovery_marker_path "${recovery_marker_next}" >/dev/null 2>&1; then exit 1; fi
  command rm -f -- "${recovery_marker_next}"

  write_marker_candidate "${recovery_marker_next}" install 20970101T000000Z
  if read_recovery_marker_path "${recovery_marker_next}" >/dev/null 2>&1; then exit 1; fi
  command rm -f -- "${recovery_marker_next}"

  arm_recovery_marker
  [[ -f "${recovery_marker}" && ! -e "${recovery_marker_next}" ]]

  command cp -- "${source_config}" "${target_config_next}"
  reconcile_staged_config
  [[ -f "${target_config}" && ! -e "${target_config_next}" ]]
  command cp -- "${source_config}" "${target_config_next}"
  reconcile_staged_config
  [[ -f "${target_config}" && ! -e "${target_config_next}" ]]

  printf "partial" >"${target_config_next}"
  reconcile_staged_config
  [[ ! -e "${target_config_next}" ]]

  target_mode=666
  printf "partial" >"${target_config_next}"
  if reconcile_staged_config >/dev/null 2>&1; then exit 1; fi
  [[ -f "${target_config_next}" ]]
  command rm -f -- "${target_config_next}"
  target_mode=644

  retire_recovery_marker
  [[ ! -e "${recovery_marker}" && ! -e "${recovery_marker_next}" ]]

  printf "corrupt\n" >"${target_config_next}"
  if (reconcile_staged_config) >/dev/null 2>&1; then exit 1; fi
  [[ -f "${target_config_next}" ]]
' _ \
  "${installer_marker_path_flow}" \
  "${installer_marker_set_flow}" \
  "${installer_marker_match_flow}" \
  "${installer_marker_load_flow}" \
  "${installer_marker_persist_flow}" \
  "${installer_marker_arm_flow}" \
  "${installer_marker_retire_flow}" \
  "${installer_config_match_flow}" \
  "${installer_staged_config_flow}" \
  "${installer_staged_discard_flow}" \
  "${installer_config_reconcile_flow}" || \
  fail 'Docker perimeter installer staged-file retry harness failed'

installer_recovery_dispatch_flow="$(sed -n '/^recovery_status=0$/,/^fi$/p' \
  "${docker_perimeter_installer}")"
for candidate_status in 11 12; do
  candidate_plan="$(bash -c '
    set -Eeuo pipefail
    apply=false
    marker_phase=rollback
    assert_no_other_recovery_intents() { :; }
    pending_status=$2
    load_recovery_marker() { return "${pending_status}"; }
    recover_armed_perimeter() { exit 97; }
    fail() { exit 98; }
    eval "$1"
    exit 99
  ' _ "${installer_recovery_dispatch_flow}" "${candidate_status}")" || \
    fail 'Docker perimeter candidate dry-run must exit before recovery execution'
  if [[ "${candidate_status}" == 11 ]]; then
    grep -Fq 'journal candidate needs cleanup.' <<<"${candidate_plan}" || \
      fail 'Docker perimeter invalid candidate dry-run must describe cleanup'
  else
    grep -Fq 'journal candidate is ready to reconcile.' <<<"${candidate_plan}" || \
      fail 'Docker perimeter valid candidate dry-run must describe reconciliation'
    grep -Fq 'resume recovery in phase rollback.' <<<"${candidate_plan}" || \
      fail 'Docker perimeter valid candidate dry-run must describe its target phase'
  fi
done

installer_version_flow="$(installer_function_body version_at_least)"
installer_minimum_engine_flow="$(installer_function_body assert_minimum_docker_engine)"
installer_timestamp_flow="$(installer_function_body config_timestamps_precede_restart)"
installer_recovery_flow="$(installer_function_body recover_armed_perimeter)"
installer_restore_flow="$(installer_function_body restore_absent_config)"
installer_unit_settled_flow="$(installer_function_body docker_unit_is_settled)"
installer_wait_unit_flow="$(installer_function_body wait_for_docker_unit_state)"
installer_settle_failed_flow="$(installer_function_body settle_failed_docker_transition)"
installer_settle_recovery_flow="$(installer_function_body settle_docker_for_recovery)"
installer_restart_service_flow="$(installer_function_body restart_docker_service)"
for installer_flow in \
  "${installer_version_flow}" \
  "${installer_minimum_engine_flow}" \
  "${installer_timestamp_flow}" \
  "${installer_recovery_flow}" \
  "${installer_restore_flow}" \
  "${installer_unit_settled_flow}" \
  "${installer_wait_unit_flow}" \
  "${installer_settle_failed_flow}" \
  "${installer_settle_recovery_flow}" \
  "${installer_restart_service_flow}"; do
  [[ -n "${installer_flow}" ]] || fail 'Docker perimeter installer value guard is missing'
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  minimum_docker_version=28.0.0
  docker_engine_version() { printf "%s\n" "${mock_engine_version}"; }

  for mock_engine_version in 28.0.0 v28.0.0 28.0.1 29.0.0; do
    assert_minimum_docker_engine
  done
  for mock_engine_version in 27.99.99 0.0.0 invalid; do
    if assert_minimum_docker_engine >/dev/null 2>&1; then exit 1; fi
  done

  config_timestamps_precede_restart 100 199 200
  config_timestamps_precede_restart 199 100 200
  for unsafe_times in \
    "200 100 200" \
    "100 200 200" \
    "201 100 200" \
    "100 201 200" \
    "invalid 100 200"; do
    read -r config_mtime config_ctime restart_epoch <<<"${unsafe_times}"
    if config_timestamps_precede_restart \
      "${config_mtime}" "${config_ctime}" "${restart_epoch}"; then
      exit 1
    fi
  done
' _ "${installer_version_flow}" "${installer_minimum_engine_flow}" \
  "${installer_timestamp_flow}" || \
  fail 'Docker perimeter installer Engine and timestamp barrier harness failed'

bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  mock_active=active
  mock_sub=running
  mock_pid=4242
  mock_jobs=""
  mock_now=100
  systemctl_bounded() {
    case "$*" in
      "show --property ActiveState --value docker.service") printf "%s\n" "${mock_active}" ;;
      "show --property SubState --value docker.service") printf "%s\n" "${mock_sub}" ;;
      "show --property MainPID --value docker.service") printf "%s\n" "${mock_pid}" ;;
      "list-jobs --no-legend --plain docker.service") printf "%s" "${mock_jobs}" ;;
      *) return 1 ;;
    esac
  }
  date() { printf "%s\n" "${mock_now}"; }
  sleep() { mock_now=$((mock_now + 1)); }

  wait_for_docker_unit_state running 1
  mock_active=inactive
  mock_sub=dead
  mock_pid=0
  wait_for_docker_unit_state stopped 1

  mock_active=activating
  mock_sub=start
  mock_pid=4242
  mock_now=100
  if wait_for_docker_unit_state running 1; then exit 1; fi

  mock_active=active
  mock_sub=running
  mock_pid=4242
  mock_jobs="1 docker.service start running"
  mock_now=100
  if wait_for_docker_unit_state running 1; then exit 1; fi

  if wait_for_docker_unit_state unsafe 1 >/dev/null 2>&1; then exit 1; fi
  if wait_for_docker_unit_state running 0 >/dev/null 2>&1; then exit 1; fi
' _ "${installer_unit_settled_flow}" "${installer_wait_unit_flow}" || \
  fail 'Docker perimeter installer systemd state-poll harness failed'

bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  eval "$4"
  mock_jobs=""
  restart_command_ok=true
  stop_command_ok=true
  running_wait_ok=true
  stopped_wait_ok=true
  restart_calls=0
  stop_calls=0
  running_wait_calls=0
  stopped_wait_calls=0
  docker_transition_settled=false
  systemctl_bounded() {
    case "$1" in
      list-jobs) printf "%s" "${mock_jobs}" ;;
      restart) restart_calls=$((restart_calls + 1)); [[ "${restart_command_ok}" == true ]] ;;
      stop) stop_calls=$((stop_calls + 1)); [[ "${stop_command_ok}" == true ]] ;;
      *) return 1 ;;
    esac
  }
  wait_for_docker_unit_state() {
    case "$1" in
      running)
        running_wait_calls=$((running_wait_calls + 1))
        [[ "${running_wait_ok}" == true ]]
        ;;
      stopped)
        stopped_wait_calls=$((stopped_wait_calls + 1))
        [[ "${stopped_wait_ok}" == true ]]
        ;;
      *) return 1 ;;
    esac
  }

  settle_docker_for_recovery
  [[ "${docker_transition_settled}" == true && "${stop_calls}" == 0 ]]

  mock_jobs="1 docker.service restart running"
  docker_transition_settled=false
  settle_docker_for_recovery
  [[ "${docker_transition_settled}" == true && "${stop_calls}" == 1 && \
    "${stopped_wait_calls}" == 1 ]]

  stop_command_ok=false
  docker_transition_settled=true
  if settle_docker_for_recovery >/dev/null 2>&1; then exit 1; fi
  [[ "${docker_transition_settled}" == false && "${stop_calls}" == 2 ]]

  mock_jobs=""
  stop_command_ok=true
  restart_command_ok=true
  running_wait_ok=true
  docker_transition_settled=false
  restart_docker_service
  [[ "${docker_transition_settled}" == true && "${restart_calls}" == 1 ]]

  running_wait_ok=false
  stopped_wait_ok=true
  restart_status=0
  restart_docker_service || restart_status=$?
  [[ "${restart_status}" == 1 && "${docker_transition_settled}" == true && \
    "${restart_calls}" == 2 && "${stop_calls}" == 3 ]]

  stop_command_ok=false
  docker_transition_settled=true
  restart_status=0
  restart_docker_service || restart_status=$?
  [[ "${restart_status}" == 1 && "${docker_transition_settled}" == false && \
    "${restart_calls}" == 3 && "${stop_calls}" == 4 ]]

  restart_command_ok=false
  stop_command_ok=true
  stopped_wait_ok=true
  docker_transition_settled=false
  restart_status=0
  restart_docker_service || restart_status=$?
  [[ "${restart_status}" == 1 && "${docker_transition_settled}" == true && \
    "${restart_calls}" == 4 && "${stop_calls}" == 5 ]]
' _ "${installer_unit_settled_flow}" "${installer_settle_failed_flow}" \
  "${installer_settle_recovery_flow}" "${installer_restart_service_flow}" || \
  fail 'Docker perimeter installer settled-transition harness failed'

bash -c '
  set -Eeuo pipefail
  eval "$1"
  marker_current_release=20981231T235959Z
  marker_phase=rollback
  mock_current_release=${marker_current_release}
  other_recovery=false
  settle_ok=true
  config_safe=false
  runtime_safe=false
  stable_safe=false
  install_ok=true
  restart_ok=false
  restore_ok=true
  install_calls=0
  restart_calls=0
  restore_calls=0
  retire_calls=0
  settle_calls=0
  read_current_release() { printf "%s\n" "${mock_current_release}"; }
  assert_no_other_recovery_intents() { [[ "${other_recovery}" == false ]]; }
  settle_docker_for_recovery() { settle_calls=$((settle_calls + 1)); [[ "${settle_ok}" == true ]]; }
  config_matches_source() { [[ "${config_safe}" == true ]]; }
  docker_runtime_is_available() { [[ "${runtime_safe}" == true ]]; }
  verify_safe_runtime_stable() { [[ "${stable_safe}" == true ]]; }
  install_source_config() { install_calls=$((install_calls + 1)); [[ "${install_ok}" == true ]]; }
  restart_and_verify_safe_config() { restart_calls=$((restart_calls + 1)); [[ "${restart_ok}" == true ]]; }
  restore_absent_config() { restore_calls=$((restore_calls + 1)); [[ "${restore_ok}" == true ]]; }
  retire_recovery_marker() { retire_calls=$((retire_calls + 1)); }
  log() { :; }

  recovery_status=0
  recover_armed_perimeter || recovery_status=$?
  [[ "${recovery_status}" == 2 && "${restore_calls}" == 1 && \
    "${install_calls}" == 0 && "${restart_calls}" == 0 && \
    "${retire_calls}" == 0 && "${settle_calls}" == 1 ]]

  marker_phase=install
  restore_calls=0
  recovery_status=0
  recover_armed_perimeter || recovery_status=$?
  [[ "${recovery_status}" == 2 && "${install_calls}" == 1 && \
    "${restart_calls}" == 1 && "${restore_calls}" == 1 && "${settle_calls}" == 2 ]]

  config_safe=true
  runtime_safe=true
  stable_safe=true
  restart_ok=true
  recovery_status=0
  recover_armed_perimeter || recovery_status=$?
  [[ "${recovery_status}" == 0 && "${retire_calls}" == 1 && \
    "${install_calls}" == 1 && "${restart_calls}" == 1 && "${settle_calls}" == 3 ]]

  mock_current_release=20970101T000000Z
  recovery_status=0
  recover_armed_perimeter || recovery_status=$?
  [[ "${recovery_status}" == 1 && "${retire_calls}" == 1 && \
    "${install_calls}" == 1 && "${restart_calls}" == 1 && \
    "${restore_calls}" == 1 && "${settle_calls}" == 3 ]]

  mock_current_release=${marker_current_release}
  other_recovery=true
  recovery_status=0
  recover_armed_perimeter || recovery_status=$?
  [[ "${recovery_status}" == 1 && "${settle_calls}" == 3 && \
    "${restore_calls}" == 1 ]]

  other_recovery=false
  settle_ok=false
  marker_phase=rollback
  recovery_status=0
  recover_armed_perimeter || recovery_status=$?
  [[ "${recovery_status}" == 1 && "${settle_calls}" == 4 && \
    "${restore_calls}" == 1 && "${install_calls}" == 1 ]]
' _ "${installer_recovery_flow}" || \
  fail 'Docker perimeter installer rollback-retry harness failed'

bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  config_directory="${harness_root}"
  target_config="${harness_root}/daemon.json"
  target_config_next="${harness_root}/daemon.json.next"
  marker_phase=rollback
  docker_transition_settled=false
  current_daemon_pid=""
  persist_calls=0
  restart_calls=0
  health_calls=0
  retire_calls=0
  printf "safe\n" >"${target_config}"

  persist_recovery_phase() { persist_calls=$((persist_calls + 1)); marker_phase=$1; }
  staged_config_matches_source() { return 1; }
  staged_config_is_discardable() { return 1; }
  config_matches_source() { [[ -f "${target_config}" && "$(<"${target_config}")" == safe ]]; }
  unlink() { command rm -f -- "$2"; }
  sync() { :; }
  restart_docker_service() {
    restart_calls=$((restart_calls + 1))
    (( restart_calls >= 2 ))
  }
  wait_for_docker() { :; }
  assert_docker_cli_local_contract() { :; }
  assert_minimum_docker_engine() { :; }
  capture_current_daemon() { current_daemon_pid=4242; }
  verify_current_application_recovered() { health_calls=$((health_calls + 1)); }
  retire_recovery_marker() { retire_calls=$((retire_calls + 1)); }

  restore_status=0
  restore_absent_config || restore_status=$?
  [[ "${restore_status}" == 1 && -f "${target_config}" && \
    "${persist_calls}" == 0 && "${restart_calls}" == 0 && "${retire_calls}" == 0 ]]

  docker_transition_settled=true
  restore_status=0
  restore_absent_config || restore_status=$?
  [[ "${restore_status}" == 1 && ! -e "${target_config}" && \
    "${persist_calls}" == 1 && "${restart_calls}" == 1 && \
    "${health_calls}" == 0 && "${retire_calls}" == 0 ]]

  restore_status=0
  restore_absent_config || restore_status=$?
  [[ "${restore_status}" == 0 && ! -e "${target_config}" && \
    "${persist_calls}" == 2 && "${restart_calls}" == 2 && \
    "${health_calls}" == 1 && "${retire_calls}" == 1 ]]
' _ "${installer_restore_flow}" || \
  fail 'Docker perimeter installer durable rollback harness failed'

host_preflight_script="${project_root}/deploy/standalone/scripts/host-preflight.sh"
provision_host_script="${project_root}/deploy/standalone/scripts/provision-host.sh"
docker_daemon_perimeter_script="${project_root}/deploy/standalone/scripts/docker-daemon-perimeter.sh"
docker_daemon_config="${project_root}/deploy/standalone/docker/daemon.json"
docker_cli_config="${project_root}/deploy/standalone/docker-cli/config.json"
[[ -f "${docker_daemon_perimeter_script}" && ! -L "${docker_daemon_perimeter_script}" ]] || \
  fail 'shared Docker daemon perimeter guard is missing or symlinked'
[[ -f "${docker_daemon_config}" && ! -L "${docker_daemon_config}" ]] || \
  fail 'versioned Docker daemon perimeter config is missing or symlinked'
[[ -f "${docker_cli_config}" && ! -L "${docker_cli_config}" ]] || \
  fail 'versioned Docker CLI config is missing or symlinked'
jq -e '
  (keys | sort) == ["allow-direct-routing", "ip6tables", "iptables"]
  and .["allow-direct-routing"] == false
  and .iptables == true
  and .ip6tables == true
' "${docker_daemon_config}" >/dev/null || \
  fail 'versioned Docker daemon perimeter config is not the exact safe baseline'
jq -e 'type == "object" and length == 0' "${docker_cli_config}" >/dev/null || \
  fail 'versioned Docker CLI config must be an exact empty object'
for required_provision_docker_contract in \
  'assert_no_docker_cli_target_overrides() {' \
  '[[ -z "${DOCKER_HOST+x}" ]]' \
  '[[ -z "${DOCKER_CONTEXT+x}" ]]' \
  '[[ -z "${DOCKER_CONFIG+x}" ]]' \
  'env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG' \
  '/usr/bin/docker' \
  '--config "${docker_cli_config_directory}"' \
  '--host unix:///run/docker.sock' \
  'assert_no_docker_cli_target_overrides' \
  'local_docker version' \
  'local_docker compose version'; do
  grep -Fq -- "${required_provision_docker_contract}" "${provision_host_script}" || \
    fail "host provision local Docker CLI contract is missing: ${required_provision_docker_contract}"
done
provision_override_line="$(awk '$0 == "assert_no_docker_cli_target_overrides" { print NR; exit }' \
  "${provision_host_script}")"
provision_mode_line="$(awk 'index($0, "if [[ \"${apply}\" != true ]]") { print NR; exit }' \
  "${provision_host_script}")"
[[ "${provision_override_line}" =~ ^[0-9]+$ && "${provision_mode_line}" =~ ^[0-9]+$ && \
  "${provision_override_line}" -lt "${provision_mode_line}" ]] || \
  fail 'host provision must reject ambient Docker targeting before check/apply dispatch'
provision_override_flow="$(sed -n \
  '/^assert_no_docker_cli_target_overrides() {$/,/^}$/p' "${provision_host_script}")"
provision_local_docker_flow="$(sed -n '/^local_docker() {$/,/^}$/p' \
  "${provision_host_script}")"
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  docker_cli_config_directory="${harness_root}/docker-cli"
  invocation_log="${harness_root}/invocation"
  fail() { exit 91; }
  env() {
    [[ "$1" == -u && "$2" == DOCKER_HOST && \
      "$3" == -u && "$4" == DOCKER_CONTEXT && \
      "$5" == -u && "$6" == DOCKER_CONFIG && \
      "$7" == /usr/bin/docker && \
      "$8" == --config && "$9" == "${docker_cli_config_directory}" && \
      "${10}" == --host && "${11}" == unix:///run/docker.sock ]]
    shift 11
    printf "%s\n" "$*" >"${invocation_log}"
  }

  assert_no_docker_cli_target_overrides
  for override_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG; do
    if (export "${override_name}=remote"; \
      assert_no_docker_cli_target_overrides) >/dev/null 2>&1; then
      exit 1
    fi
  done
  DOCKER_HOST=tcp://attacker.example:2375 \
    DOCKER_CONTEXT=remote \
    DOCKER_CONFIG=/tmp/attacker \
    local_docker version --format server
  [[ "$(<"${invocation_log}")" == "version --format server" ]]
' _ "${provision_override_flow}" "${provision_local_docker_flow}" || \
  fail 'host provision pinned local Docker CLI harness failed'
for required_docker_cli_contract in \
  'perimeter_systemctl() {' \
  'perimeter_ss() {' \
  'perimeter_dockerd_validate() {' \
  'docker() {' \
  'env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG' \
  '/usr/bin/docker' \
  '--config "${docker_cli_config_directory}"' \
  '--host unix:///run/docker.sock' \
  'assert_no_docker_cli_target_overrides' \
  '[[ -S /run/docker.sock && ! -L /run/docker.sock ]]' \
  'validate_docker_cli_config "${config_json}"'; do
  grep -Fq -- "${required_docker_cli_contract}" "${docker_daemon_perimeter_script}" || \
    fail "pinned local Docker CLI contract is missing: ${required_docker_cli_contract}"
done
for required_host_edge_contract in \
  "readonly minimum_docker_version='28.0.0'" \
  "readonly compose_project='cometa-bank'" \
  'readonly live_nginx_config="${deploy_root}/state/nginx/default.conf"' \
  "readonly domain='euphoria.bot'" \
  "readonly www_domain='www.euphoria.bot'" \
  "readonly inner_tls_endpoint='127.0.0.1:8443'" \
  "readonly inner_tls_timeout_seconds='8'" \
  "readonly minimum_certificate_validity_seconds='1814400'" \
  '(($proxies[0].transport.tls.insecure_skip_verify // false) == false)' \
  'all($servers[]; .protocols == ["h1", "h2"])' \
  '(.name == "cometa-bank")' \
  '(.services | keys | sort) == ["bot", "certbot", "web"]' \
  '.name == "cometa-bank"' \
  '(.services.web.networks | keys | sort) == ["edge", "public"]' \
  '(.services.bot.networks | keys | sort) == ["edge", "egress"]' \
  '(.services.certbot.networks | keys | sort) == ["egress"]' \
  '(.networks | keys | sort) == ["edge", "egress", "public"]' \
  'and ((.ipam // {}) == {}))' \
  'select((.value.network_mode // "") != "")' \
  "docker inspect --format '{{.HostConfig.NetworkMode}}'" \
  "docker inspect --format '{{json .NetworkSettings.Networks}}'" \
  'network_names="$(docker network ls --format '\''{{.Name}}'\'')"' \
  'network_json="$(docker network inspect --format '\''{{json .}}'\'' "${network_name}")"' \
  '.Driver == "bridge"' \
  '.Scope == "local"' \
  '.IPAM.Driver == "default"' \
  '((.IPAM.Options // {}) == {})' \
  '.EnableIPv4 == true' \
  '.EnableIPv6 == false' \
  '(.IPAM.Config | type == "array" and length == 1)' \
  '.Labels["com.docker.compose.project"] == "cometa-bank"' \
  '.Options == {"com.docker.network.bridge.enable_icc": $expected_icc}' \
  "listeners=\"\$(ss -H -lunp 'sport = :443')\"" \
  'for command_name in awk caddy curl date docker dockerd env getent jq openssl sha256sum sshd ss stat systemctl timeout tr ufw; do' \
  'source "${script_dir}/docker-daemon-perimeter.sh"' \
  'assert_docker_cli_local_contract' \
  'check_docker_daemon_perimeter_contract' \
  'check_nginx_real_ip_contract' \
  'check_compose_release_topology' \
  'check_running_service_port_bindings' \
  'check_running_service_network_topology' \
  'check_udp_listeners'; do
  grep -Fq -- "${required_host_edge_contract}" "${host_preflight_script}" || \
    fail "host preflight edge contract is missing: ${required_host_edge_contract}"
done

host_version_flow="$(sed -n '/^version_at_least() {$/,/^}$/p' \
  "${host_preflight_script}")"
[[ -n "${host_version_flow}" ]] || fail 'host preflight version comparator is missing'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  version_at_least 28.0.0 28.0.0
  version_at_least 28.0.1 28.0.0
  version_at_least 29.0.0 28.0.0
  if version_at_least 27.5.1 28.0.0; then exit 1; fi
  if version_at_least 27.99.99 28.0.0; then exit 1; fi
' _ "${host_version_flow}" || \
  fail 'host preflight Docker 28 security boundary harness failed'

docker_cli_config_flow="$(sed -n \
  '/^validate_docker_cli_config() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
docker_cli_override_flow="$(sed -n \
  '/^assert_no_docker_cli_target_overrides() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
docker_socket_metadata_flow="$(sed -n \
  '/^validate_docker_socket_metadata() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
docker_config_start_flow="$(sed -n \
  '/^validate_docker_config_start_binding() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
docker_socket_listener_flow="$(sed -n \
  '/^validate_docker_socket_listener() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
[[ -n "${docker_cli_config_flow}" && -n "${docker_cli_override_flow}" && \
  -n "${docker_socket_metadata_flow}" && -n "${docker_config_start_flow}" && \
  -n "${docker_socket_listener_flow}" ]] || \
  fail 'pinned local Docker CLI value guards are missing'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  eval "$4"
  eval "$5"
  fail() { exit 91; }
  validate_docker_cli_config '\''{}'\''
  for unsafe_config in \
    '\''{"currentContext":"remote"}'\'' \
    '\''{"credsStore":"desktop"}'\'' \
    '\''[]'\''; do
    if (validate_docker_cli_config "${unsafe_config}") >/dev/null 2>&1; then
      exit 1
    fi
  done
  assert_no_docker_cli_target_overrides
  for override_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG; do
    if (export "${override_name}=attacker"; \
      assert_no_docker_cli_target_overrides) >/dev/null 2>&1; then
      exit 1
    fi
  done

  validate_docker_socket_metadata "0:986:docker:660"
  validate_docker_socket_metadata "0:0:root:600"
  for unsafe_metadata in \
    "0:986:docker:666" \
    "1000:986:docker:660" \
    "0:1000:root:660" \
    "0:986:wheel:660"; do
    if (validate_docker_socket_metadata \
      "${unsafe_metadata}") >/dev/null 2>&1; then
      exit 1
    fi
  done

  validate_docker_config_start_binding 100 101 200
  if (validate_docker_config_start_binding 100 201 200) >/dev/null 2>&1; then
    exit 1
  fi
  if (validate_docker_config_start_binding 200 100 200) >/dev/null 2>&1; then
    exit 1
  fi

  valid_listener='\''u_str LISTEN 0 4096 /run/docker.sock 11937 * 0 users:(("dockerd",pid=1009,fd=5),("systemd",pid=1,fd=89))'\''
  validate_docker_socket_listener "${valid_listener}" 1009
  reverse_listener='\''u_str LISTEN 0 4096 /run/docker.sock 11937 * 0 users:(("systemd",pid=1,fd=89),("dockerd",pid=1009,fd=5))'\''
  validate_docker_socket_listener "${reverse_listener}" 1009
  live_listener='\''u_str LISTEN 0      4096 /run/docker.sock 11937 * 0 users:(("dockerd",pid=1009,fd=5),("systemd",pid=1,fd=238))'\''
  validate_docker_socket_listener "${live_listener}       " 1009
  printf -v tab_listener "%s\t  " "${reverse_listener}"
  validate_docker_socket_listener "${tab_listener}" 1009
  printf -v multiline_listener "%s\n%s" "${valid_listener}" "${reverse_listener}"
  for unsafe_listener in \
    "${valid_listener} unexpected" \
    "${valid_listener} users:((\"proxy\",pid=50,fd=4))" \
    "${multiline_listener}" \
    '\''u_str LISTEN 0 4096 /run/docker.sock 11937 * 0 users:(("dockerd",pid=2000,fd=5),("systemd",pid=1,fd=89))'\'' \
    '\''u_str LISTEN 0 4096 /run/docker.sock 11937 * 0 users:(("proxy",pid=50,fd=4),("dockerd",pid=1009,fd=5),("systemd",pid=1,fd=89))'\''; do
    if (validate_docker_socket_listener \
      "${unsafe_listener}" 1009) >/dev/null 2>&1; then
      exit 1
    fi
  done
' _ "${docker_cli_config_flow}" "${docker_cli_override_flow}" \
  "${docker_socket_metadata_flow}" "${docker_config_start_flow}" \
  "${docker_socket_listener_flow}" || \
  fail 'pinned local Docker CLI target harness failed'

docker_socket_snapshot_flow="$(sed -n \
  '/^docker_socket_listener_for_pid() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  printf "systemd\n" >"${harness_root}/pid-one-comm"
  snapshot_flow=${2//\/proc\/1\/comm/${harness_root}/pid-one-comm}
  eval "${snapshot_flow}"
  fail() { exit 91; }
  perimeter_systemctl() {
    case "$*" in
      "show --property ActiveState --value docker.socket") printf "active\n" ;;
      "is-enabled docker.socket") printf "enabled\n" ;;
      "show --property Listen --value docker.socket") printf "/run/docker.sock (Stream)\n" ;;
      *) exit 92 ;;
    esac
  }
  perimeter_ss() {
    [[ "$*" == "-H -lxnp" ]] || exit 93
    printf "%s\n" "${mock_listeners}"
  }
  owner_line='\''u_str LISTEN 0      4096 /run/docker.sock 11937 * 0 users:(("dockerd",pid=1009,fd=5),("systemd",pid=1,fd=238))'\''
  canonical_line=${owner_line/0      4096/0 4096}
  mock_listeners="${owner_line}       "
  socket_listener_before="$(docker_socket_listener_for_pid 1009)" || exit 1
  printf -v mock_listeners "%s\t  " "${owner_line}"
  socket_listener_after="$(docker_socket_listener_for_pid 1009)" || exit 1
  [[ "${socket_listener_before}" == "${canonical_line}" && \
    "${socket_listener_after}" == "${socket_listener_before}" ]] || exit 1

  mock_listeners=${owner_line/fd=5/fd=6}
  changed_listener="$(docker_socket_listener_for_pid 1009)" || exit 1
  [[ "${changed_listener}" == "${canonical_line/fd=5/fd=6}" && \
    "${changed_listener}" != "${socket_listener_before}" ]] || exit 1
  mock_listeners=${owner_line/0      4096/0 4096}
  changed_listener="$(docker_socket_listener_for_pid 1009)" || exit 1
  [[ "${changed_listener}" == "${mock_listeners}" && \
    "${changed_listener}" == "${socket_listener_before}" ]] || exit 1

  printf -v duplicate_listeners "%s\n%s" "${owner_line}" "${owner_line}"
  for mock_listeners in \
    "${owner_line/pid=1009/pid=2000}" \
    "${owner_line} users:((\"proxy\",pid=50,fd=4))" \
    "${owner_line} unexpected" \
    "${duplicate_listeners}"; do
    if (docker_socket_listener_for_pid 1009) >/dev/null 2>&1; then exit 1; fi
  done
' _ "${docker_socket_listener_flow}" "${docker_socket_snapshot_flow}" || \
  fail 'Docker socket snapshot padding stability harness failed'

host_daemon_config_path_flow="$(sed -n \
  '/^docker_daemon_config_path_from_args() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
host_daemon_process_values_flow="$(sed -n \
  '/^validate_docker_daemon_process_values() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
host_daemon_config_values_flow="$(sed -n \
  '/^validate_docker_daemon_config_values() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
host_daemon_values_flow="$(sed -n \
  '/^validate_docker_daemon_perimeter_values() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
host_daemon_contract_flow="$(sed -n \
  '/^check_docker_daemon_perimeter_contract() {$/,/^}$/p' "${docker_daemon_perimeter_script}")"
for host_daemon_flow in \
  "${host_daemon_config_path_flow}" \
  "${host_daemon_process_values_flow}" \
  "${host_daemon_config_values_flow}" \
  "${host_daemon_values_flow}" \
  "${host_daemon_contract_flow}"; do
  [[ -n "${host_daemon_flow}" ]] || fail 'Docker daemon perimeter function is missing'
done
for required_daemon_contract in \
  '[[ "${daemon_pid_before}" =~ ^[0-9]+$ ]]' \
  '"/proc/${daemon_pid_before}/comm"' \
  '"/proc/${daemon_pid_before}/cmdline"' \
  '"/proc/${daemon_pid_before}/environ"' \
  '[[ "${daemon_comm}" == '\''dockerd'\'' ]]' \
  '[[ -f "${config_path}" && ! -L "${config_path}" ]]' \
  '[[ "${config_owner}" == '\''0'\'' ]]' \
  '(( (8#${config_mode} & 022) == 0 ))' \
  'validate_docker_config_start_binding' \
  '"${config_mtime}" "${config_ctime}" "${daemon_started_epoch}"' \
  'socket_listener_before="$(docker_socket_listener_for_pid "${daemon_pid_before}")"' \
  'socket_listener_after="$(docker_socket_listener_for_pid "${daemon_pid_after}")"' \
  'jq -ces '\''' \
  'perimeter_dockerd_validate "${config_path}"' \
  '[[ "${config_hash_before}" == "${config_hash_after}"' \
  '"${config_stat_before}" == "${config_stat_after}"' \
  '"${config_directory_stat_before}" == "${config_directory_stat_after}" ]]' \
  '[[ "${daemon_pid_after}" == "${daemon_pid_before}" ]]'; do
  grep -Fq -- "${required_daemon_contract}" <<<"${host_daemon_contract_flow}" || \
    fail "effective Docker daemon perimeter guard is missing: ${required_daemon_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  eval "$4"
  fail() { exit 91; }

  safe_cmdline=$'\''/usr/bin/dockerd\n-H\nfd://\n--allow-direct-routing=false\n--iptables=true\n--ip6tables=1'\''
  safe_config='\''{"allow-direct-routing":false,"iptables":true,"ip6tables":true}'\''
  validate_docker_daemon_perimeter_values "${safe_cmdline}" "" "${safe_config}"
  validate_docker_daemon_perimeter_values \
    $'\''/usr/bin/dockerd\n-H=fd://\n--iptables\n--ip6tables\n--bridge-accept-fwmark='\'' \
    "" "${safe_config}"

  for unsafe_cmdline in \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--allow-direct-routing'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--allow-direct-routing=true'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--iptables=false'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--ip6tables=0'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--bridge-accept-fwmark=0x1/0x3'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--bridge-accept-fwmark'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--default-network-opt=bridge=com.docker.network.bridge.gateway_mode_ipv4=routed'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--default-network-opt\nbridge=com.docker.network.bridge.trusted_host_interfaces=eth0'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n--iptables=maybe'\'' \
    $'\''/usr/bin/dockerd\n-H\ntcp://127.0.0.1:2375'\'' \
    $'\''/usr/bin/dockerd\n-H\ntcp://0.0.0.0:2375'\'' \
    $'\''/usr/bin/dockerd\n-H\nfd://\n-H\ntcp://127.0.0.1:2375'\'' \
    $'\''/usr/bin/dockerd'\''; do
    if (validate_docker_daemon_perimeter_values \
      "${unsafe_cmdline}" "" "${safe_config}") >/dev/null 2>&1; then
      exit 1
    fi
  done
  if (validate_docker_daemon_perimeter_values $'\''/usr/bin/dockerd\n-H\nfd://'\'' \
    "DOCKER_INSECURE_NO_IPTABLES_RAW=0" "${safe_config}") >/dev/null 2>&1; then
    exit 1
  fi
  for unsafe_config in \
    '\''{"allow-direct-routing":true,"iptables":true,"ip6tables":true}'\'' \
    '\''{"allow-direct-routing":false,"iptables":false,"ip6tables":true}'\'' \
    '\''{"allow-direct-routing":false,"iptables":true,"ip6tables":false}'\'' \
    '\''{"allow-direct-routing":false,"iptables":true,"ip6tables":true,"bridge-accept-fwmark":"1"}'\'' \
    '\''{"allow-direct-routing":false,"iptables":true,"ip6tables":true,"default-network-opts":{"bridge":{"com.docker.network.bridge.gateway_mode_ipv4":"routed"}}}'\'' \
    '\''{"allow-direct-routing":false,"iptables":"true","ip6tables":true}'\'' \
    '\''{}'\''; do
    if (validate_docker_daemon_perimeter_values $'\''/usr/bin/dockerd\n-H\nfd://'\'' \
      "" "${unsafe_config}") >/dev/null 2>&1; then
      exit 1
    fi
  done

  [[ "$(docker_daemon_config_path_from_args "/usr/bin/dockerd")" == \
    $'\''false\t/etc/docker/daemon.json'\'' ]]
  [[ "$(docker_daemon_config_path_from_args \
    $'\''/usr/bin/dockerd\n--config-file\n/etc/docker/secure.json'\'')" == \
    $'\''true\t/etc/docker/secure.json'\'' ]]
  [[ "$(docker_daemon_config_path_from_args \
    $'\''/usr/bin/dockerd\n-c=/etc/docker/secure.json'\'')" == \
    $'\''true\t/etc/docker/secure.json'\'' ]]
  for unsafe_path_args in \
    $'\''/usr/bin/dockerd\n--config-file'\'' \
    $'\''/usr/bin/dockerd\n--config-file=relative.json'\'' \
    $'\''/usr/bin/dockerd\n--config-file=/etc/docker/../unsafe.json'\'' \
    $'\''/usr/bin/dockerd\n-c=/etc/docker/a.json\n--config-file=/etc/docker/b.json'\''; do
    if (docker_daemon_config_path_from_args \
      "${unsafe_path_args}") >/dev/null 2>&1; then
      exit 1
    fi
  done
' _ "${host_daemon_config_path_flow}" "${host_daemon_process_values_flow}" \
  "${host_daemon_config_values_flow}" "${host_daemon_values_flow}" || \
  fail 'effective Docker daemon perimeter value harness failed'
host_daemon_call_line="$(awk '$0 == "check_docker_daemon_perimeter_contract" { print NR }' \
  "${host_preflight_script}")"
host_compose_render_line="$(awk 'index($0, "COMETA_RELEASE_ID='\''host-preflight'\''") { print NR }' \
  "${host_preflight_script}")"
[[ "${host_daemon_call_line}" =~ ^[0-9]+$ && \
  "${host_compose_render_line}" =~ ^[0-9]+$ && \
  "${host_daemon_call_line}" -lt "${host_compose_render_line}" ]] || \
  fail 'effective Docker daemon perimeter must pass before Compose topology probes'

host_tcp_listener_flow="$(sed -n '/^check_tcp_listeners() {$/,/^}$/p' \
  "${host_preflight_script}")"
host_caddy_listener_owner_flow="$(sed -n '/^validate_caddy_listener_owner() {$/,/^}$/p' \
  "${host_preflight_script}")"
host_caddy_admin_flow="$(sed -n '/^check_caddy_admin_socket() {$/,/^}$/p' \
  "${host_preflight_script}")"
[[ -n "${host_tcp_listener_flow}" && -n "${host_caddy_listener_owner_flow}" ]] || \
  fail 'host TCP listener guard is missing'
grep -Fq 'listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s ss -H -lntp)" ||' \
  <<<"${host_tcp_listener_flow}" || \
  fail 'host TCP listener guard must capture and check ss status before parsing'
for required_host_admin_contract in \
  '[[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]]' \
  'caddy:caddy:200' \
  'validate_caddy_listener_owner "${line}" "${pid}"' \
  '[[ -z "${tcp_admin_listeners}" ]]' \
  '[[ "${confirmed_pid}" == "${pid}" ]]' \
  'caddy adapt --config "${caddy_config}" --adapter caddyfile' \
  '--unix-socket "${caddy_admin_socket}"' \
  "'http://localhost/config/'" \
  '[[ "${expected_config}" == "${live_config}" ]]'; do
  grep -Fq -- "${required_host_admin_contract}" <<<"${host_caddy_admin_flow}" || \
    fail "host Caddy admin/live-config contract is missing: ${required_host_admin_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  expected_ssh_port=22
  fail() { exit 91; }
  mock_ss_fail=false
  timeout() { shift 4; "$@"; }
  pid_epoch_file="${harness_root}/pid-epoch"
  mock_pid_before=4242
  mock_pid_after=4242
  reset_pid_epoch() { printf "0\n" >"${pid_epoch_file}"; }
  caddy_service_pid() {
    local count
    count="$(<"${pid_epoch_file}")"
    count=$((count + 1))
    printf "%s\n" "${count}" >"${pid_epoch_file}"
    if (( count == 1 )); then
      printf "%s\n" "${mock_pid_before}"
    else
      printf "%s\n" "${mock_pid_after}"
    fi
  }
  ss() {
    printf "%s\n" "${mock_listeners}"
    [[ "${mock_ss_fail}" != true ]]
  }

  printf -v valid_listeners "%s\n%s\n%s" \
    '\''LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))'\'' \
    '\''LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=4242,fd=4))'\'' \
    '\''LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=4242,fd=5))'\''
  mock_listeners=${valid_listeners}
  reset_pid_epoch
  check_tcp_listeners

  reset_pid_epoch
  mock_ss_fail=true
  if (check_tcp_listeners) >/dev/null 2>&1; then exit 1; fi
  mock_ss_fail=false

  for invalid_kind in wrong-pid foreign-extra multi-owner pid-epoch; do
    mock_pid_after=4242
    case "${invalid_kind}" in
      wrong-pid)
        mock_listeners="${valid_listeners/pid=4242,fd=4/pid=4343,fd=4}"
        ;;
      foreign-extra)
        printf -v mock_listeners "%s\n%s" "${valid_listeners}" \
          '\''LISTEN 0 4096 [::]:443 [::]:* users:(("nginx",pid=8,fd=8))'\''
        ;;
      multi-owner)
        mock_listeners="${valid_listeners/pid=4242,fd=5/pid=4242,fd=5),(\"systemd\",pid=1,fd=9}"
        ;;
      pid-epoch)
        mock_listeners=${valid_listeners}
        mock_pid_after=4343
        ;;
    esac
    reset_pid_epoch
    if (check_tcp_listeners) >/dev/null 2>&1; then exit 1; fi
  done
' _ "${host_tcp_listener_flow}" "${host_caddy_listener_owner_flow}" || \
  fail 'host TCP listener partial-output failure harness failed'

host_compose_topology_flow="$(sed -n '/^check_compose_release_topology() {$/,/^}$/p' \
  "${host_preflight_script}")"
host_docker_network_flow="$(sed -n '/^check_docker_network_contract() {$/,/^}$/p' \
  "${host_preflight_script}")"
host_runtime_network_flow="$(sed -n '/^check_running_service_network_topology() {$/,/^}$/p' \
  "${host_preflight_script}")"
host_runtime_binding_flow="$(sed -n '/^check_running_service_port_bindings() {$/,/^}$/p' \
  "${host_preflight_script}")"
for host_network_flow in \
  "${host_compose_topology_flow}" \
  "${host_docker_network_flow}" \
  "${host_runtime_network_flow}" \
  "${host_runtime_binding_flow}"; do
  [[ -n "${host_network_flow}" ]] || fail 'host preflight network topology function is missing'
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  fail() { exit 91; }
  valid_compose='\''{
    "name":"cometa-bank",
    "services":{
      "web":{"ports":[
        {"host_ip":"127.0.0.1","target":8080,"published":"8080","protocol":"tcp","mode":"ingress"},
        {"host_ip":"127.0.0.1","target":8443,"published":"8443","protocol":"tcp","mode":"ingress"}
      ],"networks":{"edge":null,"public":null}},
      "bot":{"networks":{"edge":{"aliases":["cometa-bank-bot"]},"egress":{}}},
      "certbot":{"networks":{"egress":{}}}
    },
    "networks":{
      "edge":{"name":"cometa-bank_edge","driver":"bridge","internal":true,"driver_opts":{"com.docker.network.bridge.enable_icc":"true"},"ipam":{}},
      "egress":{"name":"cometa-bank_egress","driver":"bridge","driver_opts":{"com.docker.network.bridge.enable_icc":"false"},"ipam":{}},
      "public":{"name":"cometa-bank_public","driver":"bridge","driver_opts":{"com.docker.network.bridge.enable_icc":"false"},"ipam":{}}
    }
  }'\''
  check_compose_release_topology "${valid_compose}"
  for mutation in \
    '\''.name = "other-project"'\'' \
    '\''.services.bot.network_mode = "host"'\'' \
    '\''.services.web.networks.egress = {}'\'' \
    '\''.networks.public.driver = "macvlan"'\'' \
    '\''.networks.public.enable_ipv4 = false'\'' \
    '\''.networks.public.enable_ipv6 = true'\'' \
    '\''.networks.egress.ipam = {"driver":"default","config":[{"subnet":"10.55.0.0/24"}]}'\''; do
    invalid_compose="$(jq -c "${mutation}" <<<"${valid_compose}")"
    if (check_compose_release_topology "${invalid_compose}" >/dev/null 2>&1); then
      exit 1
    fi
  done
' _ "${host_compose_topology_flow}" || \
  fail 'host preflight rendered Compose topology harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  network_inspect_log="${harness_root}/network-inspect.log"
  : >"${network_inspect_log}"
  compose_project=cometa-bank
  mock_web_ids=aaaaaaaaaaaa
  mock_bot_ids=bbbbbbbbbbbb
  mock_web_network_mode=cometa-bank_edge
  mock_bot_network_mode=cometa-bank_edge
  mock_web_networks='\''{"cometa-bank_edge":{},"cometa-bank_public":{}}'\''
  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{}}'\''
  mock_web_bindings='\''{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}],"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}'\''
  mock_bot_bindings='\''{}'\''
  mock_edge_driver=bridge
  mock_edge_gateway_mode=
  mock_edge_ipam_driver=default
  mock_enable_ipv6=false
  mock_ipam_subnet=172.30.0.0/16
  mock_ipam_gateway=172.30.0.1
  fail() { exit 91; }
  docker() {
    case "$1" in
      ps)
        if [[ "$*" == *"service=web"* ]]; then
          printf "%s\n" "${mock_web_ids}"
        elif [[ "$*" == *"service=bot"* ]]; then
          printf "%s\n" "${mock_bot_ids}"
        else
          return 1
        fi
        ;;
      inspect)
        case "${3:-}" in
          "{{.HostConfig.NetworkMode}}")
            case "${4:-}" in
              aaaaaaaaaaaa) printf "%s\n" "${mock_web_network_mode}" ;;
              bbbbbbbbbbbb) printf "%s\n" "${mock_bot_network_mode}" ;;
              *) return 1 ;;
            esac
            ;;
          "{{json .NetworkSettings.Networks}}")
            case "${4:-}" in
              aaaaaaaaaaaa) printf "%s\n" "${mock_web_networks}" ;;
              bbbbbbbbbbbb) printf "%s\n" "${mock_bot_networks}" ;;
              *) return 1 ;;
            esac
            ;;
          "{{json .HostConfig.PortBindings}}")
            case "${4:-}" in
              aaaaaaaaaaaa) printf "%s\n" "${mock_web_bindings}" ;;
              bbbbbbbbbbbb) printf "%s\n" "${mock_bot_bindings}" ;;
              *) return 1 ;;
            esac
            ;;
          *) return 1 ;;
        esac
        ;;
      network)
        case "${2:-}" in
          ls)
            [[ "${3:-}" == --format && "${4:-}" == "{{.Name}}" ]] || return 1
            printf "%s\n" cometa-bank_edge cometa-bank_egress cometa-bank_public
            return 0
            ;;
          inspect)
            [[ "${3:-}" == --format && "${4:-}" == "{{json .}}" && \
              "${5:-}" == cometa-bank_* ]] || return 1
            mock_network_name=${5}
            ;;
          *) return 1 ;;
        esac
        logical_name=${mock_network_name#cometa-bank_}
        printf "%s\n" "${mock_network_name}" >>"${network_inspect_log}"
        network_driver=bridge
        internal=false
        icc=false
        if [[ "${logical_name}" == edge ]]; then
          network_driver=${mock_edge_driver}
          internal=true
          icc=true
        fi
        jq -cn \
          --arg name "${mock_network_name}" \
          --arg logical "${logical_name}" \
          --arg driver "${network_driver}" \
          --arg icc "${icc}" \
          --arg gateway_mode "${mock_edge_gateway_mode}" \
          --arg ipam_driver "${mock_edge_ipam_driver}" \
          --arg subnet "${mock_ipam_subnet}" \
          --arg gateway "${mock_ipam_gateway}" \
          --argjson enable_ipv6 "${mock_enable_ipv6}" \
          --argjson internal "${internal}" '\''
            {Name:$name,Driver:$driver,Scope:"local",Internal:$internal,
             EnableIPv4:true,EnableIPv6:$enable_ipv6,
             Ingress:false,Attachable:false,ConfigOnly:false,ConfigFrom:{Network:""},
             IPAM:{Driver:$ipam_driver,Options:null,Config:[{Subnet:$subnet,Gateway:$gateway}]},
             Labels:{"com.docker.compose.project":"cometa-bank","com.docker.compose.network":$logical},
             Options:({"com.docker.network.bridge.enable_icc":$icc}
               + if $gateway_mode == "" then {}
                 else {"com.docker.network.bridge.gateway_mode_ipv4":$gateway_mode}
                 end)}
          '\''
        ;;
      *) return 1 ;;
    esac
  }

  check_running_service_network_topology
  check_running_service_port_bindings
  [[ "$(sort -u "${network_inspect_log}" | wc -l | tr -d "[:space:]")" == 3 ]]

  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{},"cometa-bank_public":{}}'\''
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{}}'\''
  mock_bot_network_mode=host
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_bot_network_mode=cometa-bank_edge
  mock_bot_bindings='\''{"8787/tcp":[{"HostIp":"127.0.0.1","HostPort":"8787"}]}'\''
  if (check_running_service_port_bindings >/dev/null 2>&1); then exit 1; fi
  mock_bot_bindings='\''{}'\''
  mock_edge_ipam_driver=plugin
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_edge_ipam_driver=default
  mock_enable_ipv6=true
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_enable_ipv6=false
  mock_ipam_subnet=10.0.0.0/7
  mock_ipam_gateway=10.0.0.1
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_ipam_subnet=203.0.113.0/24
  mock_ipam_gateway=203.0.113.1
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_ipam_subnet=172.30.0.0/16
  mock_ipam_gateway=172.30.0.1
  mock_edge_gateway_mode=routed
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
  mock_edge_gateway_mode=
  mock_edge_driver=macvlan
  if (check_running_service_network_topology >/dev/null 2>&1); then exit 1; fi
' _ "${host_docker_network_flow}" "${host_runtime_network_flow}" \
  "${host_runtime_binding_flow}" || \
  fail 'host preflight runtime Docker topology harness failed'

host_inner_tls_flow="$(sed -n '/^check_served_inner_tls() {$/,/^}$/p' \
  "${host_preflight_script}")"
[[ -n "${host_inner_tls_flow}" ]] || fail 'host preflight inner TLS function is missing'
for required_host_inner_tls_contract in \
  'for hostname in "${domain}" "${www_domain}"; do' \
  'timeout --signal=TERM --kill-after=2s "${inner_tls_timeout_seconds}s" \' \
  'openssl s_client \' \
  '-connect "${inner_tls_endpoint}"' \
  '-servername "${hostname}"' \
  '-showcerts' \
  '-verify 5' \
  '-verify_return_error' \
  '-verify_hostname "${hostname}"' \
  '-CApath /etc/ssl/certs' \
  '| openssl x509 -outform PEM' \
  'openssl x509 -noout -checkend "${minimum_certificate_validity_seconds}"'; do
  grep -Fq -- "${required_host_inner_tls_contract}" <<<"${host_inner_tls_flow}" || \
    fail "host preflight served inner TLS guard is missing: ${required_host_inner_tls_contract}"
done
host_inner_tls_call_line="$(awk '$0 == "check_served_inner_tls" { print NR }' \
  "${host_preflight_script}")"
host_success_line="$(awk 'index($0, "Host preflight passed:") { print NR }' \
  "${host_preflight_script}")"
[[ "${host_inner_tls_call_line}" =~ ^[0-9]+$ && "${host_success_line}" =~ ^[0-9]+$ && \
  "${host_inner_tls_call_line}" -lt "${host_success_line}" ]] || \
  fail 'host preflight must verify served inner TLS before claiming success'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  timeout_log="${harness_root}/timeout.log"
  openssl_log="${harness_root}/openssl.log"
  : >"${timeout_log}"
  : >"${openssl_log}"
  domain=euphoria.bot
  www_domain=www.euphoria.bot
  inner_tls_endpoint=127.0.0.1:8443
  inner_tls_timeout_seconds=8
  minimum_certificate_validity_seconds=1814400
  mock_failure=none
  fail() { exit 91; }
  timeout() {
    local -r expected_apex="--signal=TERM --kill-after=2s 8s openssl s_client -connect 127.0.0.1:8443 -servername euphoria.bot -showcerts -verify 5 -verify_return_error -verify_hostname euphoria.bot -CApath /etc/ssl/certs"
    local -r expected_www="--signal=TERM --kill-after=2s 8s openssl s_client -connect 127.0.0.1:8443 -servername www.euphoria.bot -showcerts -verify 5 -verify_return_error -verify_hostname www.euphoria.bot -CApath /etc/ssl/certs"
    printf "%s\n" "$*" >>"${timeout_log}"
    [[ "$*" == "${expected_apex}" || "$*" == "${expected_www}" ]] || return 64
    [[ "${mock_failure}" != handshake ]] || return 65
    printf "%s\n" \
      "-----BEGIN CERTIFICATE-----" \
      "mock-leaf" \
      "-----END CERTIFICATE-----"
  }
  openssl() {
    printf "%s\n" "$*" >>"${openssl_log}"
    case "$*" in
      "x509 -outform PEM")
        [[ "${mock_failure}" != extraction ]] || return 66
        cat
        ;;
      "x509 -noout -checkend 1814400")
        cat >/dev/null
        [[ "${mock_failure}" != expiry ]] || return 67
        ;;
      *) return 68 ;;
    esac
  }

  check_served_inner_tls
  [[ "$(wc -l <"${timeout_log}" | tr -d "[:space:]")" == 2 ]]
  grep -Fqx -- "--signal=TERM --kill-after=2s 8s openssl s_client -connect 127.0.0.1:8443 -servername euphoria.bot -showcerts -verify 5 -verify_return_error -verify_hostname euphoria.bot -CApath /etc/ssl/certs" "${timeout_log}"
  grep -Fqx -- "--signal=TERM --kill-after=2s 8s openssl s_client -connect 127.0.0.1:8443 -servername www.euphoria.bot -showcerts -verify 5 -verify_return_error -verify_hostname www.euphoria.bot -CApath /etc/ssl/certs" "${timeout_log}"
  [[ "$(grep -Fxc -- "x509 -outform PEM" "${openssl_log}")" == 2 ]]
  [[ "$(grep -Fxc -- "x509 -noout -checkend 1814400" "${openssl_log}")" == 2 ]]

  for mock_failure in handshake extraction expiry; do
    if (check_served_inner_tls >/dev/null 2>&1); then
      exit 1
    fi
  done
' _ "${host_inner_tls_flow}" || \
  fail 'host preflight actual inner TLS harness failed'

rg --fixed-strings --quiet \
  'ExecStart=/usr/local/sbin/cometa-bank-renew-certificates' \
  "${project_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service" || \
  fail 'certificate renewal must use the stable host-owned entrypoint'
reject_rg_match \
  'certificate-renewal systemd unit depends directly on a release symlink' \
  'ExecStart=.*/(current|releases)/' \
  "${project_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service"
expected_renewal_service="$(printf '%s\n' \
  '[Unit]' \
  'Description=Renew Cometa Bank TLS certificates and reload Nginx safely' \
  'After=docker.service network-online.target' \
  'Requires=docker.service' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  'Type=oneshot' \
  'ExecStart=/usr/local/sbin/cometa-bank-renew-certificates' \
  'Nice=10' \
  'IOSchedulingClass=best-effort' \
  'IOSchedulingPriority=7' \
  'TimeoutStartSec=30min' \
  '' \
  'NoNewPrivileges=true' \
  'PrivateTmp=true' \
  'ProtectHome=true' \
  'ProtectSystem=strict' \
  'ReadWritePaths=/run/lock')"
actual_renewal_service="$(<"${project_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service")"
[[ "${actual_renewal_service}" == "${expected_renewal_service}" ]] || \
  fail 'host-owned certificate-renewal unit semantics changed and would break image rollback'
assert_sha256 \
  "${project_root}/deploy/standalone/systemd/cometa-bank-cert-renew.service" \
  'sha256:049e074c1a3f3e0e332f6736d75ec1b7ddb729d85bfe71f85c012e2915a56f3a'
assert_sha256 \
  "${project_root}/deploy/standalone/systemd/cometa-bank-cert-renew.timer" \
  'sha256:45e2a8c6b8818a7e6d4705132a1b085313152221ceb3219c18b8329d7ac5c343'
assert_sha256 \
  "${project_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh" \
  'sha256:ad0281b5983ef04c21a51a7aa740d2b63075e508b1c2027681db828be173a4be'

standalone_renewal_entrypoint="${project_root}/deploy/standalone/scripts/renew-certificates-entrypoint.sh"
rg --fixed-strings --quiet \
  "readonly renewal_worker='/usr/local/libexec/cometa-bank-renew-certificates-worker'" \
  "${standalone_renewal_entrypoint}" || \
  fail 'stable renewal entrypoint must target the root-owned host worker'
rg --fixed-strings --quiet 'exec "${renewal_worker}" "$@"' \
  "${standalone_renewal_entrypoint}" || \
  fail 'stable renewal entrypoint must forward every worker argument through exec'
rg --fixed-strings --quiet \
  'readonly renewal_record="${deploy_root}/state/renewal-bundle.release"' \
  "${standalone_renewal_entrypoint}" || \
  fail 'stable renewal entrypoint must resolve its immutable source record'
rg --fixed-strings --quiet \
  '[[ ! -e "${renewal_pending_record}" && ! -L "${renewal_pending_record}" ]] || \' \
  "${standalone_renewal_entrypoint}" || \
  fail 'stable renewal entrypoint must fail closed during host-bundle migration'
rg --fixed-strings --quiet \
  '[[ ! -e "${renewal_legacy_timer_journal}" && ! -L "${renewal_legacy_timer_journal}" ]] || \' \
  "${standalone_renewal_entrypoint}" || \
  fail 'stable renewal entrypoint must fail closed while legacy renewal units are quiesced'
rg --fixed-strings --quiet \
  '"${recorded_root}/scripts/renew-certificates.sh" \' \
  "${standalone_renewal_entrypoint}" || \
  fail 'stable renewal entrypoint must verify the worker against its recorded source'

standalone_renewal_script="${project_root}/deploy/standalone/scripts/renew-certificates.sh"
standalone_lifecycle_line() {
  local -r pattern=$1
  local match line_number
  match="$(rg --fixed-strings --line-number "${pattern}" "${standalone_renewal_script}")" || \
    fail "standalone certificate renewal lifecycle step is missing: ${pattern}"
  [[ "${match}" != *$'\n'* ]] || \
    fail "standalone certificate renewal lifecycle step is ambiguous: ${pattern}"
  line_number="${match%%:*}"
  [[ "${line_number}" =~ ^[0-9]+$ ]] || \
    fail "standalone certificate renewal lifecycle step has no line number: ${pattern}"
  printf '%s\n' "${line_number}"
}

standalone_orphan_line="$(standalone_lifecycle_line \
  "stop_certbot_containers || fail 'could not stop orphaned Certbot containers'")"
standalone_recover_line="$(standalone_lifecycle_line \
  "recover_pending_state || fail 'could not recover the pending pre-renewal certificate state'")"
standalone_clear_line="$(standalone_lifecycle_line \
  "volume_recovery_operation clear-stale || fail 'could not clear stale certificate recovery staging'")"
standalone_snapshot_line="$(standalone_lifecycle_line \
  "snapshot_lineage || fail 'could not snapshot the current certificate lineage'")"
standalone_arm_line="$(standalone_lifecycle_line \
  "arm_durable_recovery || fail 'could not persist the pre-renewal recovery bundle'")"
standalone_renew_line="$(standalone_lifecycle_line \
  "renew --no-random-sleep-on-renew || fail 'Certbot renewal failed'")"
standalone_reload_line="$(standalone_lifecycle_line \
  '# Reload only after the candidate lineage passes expiry, SAN, key, and trust checks.')"
standalone_probe_line="$(standalone_lifecycle_line \
  "fail 'Nginx did not serve the renewed certificate for both hostnames'")"
standalone_commit_line="$(standalone_lifecycle_line \
  "retire_durable_recovery || fail 'could not commit the validated certificate state'")"

(( standalone_orphan_line < standalone_recover_line &&
  standalone_recover_line < standalone_clear_line &&
  standalone_clear_line < standalone_snapshot_line &&
  standalone_snapshot_line < standalone_arm_line &&
  standalone_arm_line < standalone_renew_line &&
  standalone_renew_line < standalone_reload_line &&
  standalone_reload_line < standalone_probe_line &&
  standalone_probe_line < standalone_commit_line )) || \
  fail 'standalone renewal must reap, recover, clear staging, snapshot, arm, renew, reload, probe, then commit'
rg --fixed-strings --quiet 'trap stop_on_signal INT TERM HUP' \
  "${standalone_renewal_script}" || \
  fail 'standalone certificate renewal must route termination signals through rollback'
rg --fixed-strings --quiet \
  "readonly recovery_volume_root='/etc/letsencrypt/.cometa-bank-renewal'" \
  "${standalone_renewal_script}" || \
  fail 'standalone recovery state must persist inside the existing ACME volume'
rg --fixed-strings --quiet \
  'validation_time="$((validation_epoch_seconds + minimum_validity_seconds))"' \
  "${standalone_renewal_script}" || \
  fail 'standalone renewal must compute the trust horizon from validated integer time'
rg --fixed-strings --quiet \
  'openssl verify -purpose sslserver -attime "${validation_time}" -CApath /etc/ssl/certs' \
  "${standalone_renewal_script}" || \
  fail 'standalone renewal must verify candidate trust through its safety window'
rg --fixed-strings --quiet 'run --rm --name "${renewal_container}"' \
  "${standalone_renewal_script}" || \
  fail 'standalone Certbot renewal must use a deterministic reapable container name'
rg --fixed-strings --quiet 'run --rm --name "${recovery_helper_container}"' \
  "${standalone_renewal_script}" || \
  fail 'standalone recovery helpers must use a deterministic reapable container name'
rg --fixed-strings --quiet "[[ \"\${identity}\" != 'cometa-bank|certbot' ]]" \
  "${standalone_renewal_script}" || \
  fail 'standalone renewal must verify Compose ownership before reaping a container'
rg --fixed-strings --quiet \
  '    [[ "$1" == '\''--recover-only'\'' ]] || fail "unknown argument: $1"' \
  "${standalone_renewal_script}" || \
  fail 'standalone renewal worker must expose only the guarded recovery-only mode'
rg --fixed-strings --quiet \
  'readonly renewal_record="${deploy_root}/state/renewal-bundle.release"' \
  "${standalone_renewal_script}" || \
  fail 'standalone renewal worker must resolve its immutable source record'
rg --fixed-strings --quiet \
  'readonly release_root="${deploy_root}/releases/${release_id}"' \
  "${standalone_renewal_script}" || \
  fail 'standalone renewal worker must use its recorded release Compose contract'
reject_rg_match \
  'standalone renewal worker must not follow the mutable runtime release link' \
  --fixed-strings 'readlink -- "${deploy_root}/current"' \
  "${standalone_renewal_script}"
reject_rg_match \
  'standalone renewal worker must not derive its Compose contract from current' \
  --fixed-strings 'current_target=' \
  "${standalone_renewal_script}"
bash "${project_root}/scripts/test-standalone-certificate-renewal.sh" || \
  fail 'standalone certificate renewal signal and crash-recovery harness failed'

standalone_release_script="${project_root}/deploy/standalone/scripts/release.sh"
for required_release_docker_contract in \
  'source "${script_directory}/docker-daemon-perimeter.sh"' \
  'for command_name in awk caddy chmod chown cmp curl date dig dirname docker dockerd env flock getent grep head install jq mktemp mv openssl readlink sed sha256sum sqlite3 ss stat sync systemctl systemd-analyze timeout tr unlink wc; do' \
  'assert_docker_cli_local_contract'; do
  grep -Fq -- "${required_release_docker_contract}" "${standalone_release_script}" || \
    fail "release local Docker contract is missing: ${required_release_docker_contract}"
done
release_docker_cli_gate_line="$(awk '$0 == "assert_docker_cli_local_contract" { print NR }' \
  "${standalone_release_script}")"
release_compose_function_line="$(awk '$0 == "compose_release() {" { print NR }' \
  "${standalone_release_script}")"
[[ "${release_docker_cli_gate_line}" =~ ^[0-9]+$ && \
  "${release_compose_function_line}" =~ ^[0-9]+$ && \
  "${release_docker_cli_gate_line}" -lt "${release_compose_function_line}" ]] || \
  fail 'release must pin the local Docker CLI before defining lifecycle operations'
release_function_body() {
  local -r function_name=$1
  awk -v signature="${function_name}() {" '
    $0 == signature { inside = 1 }
    inside { print }
    inside && $0 == "}" { exit }
  ' "${standalone_release_script}"
}

release_function_step_line() {
  local -r function_name=$1
  local -r pattern=$2
  local -r occurrence=${3:-only}
  local function_body match line_number

  function_body="$(release_function_body "${function_name}")"
  [[ -n "${function_body}" ]] || \
    fail "standalone release function is missing: ${function_name}"
  match="$(rg --fixed-strings --line-number "${pattern}" <<<"${function_body}")" || \
    fail "standalone release step is missing in ${function_name}: ${pattern}"
  case "${occurrence}" in
    only)
      [[ "${match}" != *$'\n'* ]] || \
        fail "standalone release step is ambiguous in ${function_name}: ${pattern}"
      ;;
    first) match="${match%%$'\n'*}" ;;
    last) match="${match##*$'\n'}" ;;
    *) fail "unknown release lifecycle occurrence: ${occurrence}" ;;
  esac
  line_number="${match%%:*}"
  [[ "${line_number}" =~ ^[0-9]+$ ]] || \
    fail "standalone release step has no line number in ${function_name}: ${pattern}"
  printf '%s\n' "${line_number}"
}

worker_install_line="$(release_function_step_line install_host_renewal_bundle \
  'install -m 0755 -o root -g root -- "${worker_source}" "${host_renewal_worker}.next" || return 1')"
worker_commit_line="$(release_function_step_line install_host_renewal_bundle \
  'mv -fT -- "${host_renewal_worker}.next" "${host_renewal_worker}" || return 1')"
wrapper_install_line="$(release_function_step_line install_host_renewal_bundle \
  'install -m 0755 -o root -g root -- "${entrypoint_source}" "${host_renewal_entrypoint}.next" || \')"
wrapper_commit_line="$(release_function_step_line install_host_renewal_bundle \
  'mv -fT -- "${host_renewal_entrypoint}.next" "${host_renewal_entrypoint}" || return 1')"
record_commit_line="$(release_function_step_line install_host_renewal_bundle \
  'write_renewal_release_marker "${host_renewal_record}" "${target_release}" || return 1')"
(( worker_install_line < worker_commit_line &&
  worker_commit_line < wrapper_install_line &&
  wrapper_install_line < wrapper_commit_line &&
  wrapper_commit_line < record_commit_line )) || \
  fail 'host renewal migration must commit worker first, wrapper last, then its immutable source record'

pending_write_line="$(release_function_step_line ensure_host_renewal_bundle \
  'write_renewal_release_marker "${host_renewal_pending_record}" "${target_release}" || return 1')"
bundle_install_line="$(release_function_step_line ensure_host_renewal_bundle \
  'install_host_renewal_bundle "${target_release}"' last)"
(( pending_write_line < bundle_install_line )) || \
  fail 'host renewal migration must journal its target before mutating host files'

legacy_guard_line="$(release_function_step_line quiesce_legacy_renewal_units \
  'ensure_legacy_renewal_guard || return 1' last)"
legacy_journal_line="$(release_function_step_line quiesce_legacy_renewal_units \
  'write_legacy_timer_journal "${target_release}" "${timer_state}" || return 1')"
legacy_disable_line="$(release_function_step_line quiesce_legacy_renewal_units \
  'systemctl disable --now "${renewal_timer_unit}" || return 1')"
(( legacy_guard_line < legacy_journal_line && legacy_journal_line < legacy_disable_line )) || \
  fail 'legacy migration must install its systemd guard, journal timer state, then disable the timer'
legacy_quiesce_line="$(release_function_step_line ensure_host_renewal_bundle \
  'quiesce_legacy_renewal_units "${target_release}" || return 1' last)"
(( legacy_quiesce_line < pending_write_line )) || \
  fail 'legacy renewal units must be durably quiesced before host-bundle mutation begins'
rg --fixed-strings --quiet \
  'ConditionPathExists=!%s' "${standalone_release_script}" || \
  fail 'legacy migration systemd guard must key off its durable journal'

record_read_line="$(release_function_step_line verify_recorded_host_renewal_bundle \
  'recorded_release="$(read_renewal_release_marker "${host_renewal_record}")" || return 1')"
record_verify_line="$(release_function_step_line verify_recorded_host_renewal_bundle \
  'verify_host_renewal_files "${recorded_release}"')"
(( record_read_line < record_verify_line )) || \
  fail 'runtime renewal integrity must resolve the recorded immutable source release before comparison'

for staged_function in \
  prepare_release \
  activate_release \
  rollback_release \
  show_status \
  show_ledger_mode_status \
  enable_server_ledger_mode; do
  staged_body="$(release_function_body "${staged_function}")"
  [[ -n "${staged_body}" ]] || fail "staged release function is missing: ${staged_function}"
  grep -Fq 'assert_staged_edge_contract' <<<"${staged_body}" || \
    fail "${staged_function} must fail closed on the staged Caddy edge contract"
  for forbidden_renewal_call in \
    issue_certificate \
    verify_certificate_lineage \
    ensure_host_renewal_bundle \
    verify_candidate_host_renewal_bundle \
    verify_recorded_host_renewal_bundle \
    verify_legacy_host_renewal_bundle \
    assert_renewal_state_clean \
    assert_prepare_renewal_state_clean \
    assert_host_renewal_migration_complete \
    quiesce_legacy_renewal_units \
    restore_legacy_renewal_units; do
    if grep -Fq "${forbidden_renewal_call}" <<<"${staged_body}"; then
      fail "${staged_function} must not call legacy renewal lifecycle: ${forbidden_renewal_call}"
    fi
  done
  reject_rg_match \
    "${staged_function} must not mutate legacy renewal systemd units" \
    'systemctl[[:space:]]+(enable|disable|start|stop|restart|reload|mask|unmask|reenable|preset|daemon-reload)' \
    <(printf '%s\n' "${staged_body}")
  reject_rg_match \
    "${staged_function} must not touch the legacy certificate owner" \
    'certbot|host_renewal|renewal_(service|timer|record|recovery)' \
    <(printf '%s\n' "${staged_body}")
done

rollback_runtime_body="$(release_function_body rollback_runtime)"
reject_rg_match \
  'runtime rollback helper must not touch the legacy certificate owner' \
  'certbot|host_renewal|renewal_(service|timer|record|recovery)|systemctl[[:space:]]+(enable|disable|start|stop|restart|reload|mask|unmask|reenable|preset|daemon-reload)' \
  <(printf '%s\n' "${rollback_runtime_body}")

release_dispatch="$(sed -n '/^case "${action}" in$/,$p' "${standalone_release_script}")"
for required_hardening_dispatch in \
  'harden-edge)' \
  "fail 'harden-edge accepts only --apply'" \
  'harden_edge'; do
  grep -Fq "${required_hardening_dispatch}" <<<"${release_dispatch}" || \
    fail "release dispatcher is missing edge hardening: ${required_hardening_dispatch}"
done
reject_rg_match \
  'active release dispatcher must not expose legacy certificate issuance' \
  'issue-certificate|issue_certificate' \
  <(printf '%s\n' "${release_dispatch}")

caddy_contract_flow="$(release_function_body verify_caddy_config_contract)"
legacy_unit_flow="$(release_function_body legacy_unit_is_quiesced)"
legacy_units_guard_flow="$(release_function_body assert_legacy_certbot_units_quiesced)"
listener_contract_flow="$(release_function_body assert_public_tcp_listener_owned_by_caddy)"
caddy_listener_owner_flow="$(release_function_body validate_caddy_listener_owner)"
caddy_service_pid_flow="$(release_function_body caddy_service_pid)"
caddy_admin_parent_flow="$(release_function_body caddy_admin_parent_is_private)"
caddy_admin_socket_flow="$(release_function_body assert_permissioned_caddy_admin_socket)"
caddy_legacy_admin_runtime_flow="$(release_function_body assert_legacy_caddy_admin_runtime)"
caddy_legacy_admin_listener_flow="$(release_function_body assert_legacy_caddy_admin_listener)"
caddy_stale_admin_socket_flow="$(release_function_body caddy_stale_admin_socket_is_safe)"
caddy_reconcile_admin_socket_flow="$(release_function_body reconcile_stale_caddy_admin_socket)"
caddy_detect_admin_address_flow="$(release_function_body detect_caddy_admin_address)"
caddy_live_config_flow="$(release_function_body assert_caddy_live_config_matches_file)"
caddy_replace_config_flow="$(release_function_body replace_installed_caddy_config)"
caddy_reload_flow="$(release_function_body reload_caddy_edge)"
running_service_container_flow="$(release_function_body running_compose_service_container_id)"
docker_network_contract_flow="$(release_function_body assert_docker_network_contract)"
runtime_binding_flow="$(release_function_body assert_running_compose_service_bindings)"
runtime_network_combined_flow="${docker_network_contract_flow}
${runtime_binding_flow}"
staged_edge_host_flow="$(release_function_body assert_staged_edge_host_contract)"
staged_edge_flow="$(release_function_body assert_staged_edge_contract)"
staged_edge_combined_flow="${staged_edge_host_flow}
${staged_edge_flow}"
compose_edge_contract_flow="$(release_function_body verify_release_compose_edge_contract)"
nginx_real_ip_flow="$(release_function_body verify_nginx_real_ip_contract)"
nginx_hardener_flow="$(release_function_body prepare_hardened_nginx_config)"
caddy_hardener_flow="$(release_function_body prepare_hardened_caddy_config)"
udp_listener_flow="$(release_function_body assert_no_public_udp_listener)"
served_inner_certificate_flow="$(release_function_body verify_served_inner_certificates)"
edge_hardening_flow="$(release_function_body harden_edge)"
restart_current_web_flow="$(release_function_body restart_current_web)"
edge_recovery_verify_flow="$(release_function_body verify_edge_recovery_snapshots)"
edge_recovery_read_flow="$(release_function_body read_edge_recovery_marker)"
edge_recovery_arm_flow="$(release_function_body arm_edge_recovery_snapshots)"
edge_recovery_retire_flow="$(release_function_body retire_edge_recovery_snapshots)"
edge_pending_guard_flow="$(release_function_body assert_no_pending_edge_recovery)"
action_link_intent_guard_flow="$(release_function_body assert_action_link_intent_contract)"
edge_recovery_validation_flow="${edge_recovery_read_flow}
${edge_recovery_verify_flow}"
rollback_intent_read_flow="$(release_function_body read_rollback_intent)"
rollback_intent_arm_flow="$(release_function_body arm_rollback_intent)"
rollback_intent_retire_flow="$(release_function_body retire_rollback_intent)"
rollback_reconcile_flow="$(release_function_body reconcile_pending_rollback)"
rollback_link_switch_flow="$(release_function_body switch_rollback_links)"
activation_intent_read_flow="$(release_function_body read_activation_intent)"
activation_intent_arm_flow="$(release_function_body arm_activation_intent)"
activation_intent_retire_flow="$(release_function_body retire_activation_intent)"
activation_reconcile_flow="$(release_function_body reconcile_pending_activation)"
activation_link_switch_flow="$(release_function_body switch_release_links)"
release_link_write_flow="$(release_function_body write_release_link)"
recovery_candidate_safety_flow="$(release_function_body recovery_candidate_file_is_safe)"
recovery_candidate_relation_flow="$(release_function_body recovery_candidate_relation)"
recovery_candidate_promote_flow="$(release_function_body promote_recovery_candidate)"
recovery_candidate_discard_flow="$(release_function_body discard_partial_recovery_candidate)"
activation_candidate_recovery_flow="$(release_function_body recover_activation_intent_candidate)"
rollback_candidate_recovery_flow="$(release_function_body recover_rollback_intent_candidate)"
edge_candidate_staging_flow="$(release_function_body edge_recovery_staging_exists)"
edge_candidate_recovery_flow="$(release_function_body recover_edge_recovery_candidates)"
activate_release_flow="$(release_function_body activate_release)"
rollback_release_flow="$(release_function_body rollback_release)"
intent_candidate_harness_flow="${recovery_candidate_safety_flow}
${recovery_candidate_relation_flow}
${recovery_candidate_promote_flow}
${recovery_candidate_discard_flow}
${activation_intent_read_flow}
${activation_candidate_recovery_flow}
${rollback_intent_read_flow}
${rollback_candidate_recovery_flow}
${activate_release_flow}
${rollback_release_flow}"
edge_candidate_harness_flow="${recovery_candidate_safety_flow}
${recovery_candidate_relation_flow}
${recovery_candidate_promote_flow}
${recovery_candidate_discard_flow}
${edge_recovery_read_flow}
${edge_recovery_verify_flow}
${edge_candidate_staging_flow}
${edge_candidate_recovery_flow}"
for required_caddy_contract in \
  'caddy validate --config "${config_path}" --adapter caddyfile' \
  'caddy adapt --config "${config_path}" --adapter caddyfile' \
  'for expected_domain in "${domain}" "${www_domain}"; do' \
  "--arg upstream '127.0.0.1:8443'" \
  'def routes_for($hostname):' \
  'def proxies_for($route):' \
  'def no_hsts($route):' \
  '| ($routes | length) == 1' \
  '| ($proxies | length) == 1' \
  '($proxies[0].upstreams == [{"dial":$upstream}])' \
  '($proxies[0].headers.request.set.Host == ["{http.request.host}"])' \
  '($proxies[0].transport.protocol == "http")' \
  '($proxies[0].transport.tls.server_name == $domain)' \
  '(($proxies[0].transport.tls.insecure_skip_verify // false) == false)' \
  'all($servers[]; .protocols == ["h1", "h2"])' \
  '.admin.listen == $admin_listen' \
  '.admin.config.persist == false' \
  'no_hsts($routes[0])' \
  'jq --exit-status'; do
  grep -Fq -- "${required_caddy_contract}" <<<"${caddy_contract_flow}" || \
    fail "runtime Caddy semantic validation is missing: ${required_caddy_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  scratch_directory="${harness_root}/scratch"
  mkdir -p "${scratch_directory}"
  config_path="${harness_root}/Caddyfile"
  : >"${config_path}"
  domain=euphoria.bot
  www_domain=www.euphoria.bot
  caddy_admin_listen="unix//var/lib/caddy/.local/share/caddy/admin.sock|0200"
  fail() { exit 91; }
  caddy() {
    case "$1" in
      validate) return 0 ;;
      adapt) printf "%s\n" "${mock_caddy_json}" ;;
      *) return 1 ;;
    esac
  }
  route() {
    local hostname=$1
    local upstreams=$2
    local response_headers=${3:-"{}"}
    printf '\''{"match":[{"host":["%s"]}],"handle":[{"handler":"reverse_proxy","upstreams":%s,"headers":{"request":{"set":{"Host":["{http.request.host}"]}}},"transport":{"protocol":"http","tls":{"server_name":"%s"}}}],"response_headers":%s}'\'' \
      "${hostname}" "${upstreams}" "${hostname}" "${response_headers}"
  }
  apex_route="$(route "${domain}" '\''[{"dial":"127.0.0.1:8443"}]'\'')"
  www_route="$(route "${www_domain}" '\''[{"dial":"127.0.0.1:8443"}]'\'')"
  mock_caddy_json="{\"admin\":{\"listen\":\"${caddy_admin_listen}\",\"config\":{\"persist\":false}},\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"protocols\":[\"h1\",\"h2\"],\"routes\":[${apex_route},${www_route}]}}}}}"
  verify_caddy_config_contract "${config_path}" tracked
  legacy_apex_route="${apex_route/\"server_name\":\"${domain}\"/\"server_name\":\"${domain}\",\"insecure_skip_verify\":true}"
  legacy_www_route="${www_route/\"server_name\":\"${www_domain}\"/\"server_name\":\"${www_domain}\",\"insecure_skip_verify\":true}"
  mock_caddy_json="{\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"routes\":[${legacy_apex_route},${legacy_www_route}]}}}}}"
  verify_caddy_config_contract "${config_path}" installed legacy
  if (verify_caddy_config_contract "${config_path}" installed secure >/dev/null 2>&1); then
    exit 1
  fi
  mock_caddy_json="{\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"routes\":[${legacy_apex_route},${www_route}]}}}}}"
  if (verify_caddy_config_contract "${config_path}" installed legacy >/dev/null 2>&1); then
    exit 1
  fi
  extra_upstream_route="$(route "${domain}" '\''[{"dial":"127.0.0.1:8443"},{"dial":"192.0.2.10:8443"}]'\'')"
  mock_caddy_json="{\"admin\":{\"listen\":\"${caddy_admin_listen}\",\"config\":{\"persist\":false}},\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"protocols\":[\"h1\",\"h2\"],\"routes\":[${extra_upstream_route},${www_route}]}}}}}"
  if (verify_caddy_config_contract "${config_path}" tracked >/dev/null 2>&1); then
    exit 1
  fi
  mock_caddy_json="{\"admin\":{\"listen\":\"${caddy_admin_listen}\",\"config\":{\"persist\":false}},\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"protocols\":[\"h1\",\"h2\"],\"routes\":[${apex_route},${apex_route},${www_route}]}}}}}"
  if (verify_caddy_config_contract "${config_path}" tracked >/dev/null 2>&1); then
    exit 1
  fi
  insecure_apex_route="${apex_route/\"server_name\":\"${domain}\"/\"server_name\":\"${domain}\",\"insecure_skip_verify\":true}"
  mock_caddy_json="{\"admin\":{\"listen\":\"${caddy_admin_listen}\",\"config\":{\"persist\":false}},\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"protocols\":[\"h1\",\"h2\"],\"routes\":[${insecure_apex_route},${www_route}]}}}}}"
  if (verify_caddy_config_contract "${config_path}" tracked >/dev/null 2>&1); then
    exit 1
  fi
  hsts_route="$(route "${domain}" '\''[{"dial":"127.0.0.1:8443"}]'\'' '\''{"Strict-Transport-Security":["max-age=31536000"]}'\'')"
  mock_caddy_json="{\"admin\":{\"listen\":\"${caddy_admin_listen}\",\"config\":{\"persist\":false}},\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"protocols\":[\"h1\",\"h2\"],\"routes\":[${hsts_route},${www_route}]}}}}}"
  if (verify_caddy_config_contract "${config_path}" tracked >/dev/null 2>&1); then
    exit 1
  fi
  mock_caddy_json="{\"admin\":{\"listen\":\"${caddy_admin_listen}\",\"config\":{\"persist\":false}},\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"protocols\":[\"h1\",\"h2\",\"h3\"],\"routes\":[${apex_route},${www_route}]}}}}}"
  if (verify_caddy_config_contract "${config_path}" tracked >/dev/null 2>&1); then
    exit 1
  fi
' _ "${caddy_contract_flow}" || \
  fail 'runtime Caddy exact-route semantic harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  domain=euphoria.bot
  www_domain=www.euphoria.bot
  source_config="${harness_root}/legacy.Caddyfile"
  hardened_config="${harness_root}/hardened.Caddyfile"
  second_config="${harness_root}/hardened-again.Caddyfile"
  mixed_config="${harness_root}/mixed.Caddyfile"
  target_skip_count() {
    awk -v apex="${domain}" -v www="${www_domain}" '\''
      $0 == apex " {" || $0 == www " {" { in_target = 1 }
      in_target && $0 ~ /^[[:space:]]*tls_insecure_skip_verify[[:space:]]*$/ { count += 1 }
      in_target && $0 == "}" { in_target = 0 }
      END { print count + 0 }
    '\'' "$1"
  }
  verify_caddy_config_contract() {
    local config_path=$1
    local trust_mode=$3
    local skip_count protocol_count
    skip_count="$(target_skip_count "${config_path}")"
    protocol_count="$(grep -Fxc $'\''\t\tprotocols h1 h2'\'' "${config_path}" || true)"
    case "${trust_mode}" in
      secure) [[ "${skip_count}" == 0 && "${protocol_count}" == 1 ]] ;;
      legacy) [[ "${skip_count}" == 2 && "${protocol_count}" == 0 ]] ;;
      *) return 1 ;;
    esac
  }
  printf "%s\n" \
    "# preserved-prefix" \
    "euphoria.bot {" \
    "  tls_insecure_skip_verify" \
    "}" \
    "unrelated.example {" \
    "  tls_insecure_skip_verify" \
    "}" \
    "www.euphoria.bot {" \
    "  tls_insecure_skip_verify" \
    "}" >"${source_config}"
  prepare_hardened_caddy_config "${source_config}" "${hardened_config}"
  [[ "$(target_skip_count "${hardened_config}")" == 0 ]]
  [[ "$(grep -Fc tls_insecure_skip_verify "${hardened_config}")" == 1 ]]
  grep -Fxq "# preserved-prefix" "${hardened_config}"
  grep -Fxq "unrelated.example {" "${hardened_config}"
  prepare_hardened_caddy_config "${hardened_config}" "${second_config}"
  cmp -s "${hardened_config}" "${second_config}"

  printf "%s\n" \
    "euphoria.bot {" \
    "}" \
    "www.euphoria.bot {" \
    "  tls_insecure_skip_verify" \
    "}" >"${mixed_config}"
  if prepare_hardened_caddy_config "${mixed_config}" "${harness_root}/mixed.out" \
    >/dev/null 2>&1; then
    exit 1
  fi
' _ "${caddy_hardener_flow}" || \
  fail 'target-scoped idempotent Caddy hardening harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  legacy_config="${harness_root}/legacy.conf"
  hardened_config="${harness_root}/hardened.conf"
  hardened_again="${harness_root}/hardened-again.conf"
  partial_config="${harness_root}/partial.conf"
  duplicate_config="${harness_root}/duplicate.conf"
  printf "%s\n" "server_tokens off;" "server { return 204; }" >"${legacy_config}"
  prepare_hardened_nginx_config "${legacy_config}" "${hardened_config}"
  verify_nginx_real_ip_contract "${hardened_config}"
  prepare_hardened_nginx_config "${hardened_config}" "${hardened_again}"
  cmp -s "${hardened_config}" "${hardened_again}"

  printf "%s\n" \
    "server_tokens off;" \
    "set_real_ip_from 127.0.0.1;" \
    "server { return 204; }" >"${partial_config}"
  if prepare_hardened_nginx_config "${partial_config}" "${harness_root}/partial.out"; then
    exit 1
  fi
  command cp -- "${hardened_config}" "${duplicate_config}"
  printf "%s\n" "real_ip_recursive on;" >>"${duplicate_config}"
  if prepare_hardened_nginx_config "${duplicate_config}" "${harness_root}/duplicate.out"; then
    exit 1
  fi
' _ "${nginx_real_ip_flow}" "${nginx_hardener_flow}" || \
  fail 'legacy/exact/partial Nginx real-IP hardening harness failed'
for required_unit_contract in \
  '"${renewal_timer_unit}:disabled"' \
  '"${renewal_timer_unit}:masked"' \
  '"${renewal_timer_unit}:not-found"' \
  '"${renewal_service_unit}:static"' \
  '"${renewal_service_unit}:disabled"' \
  '"${renewal_service_unit}:masked"' \
  '"${renewal_service_unit}:not-found"' \
  '[[ "${active_state}" == '\''inactive'\'' ]]'; do
  grep -Fq "${required_unit_contract}" <<<"${legacy_unit_flow}" || \
    fail "legacy Certbot quiescence contract is missing: ${required_unit_contract}"
done
for required_listener_contract in \
  '[[ "${port}" == '\''80'\'' || "${port}" == '\''443'\'' ]]' \
  'service_pid="$(caddy_service_pid)"' \
  'timeout --foreground --signal=TERM --kill-after=2s 8s' \
  'ss -H -ltnp "sport = :${port}"' \
  'validate_caddy_listener_owner "${listener}" "${service_pid}"' \
  'local_socket="$(awk '\''{print $4}'\'' <<<"${listener}")"' \
  '127.*|'\''[::1]'\''|::1|'\''[::ffff:127.'\''*'\'']'\'')' \
  '[[ "${has_non_loopback_listener}" == true ]]' \
  'confirmed_service_pid="$(caddy_service_pid)"' \
  '[[ "${confirmed_service_pid}" == "${service_pid}" ]]'; do
  grep -Fq "${required_listener_contract}" <<<"${listener_contract_flow}" || \
    fail "public listener ownership contract is missing: ${required_listener_contract}"
done
for required_listener_owner_contract in \
  '[[ "${line}" == *'\''users:(("caddy",pid='\''* ]]' \
  'while (match(remaining, /pid=[0-9]+/))' \
  'if (value != expected_pid) exit 1' \
  'exit(count == 1 ? 0 : 1)'; do
  grep -Fq -- "${required_listener_owner_contract}" <<<"${caddy_listener_owner_flow}" || \
    fail "Caddy listener PID ownership parser is missing: ${required_listener_owner_contract}"
  grep -Fq -- "${required_listener_owner_contract}" \
    <<<"${host_caddy_listener_owner_flow}" || \
    fail "host-preflight Caddy listener PID parser is missing: ${required_listener_owner_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  fail() { exit 91; }
  timeout() { shift 4; "$@"; }
  pid_epoch_file="${harness_root}/pid-epoch"
  mock_pid_before=4242
  mock_pid_after=4242
  reset_pid_epoch() { printf "0\n" >"${pid_epoch_file}"; }
  caddy_service_pid() {
    local count
    count="$(<"${pid_epoch_file}")"
    count=$((count + 1))
    printf "%s\n" "${count}" >"${pid_epoch_file}"
    if (( count == 1 )); then
      printf "%s\n" "${mock_pid_before}"
    else
      printf "%s\n" "${mock_pid_after}"
    fi
  }
  ss() { printf "%s\n" "${mock_listeners}"; }

  reset_pid_epoch
  mock_listeners="LISTEN 0 4096 *:80 *:* users:((\"caddy\",pid=4242,fd=3))"
  assert_public_tcp_listener_owned_by_caddy 80
  reset_pid_epoch
  printf -v mock_listeners "%s\n%s" \
    "LISTEN 0 4096 0.0.0.0:443 *:* users:((\"caddy\",pid=4242,fd=3))" \
    "LISTEN 0 4096 [::]:443 *:* users:((\"caddy\",pid=4242,fd=4))"
  assert_public_tcp_listener_owned_by_caddy 443

  reset_pid_epoch
  mock_listeners="LISTEN 0 4096 127.0.0.1:443 *:* users:((\"caddy\",pid=4242,fd=3))"
  if (assert_public_tcp_listener_owned_by_caddy 443); then
    exit 1
  fi
  reset_pid_epoch
  printf -v mock_listeners "%s\n%s" \
    "LISTEN 0 4096 *:443 *:* users:((\"caddy\",pid=4242,fd=3))" \
    "LISTEN 0 4096 127.0.0.1:443 *:* users:((\"nginx\",pid=2,fd=4))"
  if (assert_public_tcp_listener_owned_by_caddy 443); then
    exit 1
  fi
  reset_pid_epoch
  mock_listeners="LISTEN 0 4096 *:443 *:* users:((\"caddy\",pid=4242,fd=3),(\"systemd\",pid=1,fd=4))"
  if (assert_public_tcp_listener_owned_by_caddy 443); then
    exit 1
  fi
  reset_pid_epoch
  mock_listeners="LISTEN 0 4096 *:443 *:* users:((\"caddy\",pid=4343,fd=3))"
  if (assert_public_tcp_listener_owned_by_caddy 443); then
    exit 1
  fi
  reset_pid_epoch
  mock_pid_after=4343
  mock_listeners="LISTEN 0 4096 *:443 *:* users:((\"caddy\",pid=4242,fd=3))"
  if (assert_public_tcp_listener_owned_by_caddy 443); then
    exit 1
  fi
' _ "${listener_contract_flow}" "${caddy_listener_owner_flow}" || \
  fail 'public Caddy listener ownership harness failed'
for required_stale_admin_contract in \
  'caddy_admin_parent_is_private' \
  '[[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]]' \
  'caddy:caddy:200' \
  'caddy:caddy:0200' \
  '(assert_legacy_caddy_admin_runtime >/dev/null 2>&1)' \
  'ss -H -lxnp' \
  '[[ -z "${matching}" ]]'; do
  grep -Fq -- "${required_stale_admin_contract}" <<<"${caddy_stale_admin_socket_flow}" || \
    fail "stale Caddy admin socket classification is missing: ${required_stale_admin_contract}"
done
for required_legacy_admin_contract in \
  'pid="$(caddy_service_pid)"' \
  "ss -H -ltnp 'sport = :2019'" \
  '[[ "${count}" == '\''1'\'' ]]' \
  '[[ "${local_socket}" == "${legacy_caddy_admin_address}" ]]' \
  'validate_caddy_listener_owner "${line}" "${pid}"' \
  'confirmed_pid="$(caddy_service_pid)"' \
  '[[ "${confirmed_pid}" == "${pid}" ]]'; do
  grep -Fq -- "${required_legacy_admin_contract}" <<<"${caddy_legacy_admin_runtime_flow}" || \
    fail "legacy Caddy admin ownership contract is missing: ${required_legacy_admin_contract}"
done
for required_admin_reconciliation in \
  '[[ "${apply_rollback}" == true ]]' \
  'verify_edge_recovery_snapshots >/dev/null 2>&1' \
  'assert_permissioned_caddy_admin_socket' \
  'caddy_stale_admin_socket_is_safe' \
  'unlink -- "${caddy_admin_socket}"' \
  'sync -f "$(dirname -- "${caddy_admin_socket}")"' \
  'assert_legacy_caddy_admin_listener'; do
  grep -Fq -- "${required_admin_reconciliation}" \
    <<<"${caddy_reconcile_admin_socket_flow}" || \
    fail "stale Caddy admin socket reconciliation is missing: ${required_admin_reconciliation}"
done
for required_live_admin_contract in \
  'assert_permissioned_caddy_admin_socket' \
  'caddy adapt --config "${installed_caddy_config}" --adapter caddyfile' \
  '--unix-socket "${caddy_admin_socket}"' \
  "'http://localhost/config/'" \
  '[[ "${live}" == "${expected}" ]]'; do
  grep -Fq -- "${required_live_admin_contract}" <<<"${caddy_live_config_flow}" || \
    fail "Caddy live-config comparison is missing: ${required_live_admin_contract}"
done
for required_admin_detection in \
  '[[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]]' \
  'assert_permissioned_caddy_admin_socket' \
  'printf '\''%s\n'\'' "${caddy_admin_address}"' \
  'caddy_stale_admin_socket_is_safe' \
  'assert_legacy_caddy_admin_listener' \
  'printf '\''%s\n'\'' "${legacy_caddy_admin_address}"'; do
  grep -Fq -- "${required_admin_detection}" <<<"${caddy_detect_admin_address_flow}" || \
    fail "Caddy current admin endpoint detection is missing: ${required_admin_detection}"
done
for required_reload_contract in \
  'current_admin="$(detect_caddy_admin_address)"' \
  'caddy reload --address "${current_admin}"' \
  'assert_permissioned_caddy_admin_socket' \
  'assert_caddy_live_config_matches_file' \
  'assert_legacy_caddy_admin_listener' \
  'reconcile_stale_caddy_admin_socket'; do
  grep -Fq -- "${required_reload_contract}" <<<"${caddy_reload_flow}" || \
    fail "Caddy current-endpoint reload contract is missing: ${required_reload_contract}"
done
caddy_replace_install_line="$(release_function_step_line replace_installed_caddy_config \
  'install -m 0644 -o root -g root -- "${source_config}" "${next_config}" || return 1')"
caddy_replace_validate_line="$(release_function_step_line replace_installed_caddy_config \
  'caddy validate --config "${next_config}" --adapter caddyfile >/dev/null || return 1')"
caddy_replace_file_sync_line="$(release_function_step_line replace_installed_caddy_config \
  'sync -f "${next_config}" || return 1')"
caddy_replace_commit_line="$(release_function_step_line replace_installed_caddy_config \
  'mv -fT -- "${next_config}" "${installed_caddy_config}" || return 1')"
caddy_replace_parent_sync_line="$(release_function_step_line replace_installed_caddy_config \
  'sync -f "$(dirname -- "${installed_caddy_config}")" || return 1')"
(( caddy_replace_install_line < caddy_replace_validate_line && \
  caddy_replace_validate_line < caddy_replace_file_sync_line && \
  caddy_replace_file_sync_line < caddy_replace_commit_line && \
  caddy_replace_commit_line < caddy_replace_parent_sync_line )) || \
  fail 'Caddy config replacement must validate and fsync file before rename and parent fsync'
caddy_harden_verify_line="$(release_function_step_line harden_edge \
  'verify_edge_recovery_snapshots ||')"
caddy_harden_reconcile_line="$(release_function_step_line harden_edge \
  'reconcile_stale_caddy_admin_socket ||')"
caddy_harden_mutate_line="$(release_function_step_line harden_edge \
  'replace_installed_caddy_config "${hardened_caddy}"')"
(( caddy_harden_verify_line < caddy_harden_reconcile_line && \
  caddy_harden_reconcile_line < caddy_harden_mutate_line )) || \
  fail 'Caddy stale-socket reconciliation requires committed edge recovery before host mutation'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  caddy_admin_socket="${harness_root}/admin.sock"
  edge_recovery_marker="${harness_root}/edge.pending"
  apply_rollback=false
  socket_state=stale
  unlink_log="${harness_root}/unlink.log"
  sync_log="${harness_root}/sync.log"
  legacy_check_log="${harness_root}/legacy.log"
  : >"${unlink_log}"
  : >"${sync_log}"
  : >"${legacy_check_log}"
  verify_edge_recovery_snapshots() { [[ -f "${edge_recovery_marker}" ]]; }
  assert_permissioned_caddy_admin_socket() { [[ "${socket_state}" == active-strict ]]; }
  caddy_stale_admin_socket_is_safe() { [[ "${socket_state}" == stale ]]; }
  assert_legacy_caddy_admin_listener() {
    printf "called\n" >"${legacy_check_log}"
    [[ ! -e "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]]
  }
  unlink() {
    [[ "$1" == -- && "$#" == 2 ]]
    printf "%s\n" "$2" >>"${unlink_log}"
    command rm -f -- "$2"
  }
  sync() {
    [[ "$1" == -f && "$#" == 2 ]]
    printf "%s\n" "$2" >>"${sync_log}"
  }

  : >"${caddy_admin_socket}"
  if (reconcile_stale_caddy_admin_socket >/dev/null 2>&1); then exit 1; fi
  [[ -f "${caddy_admin_socket}" && ! -s "${unlink_log}" ]]

  apply_rollback=true
  if (reconcile_stale_caddy_admin_socket >/dev/null 2>&1); then exit 1; fi
  [[ -f "${caddy_admin_socket}" && ! -s "${unlink_log}" ]]

  : >"${edge_recovery_marker}"
  reconcile_stale_caddy_admin_socket
  [[ ! -e "${caddy_admin_socket}" ]]
  [[ "$(<"${unlink_log}")" == "${caddy_admin_socket}" ]]
  [[ "$(<"${sync_log}")" == "${harness_root}" ]]
  [[ "$(<"${legacy_check_log}")" == called ]]

  for socket_state in active-strict unsafe-owner unsafe-mode symlink active-unix; do
    : >"${caddy_admin_socket}"
    : >"${unlink_log}"
    : >"${sync_log}"
    if [[ "${socket_state}" == active-strict ]]; then
      reconcile_stale_caddy_admin_socket
    elif (reconcile_stale_caddy_admin_socket >/dev/null 2>&1); then
      exit 1
    fi
    [[ -f "${caddy_admin_socket}" && ! -s "${unlink_log}" && ! -s "${sync_log}" ]]
  done
' _ "${caddy_reconcile_admin_socket_flow}" || \
  fail 'stale Caddy admin socket reconciliation harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  installed_caddy_config="${harness_root}/Caddyfile"
  caddy_admin_socket="${harness_root}/admin.sock"
  caddy_service=caddy.service
  printf "config\n" >"${installed_caddy_config}"
  : >"${caddy_admin_socket}"
  fail() { exit 91; }
  expected_json='\''{"apps":{"http":{}}}'\''
  live_json=${expected_json}
  detected_admin=unix/current.sock
  config_contract_mode=secure
  permissioned=true
  legacy_ready=true
  reconcile_called="${harness_root}/reconcile-called"
  reload_address_log="${harness_root}/reload-address"
  assert_permissioned_caddy_admin_socket() { [[ "${permissioned}" == true ]]; }
  detect_caddy_admin_address() { printf "%s\n" "${detected_admin}"; }
  verify_caddy_config_contract() { [[ "$3" == "${config_contract_mode}" ]]; }
  assert_legacy_caddy_admin_listener() {
    [[ "${legacy_ready}" == true || -f "${reconcile_called}" ]]
  }
  reconcile_stale_caddy_admin_socket() { : >"${reconcile_called}"; }
  timeout() { shift 4; "$@"; }
  systemctl() { printf "active\n"; }
  sleep() { :; }
  caddy() {
    case "$1" in
      adapt) printf "%s\n" "${expected_json}" ;;
      reload)
        [[ "$2" == --address ]]
        printf "%s\n" "$3" >"${reload_address_log}"
        ;;
      *) return 1 ;;
    esac
  }
  curl() { printf "%s\n" "${live_json}"; }

  assert_caddy_live_config_matches_file
  live_json='\''{"apps":{"tls":{}}}'\''
  if (assert_caddy_live_config_matches_file >/dev/null 2>&1); then exit 1; fi
  live_json=${expected_json}

  reload_caddy_edge
  [[ "$(<"${reload_address_log}")" == "${detected_admin}" ]]

  config_contract_mode=legacy
  detected_admin=127.0.0.1:2019
  permissioned=false
  legacy_ready=true
  reload_caddy_edge
  [[ "$(<"${reload_address_log}")" == "${detected_admin}" ]]

  legacy_ready=false
  reload_caddy_edge
  [[ -f "${reconcile_called}" ]]

  config_contract_mode=secure
  detected_admin=unix/current.sock
  permissioned=true
  live_json='\''{"apps":{"tls":{}}}'\''
  if (reload_caddy_edge >/dev/null 2>&1); then exit 1; fi
' _ "${caddy_live_config_flow}" "${caddy_reload_flow}" || \
  fail 'Caddy current-endpoint reload and live-config harness failed'
for required_udp_contract in \
  'ss -H -lunp "sport = :${port}"' \
  '[[ -z "${listeners}" ]]'; do
  grep -Fq "${required_udp_contract}" <<<"${udp_listener_flow}" || \
    fail "public UDP exclusion contract is missing: ${required_udp_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  fail() { return 1; }
  ss() { printf "%s" "${mock_udp}"; }
  mock_udp=""
  assert_no_public_udp_listener 443
  mock_udp="UNCONN 0 0 *:443 *:* users:((\"caddy\",pid=1,fd=8))"
  if assert_no_public_udp_listener 443 >/dev/null 2>&1; then
    exit 1
  fi
' _ "${udp_listener_flow}" || \
  fail 'public UDP exclusion harness failed'
for required_staged_edge_contract in \
  'verify_caddy_config_contract "${tracked_caddy_config}" tracked' \
  'verify_caddy_config_contract "${installed_caddy_config}" installed' \
  'assert_no_public_udp_listener 443' \
  'assert_docker_network_contract cometa-bank_edge allow-missing' \
  'assert_docker_network_contract cometa-bank_egress allow-missing' \
  'assert_docker_network_contract cometa-bank_public allow-missing' \
  'assert_running_compose_service_bindings web allow-zero' \
  'assert_running_compose_service_bindings bot allow-zero' \
  'verify_nginx_real_ip_contract "${live_config}"'; do
  grep -Fq "${required_staged_edge_contract}" <<<"${staged_edge_combined_flow}" || \
    fail "staged edge drift guard is missing: ${required_staged_edge_contract}"
done
for required_running_service_contract in \
  "[[ \"\${service_name}\" == 'web' || \"\${service_name}\" == 'bot' ]]" \
  "--filter 'label=com.docker.compose.project=cometa-bank'" \
  '--filter "label=com.docker.compose.service=${service_name}"' \
  "--filter 'status=running'" \
  '[[ "${container_count}" == '\''1'\'' ]]' \
  'could not count running cometa-bank ${service_name} containers' \
  'container count is invalid' \
  '[[ "${container_id}" =~ ^[a-f0-9]{12,64}$ ]]'; do
  grep -Fq -- "${required_running_service_contract}" <<<"${running_service_container_flow}" || \
    fail "running Compose service cardinality guard is missing: ${required_running_service_contract}"
done
for required_runtime_binding_contract in \
  'container_id="$(running_compose_service_container_id \' \
  "docker inspect --format '{{.HostConfig.NetworkMode}}'" \
  '"${network_mode}" != '\''host'\''' \
  '"${network_mode}" != container:*' \
  "docker inspect --format '{{json .NetworkSettings.Networks}}'" \
  '(keys | sort) == ["cometa-bank_edge", "cometa-bank_public"]' \
  '(keys | sort) == ["cometa-bank_edge", "cometa-bank_egress"]' \
  'has($network_mode)' \
  'network_names="$(jq -r '\''keys[]'\'' <<<"${networks_json}")" ||' \
  "docker network inspect --format '{{json .}}'" \
  '.Driver == "bridge"' \
  '.Scope == "local"' \
  '.Ingress == false' \
  '.Attachable == false' \
  '((.ConfigOnly // false) == false)' \
  '((.ConfigFrom.Network // "") == "")' \
  '.IPAM.Driver == "default"' \
  '((.IPAM.Options // {}) == {})' \
  '.EnableIPv4 == true' \
  '.EnableIPv6 == false' \
  '(.IPAM.Config | type == "array" and length == 1)' \
  '.Internal == ($logical == "edge")' \
  '.Labels["com.docker.compose.project"] == "cometa-bank"' \
  '.Labels["com.docker.compose.network"] == $logical' \
  '.Options == {' \
  "docker inspect --format '{{json .HostConfig.PortBindings}}'" \
  '(keys | sort) == ["8080/tcp", "8443/tcp"]' \
  '.["8080/tcp"] == [{"HostIp":"127.0.0.1","HostPort":"8080"}]' \
  '.["8443/tcp"] == [{"HostIp":"127.0.0.1","HostPort":"8443"}]' \
  '(. // {}) | type == "object" and length == 0'; do
  grep -Fq -- "${required_runtime_binding_contract}" <<<"${runtime_network_combined_flow}" || \
    fail "running Compose port-binding guard is missing: ${required_runtime_binding_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  network_inspect_log="${harness_root}/network-inspect.log"
  : >"${network_inspect_log}"
  fail() { printf "runtime network harness: %s\n" "$1" >&2; exit 91; }
  mock_web_ids=aaaaaaaaaaaa
  mock_bot_ids=bbbbbbbbbbbb
  mock_web_bindings='\''{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}],"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}'\''
  mock_bot_bindings='\''{}'\''
  mock_web_network_mode=cometa-bank_public
  mock_bot_network_mode=cometa-bank_edge
  mock_web_networks='\''{"cometa-bank_edge":{},"cometa-bank_public":{}}'\''
  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{}}'\''
  mock_edge_driver=bridge
  mock_edge_gateway_mode=
  mock_edge_ipam_driver=default
  mock_enable_ipv6=false
  mock_ipam_subnet=172.30.0.0/16
  mock_ipam_gateway=172.30.0.1
  mock_partial_jq=false
  mock_awk_fail=false
  awk() {
    if [[ "${mock_awk_fail}" == true ]]; then return 42; fi
    command awk "$@"
  }
  jq() {
    if [[ "${mock_partial_jq}" == true && "${1:-}" == -r && \
      "${2:-}" == '\''keys[]'\'' ]]; then
      printf "%s\n" cometa-bank_edge
      return 1
    fi
    command jq "$@"
  }
  docker() {
    case "$1" in
      ps)
        if [[ "$*" == *"service=web"* ]]; then
          printf "%s\n" "${mock_web_ids}"
        elif [[ "$*" == *"service=bot"* ]]; then
          printf "%s\n" "${mock_bot_ids}"
        else
          return 1
        fi
        ;;
      inspect)
        case "${3:-}" in
          "{{.HostConfig.NetworkMode}}")
            case "${4:-}" in
              aaaaaaaaaaaa) printf "%s\n" "${mock_web_network_mode}" ;;
              bbbbbbbbbbbb) printf "%s\n" "${mock_bot_network_mode}" ;;
              *) return 1 ;;
            esac
            ;;
          "{{json .NetworkSettings.Networks}}")
            case "${4:-}" in
              aaaaaaaaaaaa) printf "%s\n" "${mock_web_networks}" ;;
              bbbbbbbbbbbb) printf "%s\n" "${mock_bot_networks}" ;;
              *) return 1 ;;
            esac
            ;;
          "{{json .HostConfig.PortBindings}}")
            case "${4:-}" in
              aaaaaaaaaaaa) printf "%s\n" "${mock_web_bindings}" ;;
              bbbbbbbbbbbb) printf "%s\n" "${mock_bot_bindings}" ;;
              *) return 1 ;;
            esac
            ;;
          *) return 1 ;;
        esac
        ;;
      network)
        case "${2:-}" in
          ls)
            [[ "${3:-}" == --format && "${4:-}" == "{{.Name}}" ]] || return 1
            printf "%s\n" cometa-bank_edge cometa-bank_egress cometa-bank_public
            return 0
            ;;
          inspect)
            [[ "${3:-}" == --format && "${4:-}" == "{{json .}}" && \
              "${5:-}" == cometa-bank_* ]] || return 1
            mock_network_name=${5}
            ;;
          *) return 1 ;;
        esac
        logical_name=${mock_network_name#cometa-bank_}
        printf "%s\n" "${mock_network_name}" >>"${network_inspect_log}"
        network_driver=bridge
        internal=false
        icc=false
        if [[ "${logical_name}" == edge ]]; then
          network_driver=${mock_edge_driver}
          internal=true
          icc=true
        fi
        jq -cn \
          --arg name "${mock_network_name}" \
          --arg logical "${logical_name}" \
          --arg driver "${network_driver}" \
          --arg icc "${icc}" \
          --arg gateway_mode "${mock_edge_gateway_mode}" \
          --arg ipam_driver "${mock_edge_ipam_driver}" \
          --arg subnet "${mock_ipam_subnet}" \
          --arg gateway "${mock_ipam_gateway}" \
          --argjson enable_ipv6 "${mock_enable_ipv6}" \
          --argjson internal "${internal}" '\''
            {Name:$name,Driver:$driver,Scope:"local",Internal:$internal,
             EnableIPv4:true,EnableIPv6:$enable_ipv6,
             Ingress:false,Attachable:false,ConfigOnly:false,ConfigFrom:{Network:""},
             IPAM:{Driver:$ipam_driver,Options:null,Config:[{Subnet:$subnet,Gateway:$gateway}]},
             Labels:{"com.docker.compose.project":"cometa-bank","com.docker.compose.network":$logical},
             Options:({"com.docker.network.bridge.enable_icc":$icc}
               + if $gateway_mode == "" then {}
                 else {"com.docker.network.bridge.gateway_mode_ipv4":$gateway_mode}
                 end)}
          '\''
        ;;
      *) return 1 ;;
    esac
  }
  assert_running_compose_service_bindings web
  assert_running_compose_service_bindings bot
  [[ "$(sort -u "${network_inspect_log}" | wc -l | tr -d "[:space:]")" == 3 ]] || {
    printf "runtime network harness inspected:\n" >&2
    sort -u "${network_inspect_log}" >&2
    exit 92
  }
  mock_awk_fail=true
  if (running_compose_service_container_id bot allow-zero >/dev/null 2>&1); then
    printf "runtime network harness accepted unknown allow-zero cardinality\n" >&2
    exit 1
  fi
  mock_awk_fail=false
  mock_partial_jq=true
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted partial jq attachment output\n" >&2
    exit 1
  fi
  mock_partial_jq=false
  mock_web_bindings='\''{"8080/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}],"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}'\''
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted public web binding\n" >&2
    exit 1
  fi
  mock_web_bindings='\''{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}],"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"8443"}]}'\''
  mock_bot_bindings='\''{"8787/tcp":[{"HostIp":"127.0.0.1","HostPort":"8787"}]}'\''
  if (assert_running_compose_service_bindings bot >/dev/null 2>&1); then
    printf "runtime network harness accepted bot binding\n" >&2
    exit 1
  fi
  mock_bot_bindings='\''{}'\''
  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{},"cometa-bank_public":{}}'\''
  if (assert_running_compose_service_bindings bot >/dev/null 2>&1); then
    printf "runtime network harness accepted extra attachment\n" >&2
    exit 1
  fi
  mock_bot_networks='\''{"cometa-bank_edge":{},"cometa-bank_egress":{}}'\''
  mock_bot_network_mode=host
  if (assert_running_compose_service_bindings bot >/dev/null 2>&1); then
    printf "runtime network harness accepted host network mode\n" >&2
    exit 1
  fi
  mock_bot_network_mode=bridge
  if (assert_running_compose_service_bindings bot >/dev/null 2>&1); then
    printf "runtime network harness accepted an unattached primary network mode\n" >&2
    exit 1
  fi
  mock_bot_network_mode=cometa-bank_edge
  mock_edge_ipam_driver=plugin
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted custom IPAM driver\n" >&2
    exit 1
  fi
  mock_edge_ipam_driver=default
  mock_enable_ipv6=true
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted IPv6 network\n" >&2
    exit 1
  fi
  mock_enable_ipv6=false
  mock_ipam_subnet=10.0.0.0/7
  mock_ipam_gateway=10.0.0.1
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted overbroad private IPAM subnet\n" >&2
    exit 1
  fi
  mock_ipam_subnet=203.0.113.0/24
  mock_ipam_gateway=203.0.113.1
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted public IPAM subnet\n" >&2
    exit 1
  fi
  mock_ipam_subnet=172.30.0.0/16
  mock_ipam_gateway=172.30.0.1
  mock_edge_gateway_mode=routed
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted routed gateway mode\n" >&2
    exit 1
  fi
  mock_edge_gateway_mode=
  mock_edge_driver=macvlan
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted macvlan\n" >&2
    exit 1
  fi
  mock_edge_driver=bridge
  mock_web_ids=$'\''aaaaaaaaaaaa\ncccccccccccc'\''
  if (assert_running_compose_service_bindings web >/dev/null 2>&1); then
    printf "runtime network harness accepted duplicate container\n" >&2
    exit 1
  fi
' _ "${running_service_container_flow}" "${docker_network_contract_flow}" \
  "${runtime_binding_flow}" || \
  fail 'running Compose service binding harness failed'
for required_edge_contract in \
  'verify_caddy_config_contract "${tracked_caddy_config}" tracked' \
  'verify_caddy_config_contract "${installed_caddy_config}" installed' \
  'systemctl is-enabled "${caddy_service}"' \
  '[[ "${caddy_enablement}" == '\''enabled'\'' ]]' \
  'systemctl show --property ActiveState --value "${caddy_service}"' \
  '[[ "${caddy_active_state}" == '\''active'\'' ]]' \
  'assert_public_tcp_listener_owned_by_caddy 80' \
  'assert_public_tcp_listener_owned_by_caddy 443' \
  'check_docker_daemon_perimeter_contract' \
  'assert_running_compose_service_bindings web allow-zero' \
  'assert_running_compose_service_bindings bot allow-zero' \
  'assert_legacy_certbot_units_quiesced'; do
  grep -Fq "${required_edge_contract}" <<<"${staged_edge_combined_flow}" || \
    fail "staged Caddy edge guard is missing: ${required_edge_contract}"
done
for staged_probe_flow in \
  "${caddy_contract_flow}" \
  "${legacy_unit_flow}" \
  "${legacy_units_guard_flow}" \
  "${listener_contract_flow}" \
  "${running_service_container_flow}" \
  "${docker_network_contract_flow}" \
  "${runtime_binding_flow}" \
  "${staged_edge_host_flow}" \
  "${staged_edge_flow}"; do
  reject_rg_match \
    'staged Caddy edge probes must remain read-only' \
    'systemctl[[:space:]]+(enable|disable|start|stop|restart|reload|mask|unmask|reenable|preset|daemon-reload)|caddy[[:space:]]+(reload|start|stop|run|fmt)|(^|[[:space:]])(install|mv|rm)[[:space:]]' \
    <(printf '%s\n' "${staged_probe_flow}")
done

for required_compose_edge_contract in \
  '[[ -f "${target_compose}" && ! -L "${target_compose}" ]]' \
  'docker compose -f "${target_compose}" --profile tools config --format json' \
  '{hostIp: "127.0.0.1", published: "8080", target: "8080", protocol: "tcp"}' \
  '{hostIp: "127.0.0.1", published: "8443", target: "8443", protocol: "tcp"}' \
  '.services | to_entries[] | select(.key != "web") | .value.ports[]?' \
  '.services | to_entries[] | select((.value.network_mode // "") != "")' \
  '(.services | keys | sort) == ["bot", "certbot", "web"]' \
  '(.services.web.networks | keys | sort) == ["edge", "public"]' \
  '(.services.bot.networks | keys | sort) == ["edge", "egress"]' \
  '(.services.certbot.networks | keys | sort) == ["egress"]' \
  '(.networks | keys | sort) == ["edge", "egress", "public"]' \
  '((.attachable // false) == false)' \
  'has("enable_ipv4")' \
  'has("enable_ipv6")' \
  '((.ipam // {}) == {})' \
  '.networks.edge.driver_opts == {"com.docker.network.bridge.enable_icc":"true"}' \
  'all(.networks[]; ((.ipam.config // []) | length) == 0)' \
  'bridge-network contract'; do
  grep -Fq "${required_compose_edge_contract}" <<<"${compose_edge_contract_flow}" || \
    fail "runtime release Compose edge guard is missing: ${required_compose_edge_contract}"
done
reject_rg_match \
  'runtime release Compose edge guard must remain read-only' \
  'docker[[:space:]]+compose[^\n]*[[:space:]]+(up|build|pull|run|restart|stop|down)([[:space:]]|$)' \
  <(printf '%s\n' "${compose_edge_contract_flow}")
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  scratch_directory="${harness_root}/scratch"
  compose_relative="deploy/standalone/compose.yaml"
  target_release=20990101T000000Z
  target_compose="${deploy_root}/releases/${target_release}/${compose_relative}"
  mkdir -p "$(dirname -- "${target_compose}")" "${scratch_directory}"
  : >"${target_compose}"
  fail() { exit 91; }
  docker() { printf "%s\n" "${mock_compose}"; }
  valid_compose='\''{
    "name":"cometa-bank",
    "services":{
      "web":{"ports":[
        {"host_ip":"127.0.0.1","published":"8080","target":8080,"protocol":"tcp"},
        {"host_ip":"127.0.0.1","published":"8443","target":8443,"protocol":"tcp"}
      ],"networks":{"edge":null,"public":null}},
      "bot":{"networks":{"edge":{"aliases":["cometa-bank-bot"]},"egress":{}}},
      "certbot":{"networks":{"egress":{}}}
    },
    "networks":{
      "edge":{"name":"cometa-bank_edge","driver":"bridge","internal":true,"driver_opts":{"com.docker.network.bridge.enable_icc":"true"},"ipam":{}},
      "egress":{"name":"cometa-bank_egress","driver":"bridge","driver_opts":{"com.docker.network.bridge.enable_icc":"false"},"ipam":{}},
      "public":{"name":"cometa-bank_public","driver":"bridge","driver_opts":{"com.docker.network.bridge.enable_icc":"false"},"ipam":{}}
    }
  }'\''
  mock_compose=${valid_compose}
  verify_release_compose_edge_contract "${target_release}"
  for mutation in \
    '\''.name = "other-project"'\'' \
    '\''.services.web.ports[0].host_ip = "0.0.0.0"'\'' \
    '\''.services.bot.ports = [{"host_ip":"127.0.0.1","published":"8787","target":8787,"protocol":"tcp"}]'\'' \
    '\''.services.bot.network_mode = "host"'\'' \
    '\''.services.web.networks.egress = {}'\'' \
    '\''.networks.edge.driver = "macvlan"'\'' \
    '\''.networks.public.attachable = true'\'' \
    '\''.networks.public.enable_ipv4 = false'\'' \
    '\''.networks.public.enable_ipv6 = true'\'' \
    '\''.networks.public.ipam = {"driver":"plugin","config":[]}'\'' \
    '\''.networks.public.ipam = {"driver":"default","config":[{"subnet":"10.56.0.0/24"}]}'\''; do
    mock_compose="$(jq -c "${mutation}" <<<"${valid_compose}")"
    if (verify_release_compose_edge_contract "${target_release}" >/dev/null 2>&1); then
      exit 1
    fi
  done
  command rm -f -- "${target_compose}"
  ln -s /dev/null "${target_compose}"
  if (verify_release_compose_edge_contract "${target_release}" >/dev/null 2>&1); then
    exit 1
  fi
' _ "${compose_edge_contract_flow}" || \
  fail 'runtime release Compose edge contract harness failed'

for staged_compose_pair in \
  prepare_release \
  activate_release \
  rollback_release \
  show_ledger_mode_status \
  enable_server_ledger_mode; do
  staged_compose_body="$(release_function_body "${staged_compose_pair}")"
  grep -Fq 'verify_release_compose_edge_contract "${current_release}"' \
    <<<"${staged_compose_body}" || \
    fail "${staged_compose_pair} must validate the current release Compose edge"
done
for staged_compose_pair in \
  rollback_release \
  show_ledger_mode_status \
  enable_server_ledger_mode; do
  staged_compose_body="$(release_function_body "${staged_compose_pair}")"
  grep -Fq 'verify_release_compose_edge_contract "${previous_release}"' \
    <<<"${staged_compose_body}" || \
    fail "${staged_compose_pair} must validate the previous release Compose edge"
done
for staged_candidate_function in prepare_release activate_release; do
  staged_candidate_body="$(release_function_body "${staged_candidate_function}")"
  grep -Fq 'verify_release_compose_edge_contract "${release_id}"' \
    <<<"${staged_candidate_body}" || \
    fail "${staged_candidate_function} must validate the candidate release Compose edge"
done
grep -Fq 'verify_release_compose_edge_contract "${previous_release}"' \
  <<<"${rollback_runtime_body}" || \
  fail 'runtime rollback must validate its target release Compose edge'
show_status_body="$(release_function_body show_status)"
for show_status_release in current_release previous_release; do
  grep -Fq "verify_release_compose_edge_contract \"\${${show_status_release}}\"" \
    <<<"${show_status_body}" || \
    fail "status must validate the ${show_status_release%_release} release Compose edge"
done
for status_manifest_release in current_release previous_release; do
  grep -Fq "verify_release_images \"\${${status_manifest_release}}\"" \
    <<<"${show_status_body}" || \
    fail "status must verify the ${status_manifest_release%_release} immutable image manifest"
done
status_current_manifest_line="$(release_function_step_line show_status \
  'verify_release_images "${current_release}"')"
status_previous_manifest_line="$(release_function_step_line show_status \
  'verify_release_images "${previous_release}"')"
status_service_health_line="$(release_function_step_line show_status \
  'service_health "${current_release}" bot')"
(( status_current_manifest_line < status_service_health_line && \
  status_previous_manifest_line < status_service_health_line )) || \
  fail 'status must verify current and previous immutable manifests before service health'

tracked_caddy_config="${project_root}/deploy/standalone/caddy/Caddyfile"
[[ -f "${tracked_caddy_config}" && ! -L "${tracked_caddy_config}" ]] || \
  fail 'tracked Caddy compatibility config is missing or symlinked'
for required_release_constant in \
  "readonly caddy_service='caddy.service'" \
  "readonly installed_caddy_config='/etc/caddy/Caddyfile'" \
  'readonly tracked_caddy_config="${release_root}/deploy/standalone/caddy/Caddyfile"'; do
  grep -Fq "${required_release_constant}" "${standalone_release_script}" || \
    fail "staged Caddy release constant is missing: ${required_release_constant}"
done
for required_release_command in caddy jq sha256sum ss timeout; do
  rg --quiet \
    "for command_name in .*${required_release_command}.*; do" \
    "${standalone_release_script}" || \
    fail "staged release must preflight its ${required_release_command} dependency"
done
for caddy_domain in euphoria.bot www.euphoria.bot; do
  awk -v domain="${caddy_domain}" '
    $0 == domain " {" { in_site = 1; next }
    in_site && $0 == "}" { exit }
    in_site && $0 ~ /^[[:space:]]*reverse_proxy[[:space:]]/ {
      proxy_count += 1
      if ($0 ~ /^[[:space:]]*reverse_proxy https:\/\/127[.]0[.]0[.]1:8443[[:space:]]*\{[[:space:]]*$/) {
        found_upstream = 1
      } else {
        found_unexpected_upstream = 1
      }
    }
    in_site && $0 ~ /^[[:space:]]*header_up Host \{host\}[[:space:]]*$/ { found_host = 1 }
    in_site && $0 ~ /^[[:space:]]*transport http \{[[:space:]]*$/ { found_transport = 1 }
    in_site && $0 ~ /^[[:space:]]*tls[[:space:]]*$/ { found_tls = 1 }
    in_site && $0 ~ "^[[:space:]]*tls_server_name " domain "[[:space:]]*$" {
      found_server_name = 1
    }
    in_site && $0 ~ /^[[:space:]]*tls_insecure_skip_verify[[:space:]]*$/ {
      found_tls_bypass = 1
    }
    in_site && tolower($0) ~ /strict-transport-security/ { found_hsts = 1 }
    END {
      exit !(proxy_count == 1 && found_upstream && !found_unexpected_upstream &&
        found_host && found_transport && found_tls && found_server_name &&
        !found_tls_bypass && !found_hsts)
    }
  ' "${tracked_caddy_config}" || \
    fail "tracked Caddy config must preserve the exact ${caddy_domain} HTTPS loopback route"
done
[[ "$(grep -Fxc $'\t\tprotocols h1 h2' "${tracked_caddy_config}")" == '1' ]] || \
  fail 'tracked Caddy bridge must disable HTTP/3 exactly once'
reject_rg_match \
  'tracked Caddy bridge must authenticate its loopback upstream' \
  --fixed-strings tls_insecure_skip_verify "${tracked_caddy_config}"

for required_edge_hardening_contract in \
  'assert_no_pending_link_intent' \
  'check_docker_daemon_perimeter_contract' \
  'read_edge_recovery_marker' \
  'verify_served_inner_certificates' \
  'verify_release_images "${current_release}"' \
  'assert_running_compose_service_bindings bot' \
  'current bot service must remain healthy while edge hardening recovery is pending' \
  'prepare_hardened_caddy_config "${installed_caddy_config}" "${hardened_caddy}"' \
  'prepare_hardened_nginx_config "${live_config}" "${hardened_nginx}"' \
  'replace_installed_caddy_config "${hardened_caddy}"' \
  'assert_no_public_udp_listener 443' \
  'install_live_config "${hardened_nginx}"' \
  'restart_current_web "${current_release}"' \
  '"${installed_caddy_config}" "${live_config}" "${current_release}"' \
  'verify_edge_recovery_snapshots' \
  'retire_edge_recovery_snapshots' \
  'assert_staged_edge_contract' \
  'edge hardening failed; restoring both configuration snapshots' \
  'replace_installed_caddy_config "${original_caddy}"'; do
  grep -Fq "${required_edge_hardening_contract}" <<<"${edge_hardening_flow}" || \
    fail "edge hardening transaction is missing: ${required_edge_hardening_contract}"
done
for required_restart_contract in \
  '--no-deps' \
  '--force-recreate web' \
  'wait_for_services "${current_release}" web' \
  'service_health "${current_release}" bot'; do
  grep -Fq -- "${required_restart_contract}" <<<"${restart_current_web_flow}" || \
    fail "edge hardening web restart is missing: ${required_restart_contract}"
done
for required_edge_recovery_contract in \
  'install -d -m 0700 -o root -g root -- "${edge_recovery_root}"' \
  'printf '\''operator %s\ncurrent %s\ncaddy-sha256 %s\nnginx-sha256 %s\n'\''' \
  'sync -f "${next_caddy}"' \
  'sync -f "${next_nginx}"' \
  'sync -f "${edge_recovery_root}"' \
  'mv -fT -- "${next_marker}" "${edge_recovery_marker}"' \
  'verify_edge_recovery_snapshots'; do
  grep -Fq -- "${required_edge_recovery_contract}" <<<"${edge_recovery_arm_flow}" || \
    fail "durable edge recovery arming is missing: ${required_edge_recovery_contract}"
done
edge_snapshot_caddy_sync_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'sync -f "${next_caddy}" || return 1')"
edge_snapshot_nginx_sync_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'sync -f "${next_nginx}" || return 1')"
edge_snapshot_marker_sync_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'sync -f "${next_marker}" || return 1')"
edge_snapshot_caddy_commit_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'mv -fT -- "${next_caddy}" "${edge_recovery_caddy}" || return 1')"
edge_snapshot_nginx_commit_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'mv -fT -- "${next_nginx}" "${edge_recovery_nginx}" || return 1')"
edge_snapshot_flush_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'sync -f "${edge_recovery_root}" || return 1' first)"
edge_marker_commit_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'mv -fT -- "${next_marker}" "${edge_recovery_marker}" || return 1')"
edge_marker_flush_line="$(release_function_step_line arm_edge_recovery_snapshots \
  'sync -f "${edge_recovery_root}" || return 1' last)"
(( edge_snapshot_caddy_sync_line < edge_snapshot_nginx_sync_line && \
  edge_snapshot_nginx_sync_line < edge_snapshot_marker_sync_line && \
  edge_snapshot_marker_sync_line < edge_snapshot_caddy_commit_line && \
  edge_snapshot_caddy_commit_line < edge_snapshot_nginx_commit_line && \
  edge_snapshot_nginx_commit_line < edge_snapshot_flush_line && \
  edge_snapshot_flush_line < edge_marker_commit_line && \
  edge_marker_commit_line < edge_marker_flush_line )) || \
  fail 'edge snapshots must commit and flush before the durable marker is published'
for required_edge_snapshot_guard in \
  '[[ -f "${edge_recovery_marker}" && ! -L "${edge_recovery_marker}" ]]' \
  '[[ -f "${edge_recovery_caddy}" && ! -L "${edge_recovery_caddy}" ]]' \
  '[[ -f "${edge_recovery_nginx}" && ! -L "${edge_recovery_nginx}" ]]' \
  'caddy validate --config "${edge_recovery_caddy}" --adapter caddyfile'; do
  grep -Fq -- "${required_edge_snapshot_guard}" <<<"${edge_recovery_validation_flow}" || \
    fail "durable edge recovery validation is missing: ${required_edge_snapshot_guard}"
done
for required_edge_marker_guard in \
  '[[ "$(awk '\''END { print NR + 0 }'\'' "${edge_recovery_marker}")" == '\''4'\'' ]]' \
  '^operator[[:space:]]([0-9]{8}T[0-9]{6}Z)$' \
  '^current[[:space:]]([0-9]{8}T[0-9]{6}Z)$' \
  '^caddy-sha256[[:space:]]([a-f0-9]{64})$' \
  '^nginx-sha256[[:space:]]([a-f0-9]{64})$' \
  '[[ "${operator_release}" == "${release_id}" ]]' \
  'sha256sum "${edge_recovery_caddy}"' \
  'sha256sum "${edge_recovery_nginx}"'; do
  grep -Fq -- "${required_edge_marker_guard}" <<<"${edge_recovery_read_flow}" || \
    fail "durable edge marker validation is missing: ${required_edge_marker_guard}"
done
grep -Fq 'edge hardening recovery is pending at ${edge_recovery_marker}' \
  <<<"${edge_pending_guard_flow}" || \
  fail 'pending edge hardening must fail every non-recovery lifecycle path closed'
grep -Fq 'if [[ "${action}" != '\''harden-edge'\'' ]]' "${standalone_release_script}" || \
  fail 'every non-hardening release action must run the global pending-edge gate'
grep -Fq 'assert_no_pending_edge_recovery' "${standalone_release_script}" || \
  fail 'release dispatcher must invoke the global pending-edge gate'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  release_id=20990102T000000Z
  current_release=20990101T000000Z
  edge_recovery_root="${deploy_root}/state/edge-hardening-recovery"
  edge_recovery_marker="${edge_recovery_root}/pending"
  edge_recovery_caddy="${edge_recovery_root}/Caddyfile.original"
  edge_recovery_nginx="${edge_recovery_root}/nginx.original.conf"
  edge_recovery_marker_next="${edge_recovery_marker}.next"
  edge_recovery_caddy_next="${edge_recovery_caddy}.next"
  edge_recovery_nginx_next="${edge_recovery_nginx}.next"
  mkdir -p \
    "${edge_recovery_root}" \
    "${deploy_root}/releases/${release_id}" \
    "${deploy_root}/releases/${current_release}"
  printf "original-caddy\n" >"${edge_recovery_caddy}"
  printf "original-nginx\n" >"${edge_recovery_nginx}"
  caddy_hash="$(sha256sum "${edge_recovery_caddy}" | awk '\''{print $1}'\'')"
  nginx_hash="$(sha256sum "${edge_recovery_nginx}" | awk '\''{print $1}'\'')"
  printf "operator %s\ncurrent %s\ncaddy-sha256 %s\nnginx-sha256 %s\n" \
    "${release_id}" "${current_release}" "${caddy_hash}" "${nginx_hash}" \
    >"${edge_recovery_marker}"
  stat() {
    [[ "$1" == -c && "$2" == "%a:%u:%g" ]]
    if [[ "$3" == "${edge_recovery_root}" ]]; then
      printf "700:0:0\n"
    else
      printf "600:0:0\n"
    fi
  }
  [[ "$(read_edge_recovery_marker)" == "${release_id} ${current_release}" ]]
  printf "tampered\n" >>"${edge_recovery_caddy}"
  if (read_edge_recovery_marker >/dev/null 2>&1); then
    exit 1
  fi
  printf "original-caddy\n" >"${edge_recovery_caddy}"
  release_id=20990103T000000Z
  mkdir -p "${deploy_root}/releases/${release_id}"
  if (read_edge_recovery_marker >/dev/null 2>&1); then
    exit 1
  fi
' _ "${edge_recovery_read_flow}" || \
  fail 'edge recovery marker identity and snapshot-hash harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  edge_recovery_marker="${harness_root}/pending"
  edge_recovery_marker_next="${edge_recovery_marker}.next"
  edge_recovery_caddy_next="${harness_root}/Caddyfile.original.next"
  edge_recovery_nginx_next="${harness_root}/nginx.original.conf.next"
  fail() { return 1; }
  assert_no_pending_edge_recovery
  for candidate in \
    "${edge_recovery_marker}" "${edge_recovery_marker_next}" \
    "${edge_recovery_caddy_next}" "${edge_recovery_nginx_next}"; do
    : >"${candidate}"
    if (assert_no_pending_edge_recovery >/dev/null 2>&1); then
      exit 1
    fi
    command unlink -- "${candidate}"
    command ln -s /dev/null "${candidate}"
    if (assert_no_pending_edge_recovery >/dev/null 2>&1); then
      exit 1
    fi
    command unlink -- "${candidate}"
    assert_no_pending_edge_recovery
  done
' _ "${edge_pending_guard_flow}" || \
  fail 'global pending-edge lifecycle gate harness failed'
for required_action_intent_guard in \
  'activate)' \
  'rollback transaction is pending at ${rollback_intent_path}' \
  'rollback)' \
  'activation transaction is pending at ${activation_intent_path}' \
  '*) assert_no_pending_link_intent ;;'; do
  grep -Fq -- "${required_action_intent_guard}" <<<"${action_link_intent_guard_flow}" || \
    fail "action-aware link-intent gate is missing: ${required_action_intent_guard}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  activation_intent_path="${harness_root}/activation.pending"
  activation_intent_next="${activation_intent_path}.next"
  rollback_intent_path="${harness_root}/rollback.pending"
  rollback_intent_next="${rollback_intent_path}.next"
  fail() { exit 91; }
  assert_no_pending_link_intent() {
    [[ ! -e "${activation_intent_path}" && ! -L "${activation_intent_path}" && \
      ! -e "${activation_intent_next}" && ! -L "${activation_intent_next}" && \
      ! -e "${rollback_intent_path}" && ! -L "${rollback_intent_path}" && \
      ! -e "${rollback_intent_next}" && ! -L "${rollback_intent_next}" ]] || exit 91
  }

  assert_action_link_intent_contract install-token
  for candidate in "${activation_intent_path}" "${activation_intent_next}"; do
    for candidate_kind in regular symlink; do
      if [[ "${candidate_kind}" == regular ]]; then
        : >"${candidate}"
      else
        command ln -s /dev/null "${candidate}"
      fi
      assert_action_link_intent_contract activate
      if (assert_action_link_intent_contract rollback) >/dev/null 2>&1; then exit 1; fi
      for unrelated_action in prepare install-token status ledger-mode; do
        if (assert_action_link_intent_contract "${unrelated_action}") >/dev/null 2>&1; then
          exit 1
        fi
      done
      command unlink -- "${candidate}"
    done
  done

  for candidate in "${rollback_intent_path}" "${rollback_intent_next}"; do
    for candidate_kind in regular symlink; do
      if [[ "${candidate_kind}" == regular ]]; then
        : >"${candidate}"
      else
        command ln -s /dev/null "${candidate}"
      fi
      assert_action_link_intent_contract rollback
      if (assert_action_link_intent_contract activate) >/dev/null 2>&1; then exit 1; fi
      for unrelated_action in prepare install-token status ledger-mode; do
        if (assert_action_link_intent_contract "${unrelated_action}") >/dev/null 2>&1; then
          exit 1
        fi
      done
      command unlink -- "${candidate}"
    done
  done
  assert_action_link_intent_contract status
' _ "${action_link_intent_guard_flow}" || \
  fail 'action-aware link-intent marker and symlink harness failed'
action_intent_gate_line="$(rg -n --fixed-strings \
  'assert_action_link_intent_contract "${action}"' "${standalone_release_script}")" || \
  fail 'global action-aware link-intent gate is missing before lifecycle dispatch'
action_intent_gate_line=${action_intent_gate_line%%:*}
release_dispatch_line="$(rg -n --fixed-strings 'case "${action}" in' \
  "${standalone_release_script}")" || \
  fail 'release lifecycle dispatcher is missing'
release_dispatch_line=${release_dispatch_line%%:*}
[[ "${action_intent_gate_line}" =~ ^[0-9]+$ && "${release_dispatch_line}" =~ ^[0-9]+$ && \
  "${action_intent_gate_line}" -lt "${release_dispatch_line}" ]] || \
  fail 'action-aware link-intent gate must run before any lifecycle helper dispatch'
for required_candidate_safety in \
  '[[ -d "${candidate_root}" && ! -L "${candidate_root}" ]]' \
  '[[ "${root_metadata}" == '\''700:0:0'\'' ]]' \
  '[[ -f "${candidate_path}" && ! -L "${candidate_path}" ]]' \
  '(( (8#${mode} & 022) == 0 && (8#${mode} & 0400) != 0 ))'; do
  grep -Fq -- "${required_candidate_safety}" <<<"${recovery_candidate_safety_flow}" || \
    fail "recovery staging inode safety is missing: ${required_candidate_safety}"
done
for required_candidate_relation in \
  '(( candidate_size <= expected_size ))' \
  'prefix_path="$(mktemp "${scratch_directory}/recovery-prefix.XXXXXX")"' \
  'head -c "${candidate_size}" -- "${expected_path}" >"${prefix_path}"' \
  'cmp -- "${candidate_path}" "${prefix_path}"' \
  'unlink -- "${prefix_path}"' \
  "printf 'exact\\n'" \
  "printf 'prefix\\n'"; do
  grep -Fq -- "${required_candidate_relation}" <<<"${recovery_candidate_relation_flow}" || \
    fail "recovery staging classification is missing: ${required_candidate_relation}"
done
candidate_promote_chmod_line="$(release_function_step_line promote_recovery_candidate \
  'chmod 0600 -- "${candidate_path}" || return 1')"
candidate_promote_file_sync_line="$(release_function_step_line promote_recovery_candidate \
  'sync -f "${candidate_path}" || return 1')"
candidate_promote_commit_line="$(release_function_step_line promote_recovery_candidate \
  'mv -fT -- "${candidate_path}" "${committed_path}" || return 1')"
candidate_promote_root_sync_line="$(release_function_step_line promote_recovery_candidate \
  'sync -f "${candidate_root}" || return 1')"
(( candidate_promote_chmod_line < candidate_promote_file_sync_line && \
  candidate_promote_file_sync_line < candidate_promote_commit_line && \
  candidate_promote_commit_line < candidate_promote_root_sync_line )) || \
  fail 'recovery candidates must be permissioned and flushed before and after atomic promotion'
for required_promotion_policy in \
  'must-be-absent)' \
  '[[ ! -e "${committed_path}" && ! -L "${committed_path}" ]]' \
  'replace-safe-snapshot)' \
  'recovery_candidate_file_is_safe "${candidate_root}" "${committed_path}"'; do
  grep -Fq -- "${required_promotion_policy}" <<<"${recovery_candidate_promote_flow}" || \
    fail "recovery candidate destination policy is missing: ${required_promotion_policy}"
done
candidate_discard_unlink_line="$(release_function_step_line discard_partial_recovery_candidate \
  'unlink -- "${candidate_path}" || return 1')"
candidate_discard_sync_line="$(release_function_step_line discard_partial_recovery_candidate \
  'sync -f "${candidate_root}" || return 1')"
(( candidate_discard_unlink_line < candidate_discard_sync_line )) || \
  fail 'partial recovery candidates must be unlinked before flushing their journal directory'
for required_activation_candidate_recovery in \
  'activation intent and its staging candidate cannot coexist' \
  'activation staging candidate no longer matches a safe release-link state' \
  'recovery_candidate_relation' \
  'promote_recovery_candidate' \
  'read_activation_intent >/dev/null' \
  'discard_partial_recovery_candidate'; do
  grep -Fq -- "${required_activation_candidate_recovery}" \
    <<<"${activation_candidate_recovery_flow}" || \
    fail "activation staging recovery is missing: ${required_activation_candidate_recovery}"
done
for required_rollback_candidate_recovery in \
  'rollback intent and its staging candidate cannot coexist' \
  'rollback staging candidate no longer matches a safe release-link state' \
  'recovery_candidate_relation' \
  'promote_recovery_candidate' \
  'read_rollback_intent >/dev/null' \
  'discard_partial_recovery_candidate'; do
  grep -Fq -- "${required_rollback_candidate_recovery}" \
    <<<"${rollback_candidate_recovery_flow}" || \
    fail "rollback staging recovery is missing: ${required_rollback_candidate_recovery}"
done
activation_candidate_line="$(release_function_step_line activate_release \
  'recover_activation_intent_candidate')"
activation_pending_line="$(release_function_step_line activate_release \
  'if [[ -e "${activation_intent_path}" || -L "${activation_intent_path}" ]]; then')"
activation_fresh_read_line="$(release_function_step_line activate_release \
  'current_release="$(read_release_link current)"')"
(( activation_candidate_line < activation_pending_line && \
  activation_pending_line < activation_fresh_read_line )) || \
  fail 'activation must recover staging before committed reconciliation and any fresh lifecycle work'
rollback_candidate_gate_line="$(release_function_step_line rollback_release \
  'if [[ -e "${rollback_intent_next}" || -L "${rollback_intent_next}" ]]; then')"
rollback_candidate_recover_line="$(release_function_step_line rollback_release \
  'recover_rollback_intent_candidate')"
rollback_pending_line="$(release_function_step_line rollback_release \
  'if [[ -e "${rollback_intent_path}" || -L "${rollback_intent_path}" ]]; then')"
rollback_fresh_read_line="$(release_function_step_line rollback_release \
  'current_release="$(read_release_link current)"')"
(( rollback_candidate_gate_line < rollback_candidate_recover_line && \
  rollback_candidate_recover_line < rollback_pending_line && \
  rollback_pending_line < rollback_fresh_read_line )) || \
  fail 'rollback must preserve dry-run staging and recover it before committed or fresh work'
edge_staging_gate_line="$(release_function_step_line harden_edge \
  'if edge_recovery_staging_exists; then')"
edge_candidate_recover_line="$(release_function_step_line harden_edge \
  'recover_edge_recovery_candidates "${actual_current}"')"
edge_docker_gate_line="$(release_function_step_line harden_edge \
  'check_docker_daemon_perimeter_contract')"
(( edge_staging_gate_line < edge_candidate_recover_line && \
  edge_candidate_recover_line < edge_docker_gate_line )) || \
  fail 'edge candidate recovery must run before Docker or host configuration checks'
for required_edge_candidate_recovery in \
  '[[ "${apply_rollback}" == true ]]' \
  'edge recovery marker and staging candidates cannot coexist' \
  'unarmed Caddy recovery candidate is not a proven source prefix' \
  'unarmed Nginx recovery candidate is not a proven source prefix' \
  'a committed edge snapshot is partial without a committed recovery marker' \
  '"${edge_recovery_caddy}" replace-safe-snapshot' \
  '"${edge_recovery_nginx}" replace-safe-snapshot' \
  '"${edge_recovery_marker}" must-be-absent' \
  'verify_edge_recovery_snapshots'; do
  grep -Fq -- "${required_edge_candidate_recovery}" <<<"${edge_candidate_recovery_flow}" || \
    fail "edge staging recovery is missing: ${required_edge_candidate_recovery}"
done
edge_candidate_caddy_commit_line="$(release_function_step_line recover_edge_recovery_candidates \
  '"${edge_recovery_caddy}" replace-safe-snapshot')"
edge_candidate_nginx_commit_line="$(release_function_step_line recover_edge_recovery_candidates \
  '"${edge_recovery_nginx}" replace-safe-snapshot')"
edge_candidate_marker_commit_line="$(release_function_step_line recover_edge_recovery_candidates \
  '"${edge_recovery_marker}" must-be-absent')"
edge_candidate_verify_line="$(release_function_step_line recover_edge_recovery_candidates \
  'verify_edge_recovery_snapshots ||')"
(( edge_candidate_caddy_commit_line < edge_candidate_nginx_commit_line && \
  edge_candidate_nginx_commit_line < edge_candidate_marker_commit_line && \
  edge_candidate_marker_commit_line < edge_candidate_verify_line )) || \
  fail 'edge crash recovery must promote both snapshots before publishing its marker'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}/deploy"
  scratch_directory="${harness_root}/scratch"
  activation_intent_root="${deploy_root}/state/activation-recovery"
  activation_intent_path="${activation_intent_root}/pending"
  activation_intent_next="${activation_intent_path}.next"
  rollback_intent_root="${deploy_root}/state/rollback-recovery"
  rollback_intent_path="${rollback_intent_root}/pending"
  rollback_intent_next="${rollback_intent_path}.next"
  target_release=20990103T000000Z
  current_release=20990102T000000Z
  previous_release=20990101T000000Z
  other_release=20990104T000000Z
  mkdir -p \
    "${scratch_directory}" "${activation_intent_root}" "${rollback_intent_root}" \
    "${deploy_root}/releases/${target_release}" \
    "${deploy_root}/releases/${current_release}" \
    "${deploy_root}/releases/${previous_release}" \
    "${deploy_root}/releases/${other_release}"

  fail() { exit 97; }
  log() { :; }
  current_link=${current_release}
  previous_link=${previous_release}
  read_release_link() {
    case "$1" in
      current) [[ -z "${current_link}" ]] || printf "%s\n" "${current_link}" ;;
      previous) [[ -z "${previous_link}" ]] || printf "%s\n" "${previous_link}" ;;
      *) return 1 ;;
    esac
  }
  unsafe_mode_path=
  unsafe_owner_path=
  unsafe_root_path=
  stat() {
    [[ "$1" == -c && "$#" -ge 3 ]] || return 1
    local -r format=$2
    shift 2
    [[ "${1:-}" != -- ]] || shift
    local -r path=$1
    case "${format}" in
      "%a:%u:%g")
        if [[ "${path}" == "${unsafe_root_path}" ]]; then
          printf "755:0:0\n"
        elif [[ -d "${path}" ]]; then
          printf "700:0:0\n"
        elif [[ "${path}" == "${unsafe_mode_path}" ]]; then
          printf "666:0:0\n"
        elif [[ "${path}" == "${unsafe_owner_path}" ]]; then
          printf "600:1:0\n"
        else
          printf "600:0:0\n"
        fi
        ;;
      "%s")
        [[ -f "${path}" && ! -L "${path}" ]] || return 1
        local size
        size="$(wc -c <"${path}")"
        printf "%d\n" "$((size))"
        ;;
      *) return 1 ;;
    esac
  }
  fail_sync_path=
  fail_mv_path=
  fail_unlink_path=
  sync_log="${harness_root}/sync.log"
  : >"${sync_log}"
  chmod() {
    [[ "$1" == 0600 && "$2" == -- && "$#" == 3 ]] || return 1
    command chmod 0600 "$3"
  }
  head() {
    [[ "$1" == -c && "$3" == -- && "$#" == 4 ]] || return 1
    [[ "$2" != 0 ]] || return 0
    command head -c "$2" "$4"
  }
  cmp() {
    [[ "$1" == -- && "$#" == 3 ]] || return 1
    command cmp "$2" "$3"
  }
  sync() {
    [[ "$1" == -f && "$#" == 2 ]] || return 1
    [[ "$2" != "${fail_sync_path}" ]] || return 1
    printf "%s\n" "$2" >>"${sync_log}"
  }
  mv() {
    [[ "$1" == -fT && "$2" == -- && "$#" == 4 ]] || return 1
    [[ "$3" != "${fail_mv_path}" ]] || return 1
    command rm -f -- "$4"
    command mv -f -- "$3" "$4"
  }
  unlink() {
    [[ "$1" == -- && "$#" == 2 ]] || return 1
    [[ "$2" != "${fail_unlink_path}" ]] || return 1
    command rm -f -- "$2"
  }
  activation_reconciled="${harness_root}/activation-reconciled"
  rollback_reconciled="${harness_root}/rollback-reconciled"
  activation_fresh_started="${harness_root}/activation-fresh-started"
  rollback_fresh_started="${harness_root}/rollback-fresh-started"
  reconcile_pending_activation() { : >"${activation_reconciled}"; }
  reconcile_pending_rollback() { : >"${rollback_reconciled}"; }
  legacy_bridge_operator_path() { printf "%s\n" "${harness_root}/bridge-operator"; }
  warn_pinned_bridge_operator() { : >"${activation_fresh_started}"; exit 96; }
  assert_staged_edge_host_contract() { : >"${rollback_fresh_started}"; exit 95; }
  reset_candidates() {
    command rm -rf -- \
      "${activation_intent_path}" "${activation_intent_next}" \
      "${rollback_intent_path}" "${rollback_intent_next}" \
      "${activation_reconciled}" "${rollback_reconciled}" \
      "${activation_fresh_started}" "${rollback_fresh_started}"
    : >"${sync_log}"
    unsafe_mode_path=
    unsafe_owner_path=
    unsafe_root_path=
    fail_sync_path=
    fail_mv_path=
    fail_unlink_path=
    current_link=${current_release}
    previous_link=${previous_release}
    release_id=${target_release}
    apply_rollback=true
  }
  write_activation_candidate() {
    local -r previous_token=$1
    printf "current %s\nprevious %s\ntarget %s\n" \
      "${current_release}" "${previous_token}" "${target_release}" \
      >"${activation_intent_next}"
  }
  write_rollback_candidate() {
    printf "current %s\nprevious %s\n" \
      "${current_release}" "${previous_release}" >"${rollback_intent_next}"
  }

  reset_candidates
  write_activation_candidate "${previous_release}"
  activate_release >/dev/null
  [[ -f "${activation_intent_path}" && ! -e "${activation_intent_next}" ]]
  [[ -f "${activation_reconciled}" ]]

  reset_candidates
  previous_link=
  write_activation_candidate none
  recover_activation_intent_candidate
  [[ "$(read_activation_intent)" == \
    "${current_release} none ${target_release}" ]]

  for prefix_kind in empty midline; do
    reset_candidates
    if [[ "${prefix_kind}" == empty ]]; then
      : >"${activation_intent_next}"
    else
      printf "current %s\npre" "${current_release}" >"${activation_intent_next}"
    fi
    if (activate_release >/dev/null 2>&1); then exit 1; fi
    [[ ! -e "${activation_intent_path}" && ! -e "${activation_intent_next}" ]]
    [[ -f "${activation_fresh_started}" ]]
    [[ "$(tail -n 1 "${sync_log}")" == "${activation_intent_root}" ]]
  done

  reset_candidates
  write_activation_candidate "${previous_release}"
  command cp -- "${activation_intent_next}" "${activation_intent_path}"
  if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${activation_intent_path}" && -f "${activation_intent_next}" ]]

  for unsafe_kind in mode owner root symlink directory fifo oversized divergent; do
    reset_candidates
    write_activation_candidate "${previous_release}"
    case "${unsafe_kind}" in
      mode) unsafe_mode_path=${activation_intent_next} ;;
      owner) unsafe_owner_path=${activation_intent_next} ;;
      root) unsafe_root_path=${activation_intent_root} ;;
      symlink)
        command rm -f -- "${activation_intent_next}"
        command ln -s /dev/null "${activation_intent_next}"
        ;;
      directory)
        command rm -f -- "${activation_intent_next}"
        command mkdir "${activation_intent_next}"
        ;;
      fifo)
        command rm -f -- "${activation_intent_next}"
        command mkfifo "${activation_intent_next}"
        ;;
      oversized) printf "x" >>"${activation_intent_next}" ;;
      divergent)
        printf "xurrent %s\nprevious %s\ntarget %s\n" \
          "${current_release}" "${previous_release}" "${target_release}" \
          >"${activation_intent_next}"
        ;;
    esac
    if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
    [[ -e "${activation_intent_next}" || -L "${activation_intent_next}" ]]
    [[ ! -e "${activation_intent_path}" ]]
  done

  reset_candidates
  write_activation_candidate "${previous_release}"
  current_link=${other_release}
  if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${activation_intent_next}" && ! -e "${activation_intent_path}" ]]

  reset_candidates
  write_activation_candidate "${previous_release}"
  release_id=${other_release}
  if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${activation_intent_next}" && ! -e "${activation_intent_path}" ]]

  reset_candidates
  printf "current %s\npre" "${current_release}" >"${activation_intent_next}"
  fail_unlink_path=${activation_intent_next}
  if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${activation_intent_next}" && ! -e "${activation_intent_path}" ]]

  for failure_kind in file-sync move; do
    reset_candidates
    write_activation_candidate "${previous_release}"
    if [[ "${failure_kind}" == file-sync ]]; then
      fail_sync_path=${activation_intent_next}
    else
      fail_mv_path=${activation_intent_next}
    fi
    if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
    [[ -f "${activation_intent_next}" && ! -e "${activation_intent_path}" ]]
  done

  reset_candidates
  write_activation_candidate "${previous_release}"
  fail_sync_path=${activation_intent_root}
  if (recover_activation_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${activation_intent_path}" && ! -e "${activation_intent_next}" ]]
  fail_sync_path=
  recover_activation_intent_candidate
  [[ "$(read_activation_intent)" == \
    "${current_release} ${previous_release} ${target_release}" ]]

  reset_candidates
  release_id=${current_release}
  write_rollback_candidate
  apply_rollback=false
  rollback_release >/dev/null
  [[ -f "${rollback_intent_next}" && ! -e "${rollback_intent_path}" ]]
  [[ ! -e "${rollback_reconciled}" ]]

  reset_candidates
  release_id=${current_release}
  write_rollback_candidate
  rollback_release >/dev/null
  [[ -f "${rollback_intent_path}" && ! -e "${rollback_intent_next}" ]]
  [[ -f "${rollback_reconciled}" ]]

  for prefix_kind in empty midline; do
    reset_candidates
    release_id=${current_release}
    if [[ "${prefix_kind}" == empty ]]; then
      : >"${rollback_intent_next}"
    else
      printf "current %s\npre" "${current_release}" >"${rollback_intent_next}"
    fi
    if (rollback_release >/dev/null 2>&1); then exit 1; fi
    [[ ! -e "${rollback_intent_path}" && ! -e "${rollback_intent_next}" ]]
    [[ -f "${rollback_fresh_started}" ]]
    [[ "$(tail -n 1 "${sync_log}")" == "${rollback_intent_root}" ]]
  done

  reset_candidates
  release_id=${current_release}
  write_rollback_candidate
  command cp -- "${rollback_intent_next}" "${rollback_intent_path}"
  if (recover_rollback_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${rollback_intent_path}" && -f "${rollback_intent_next}" ]]

  for unsafe_kind in mode owner root symlink directory fifo oversized divergent; do
    reset_candidates
    release_id=${current_release}
    write_rollback_candidate
    case "${unsafe_kind}" in
      mode) unsafe_mode_path=${rollback_intent_next} ;;
      owner) unsafe_owner_path=${rollback_intent_next} ;;
      root) unsafe_root_path=${rollback_intent_root} ;;
      symlink)
        command rm -f -- "${rollback_intent_next}"
        command ln -s /dev/null "${rollback_intent_next}"
        ;;
      directory)
        command rm -f -- "${rollback_intent_next}"
        command mkdir "${rollback_intent_next}"
        ;;
      fifo)
        command rm -f -- "${rollback_intent_next}"
        command mkfifo "${rollback_intent_next}"
        ;;
      oversized) printf "x" >>"${rollback_intent_next}" ;;
      divergent)
        printf "xurrent %s\nprevious %s\n" \
          "${current_release}" "${previous_release}" >"${rollback_intent_next}"
        ;;
    esac
    if (recover_rollback_intent_candidate >/dev/null 2>&1); then exit 1; fi
    [[ -e "${rollback_intent_next}" || -L "${rollback_intent_next}" ]]
    [[ ! -e "${rollback_intent_path}" ]]
  done

  reset_candidates
  release_id=${current_release}
  printf "current %s\npre" "${current_release}" >"${rollback_intent_next}"
  fail_unlink_path=${rollback_intent_next}
  if (recover_rollback_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${rollback_intent_next}" && ! -e "${rollback_intent_path}" ]]

  for failure_kind in file-sync move; do
    reset_candidates
    release_id=${current_release}
    write_rollback_candidate
    if [[ "${failure_kind}" == file-sync ]]; then
      fail_sync_path=${rollback_intent_next}
    else
      fail_mv_path=${rollback_intent_next}
    fi
    if (recover_rollback_intent_candidate >/dev/null 2>&1); then exit 1; fi
    [[ -f "${rollback_intent_next}" && ! -e "${rollback_intent_path}" ]]
  done

  reset_candidates
  release_id=${other_release}
  write_rollback_candidate
  if (recover_rollback_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${rollback_intent_next}" && ! -e "${rollback_intent_path}" ]]

  reset_candidates
  release_id=${current_release}
  write_rollback_candidate
  previous_link=${other_release}
  if (recover_rollback_intent_candidate >/dev/null 2>&1); then exit 1; fi
  [[ -f "${rollback_intent_next}" && ! -e "${rollback_intent_path}" ]]
' _ "${intent_candidate_harness_flow}" || \
  fail 'activation and rollback staging-candidate recovery harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}/deploy"
  scratch_directory="${harness_root}/scratch"
  installed_caddy_config="${harness_root}/installed.Caddyfile"
  live_config="${harness_root}/live-nginx.conf"
  edge_recovery_root="${deploy_root}/state/edge-hardening-recovery"
  edge_recovery_marker="${edge_recovery_root}/pending"
  edge_recovery_caddy="${edge_recovery_root}/Caddyfile.original"
  edge_recovery_nginx="${edge_recovery_root}/nginx.original.conf"
  edge_recovery_marker_next="${edge_recovery_marker}.next"
  edge_recovery_caddy_next="${edge_recovery_caddy}.next"
  edge_recovery_nginx_next="${edge_recovery_nginx}.next"
  operator_release=20990203T000000Z
  current_release=20990202T000000Z
  other_release=20990201T000000Z
  mkdir -p \
    "${scratch_directory}" \
    "${deploy_root}/releases/${operator_release}" \
    "${deploy_root}/releases/${current_release}" \
    "${deploy_root}/releases/${other_release}"
  printf "caddy-original\nroute\n" >"${installed_caddy_config}"
  printf "nginx-original\nserver\n" >"${live_config}"

  fail() { exit 97; }
  release_id=${operator_release}
  apply_rollback=true
  unsafe_mode_path=
  unsafe_owner_path=
  unsafe_root_path=
  stat() {
    [[ "$1" == -c && "$#" -ge 3 ]] || return 1
    local -r format=$2
    shift 2
    [[ "${1:-}" != -- ]] || shift
    local -r path=$1
    case "${format}" in
      "%a:%u:%g")
        if [[ "${path}" == "${unsafe_root_path}" ]]; then
          printf "755:0:0\n"
        elif [[ -d "${path}" ]]; then
          printf "700:0:0\n"
        elif [[ "${path}" == "${unsafe_mode_path}" ]]; then
          printf "666:0:0\n"
        elif [[ "${path}" == "${unsafe_owner_path}" ]]; then
          printf "600:1:0\n"
        else
          printf "600:0:0\n"
        fi
        ;;
      "%s")
        [[ -f "${path}" && ! -L "${path}" ]] || return 1
        local size
        size="$(wc -c <"${path}")"
        printf "%d\n" "$((size))"
        ;;
      *) return 1 ;;
    esac
  }
  chmod() {
    [[ "$1" == 0600 && "$2" == -- && "$#" == 3 ]] || return 1
    command chmod 0600 "$3"
  }
  head() {
    [[ "$1" == -c && "$3" == -- && "$#" == 4 ]] || return 1
    [[ "$2" != 0 ]] || return 0
    command head -c "$2" "$4"
  }
  cmp() {
    [[ "$1" == -- && "$#" == 3 ]] || return 1
    command cmp "$2" "$3"
  }
  event_log="${harness_root}/events.log"
  fail_sync_path=
  fail_mv_destination=
  fail_unlink_path=
  sync() {
    [[ "$1" == -f && "$#" == 2 ]] || return 1
    [[ "$2" != "${fail_sync_path}" ]] || return 1
    printf "sync %s\n" "$2" >>"${event_log}"
  }
  mv() {
    [[ "$1" == -fT && "$2" == -- && "$#" == 4 ]] || return 1
    [[ "$4" != "${fail_mv_destination}" ]] || return 1
    command rm -f -- "$4"
    command mv -f -- "$3" "$4"
    printf "mv %s\n" "$4" >>"${event_log}"
  }
  unlink() {
    [[ "$1" == -- && "$#" == 2 ]] || return 1
    [[ "$2" != "${fail_unlink_path}" ]] || return 1
    command rm -f -- "$2"
    printf "unlink %s\n" "$2" >>"${event_log}"
  }
  caddy() { [[ "$1" == validate ]]; }
  verify_caddy_config_contract() { :; }
  reset_edge() {
    command rm -rf -- "${edge_recovery_root}"
    command mkdir -p "${edge_recovery_root}"
    : >"${event_log}"
    release_id=${operator_release}
    apply_rollback=true
    unsafe_mode_path=
    unsafe_owner_path=
    unsafe_root_path=
    fail_sync_path=
    fail_mv_destination=
    fail_unlink_path=
  }
  write_marker_candidate() {
    local caddy_hash nginx_hash remainder
    read -r caddy_hash remainder <<<"$(sha256sum "${installed_caddy_config}")"
    read -r nginx_hash remainder <<<"$(sha256sum "${live_config}")"
    printf "operator %s\ncurrent %s\ncaddy-sha256 %s\nnginx-sha256 %s\n" \
      "${release_id}" "${current_release}" "${caddy_hash}" "${nginx_hash}" \
      >"${edge_recovery_marker_next}"
  }
  prepare_all_next() {
    command cp -- "${installed_caddy_config}" "${edge_recovery_caddy_next}"
    command cp -- "${live_config}" "${edge_recovery_nginx_next}"
    write_marker_candidate
  }
  prepare_historical_snapshots() {
    printf "historical-caddy\n" >"${edge_recovery_caddy}"
    printf "historical-nginx\n" >"${edge_recovery_nginx}"
  }
  assert_committed_edge_recovery() {
    [[ -f "${edge_recovery_marker}" && ! -e "${edge_recovery_marker_next}" ]]
    [[ ! -e "${edge_recovery_caddy_next}" && ! -e "${edge_recovery_nginx_next}" ]]
    command cmp "${installed_caddy_config}" "${edge_recovery_caddy}"
    command cmp "${live_config}" "${edge_recovery_nginx}"
    verify_edge_recovery_snapshots
  }

  for prefix_kind in empty midline; do
    reset_edge
    if [[ "${prefix_kind}" == empty ]]; then
      : >"${edge_recovery_caddy_next}"
    else
      printf "caddy-original\nro" >"${edge_recovery_caddy_next}"
    fi
    command cp -- "${live_config}" "${edge_recovery_nginx_next}"
    recover_edge_recovery_candidates "${current_release}"
    [[ ! -e "${edge_recovery_caddy_next}" && \
      ! -e "${edge_recovery_nginx_next}" && \
      ! -e "${edge_recovery_marker}" && ! -e "${edge_recovery_marker_next}" ]]
    [[ "$(tail -n 1 "${event_log}")" == "sync ${edge_recovery_root}" ]]
  done

  reset_edge
  prepare_all_next
  apply_rollback=false
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  [[ -f "${edge_recovery_caddy_next}" && -f "${edge_recovery_nginx_next}" && \
    -f "${edge_recovery_marker_next}" && ! -e "${edge_recovery_marker}" ]]

  reset_edge
  prepare_historical_snapshots
  prepare_all_next
  recover_edge_recovery_candidates "${current_release}"
  assert_committed_edge_recovery
  grep -vF "${scratch_directory}/recovery-prefix." "${event_log}" \
    >"${harness_root}/promotion-events"
  printf "sync %s\nmv %s\nsync %s\nsync %s\nmv %s\nsync %s\nsync %s\nmv %s\nsync %s\n" \
    "${edge_recovery_caddy_next}" "${edge_recovery_caddy}" "${edge_recovery_root}" \
    "${edge_recovery_nginx_next}" "${edge_recovery_nginx}" "${edge_recovery_root}" \
    "${edge_recovery_marker_next}" "${edge_recovery_marker}" "${edge_recovery_root}" \
    >"${harness_root}/expected-promotion-events"
  command cmp "${harness_root}/expected-promotion-events" \
    "${harness_root}/promotion-events"

  reset_edge
  command cp -- "${installed_caddy_config}" "${edge_recovery_caddy}"
  printf "historical-nginx\n" >"${edge_recovery_nginx}"
  command cp -- "${live_config}" "${edge_recovery_nginx_next}"
  write_marker_candidate
  recover_edge_recovery_candidates "${current_release}"
  assert_committed_edge_recovery

  reset_edge
  command cp -- "${installed_caddy_config}" "${edge_recovery_caddy}"
  command cp -- "${live_config}" "${edge_recovery_nginx}"
  write_marker_candidate
  recover_edge_recovery_candidates "${current_release}"
  assert_committed_edge_recovery

  reset_edge
  prepare_historical_snapshots
  prepare_all_next
  fail_mv_destination=${edge_recovery_nginx}
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  command cmp "${installed_caddy_config}" "${edge_recovery_caddy}"
  [[ ! -e "${edge_recovery_caddy_next}" && -f "${edge_recovery_nginx_next}" && \
    -f "${edge_recovery_marker_next}" && ! -e "${edge_recovery_marker}" ]]
  fail_mv_destination=
  recover_edge_recovery_candidates "${current_release}"
  assert_committed_edge_recovery

  reset_edge
  prepare_historical_snapshots
  prepare_all_next
  fail_mv_destination=${edge_recovery_marker}
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  command cmp "${installed_caddy_config}" "${edge_recovery_caddy}"
  command cmp "${live_config}" "${edge_recovery_nginx}"
  [[ ! -e "${edge_recovery_caddy_next}" && ! -e "${edge_recovery_nginx_next}" && \
    -f "${edge_recovery_marker_next}" && ! -e "${edge_recovery_marker}" ]]
  fail_mv_destination=
  recover_edge_recovery_candidates "${current_release}"
  assert_committed_edge_recovery

  reset_edge
  prepare_all_next
  fail_sync_path=${edge_recovery_caddy_next}
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  [[ -f "${edge_recovery_caddy_next}" && -f "${edge_recovery_nginx_next}" && \
    -f "${edge_recovery_marker_next}" && ! -e "${edge_recovery_marker}" ]]
  fail_sync_path=
  recover_edge_recovery_candidates "${current_release}"
  assert_committed_edge_recovery

  reset_edge
  printf "caddy-original\nro" >"${edge_recovery_caddy_next}"
  fail_unlink_path=${edge_recovery_caddy_next}
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  [[ -f "${edge_recovery_caddy_next}" && ! -e "${edge_recovery_marker}" ]]
  fail_unlink_path=
  recover_edge_recovery_candidates "${current_release}"
  [[ ! -e "${edge_recovery_caddy_next}" ]]

  reset_edge
  prepare_all_next
  printf "historical-caddy\n" >"${edge_recovery_caddy}"
  unsafe_mode_path=${edge_recovery_caddy}
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  [[ "$(( $(wc -c <"${edge_recovery_caddy}") ))" -gt 0 && \
    -f "${edge_recovery_caddy_next}" && -f "${edge_recovery_marker_next}" ]]

  reset_edge
  prepare_all_next
  command cp -- "${installed_caddy_config}" "${edge_recovery_caddy}"
  command cp -- "${live_config}" "${edge_recovery_nginx}"
  command mv -f -- "${edge_recovery_marker_next}" "${edge_recovery_marker}"
  command cp -- "${installed_caddy_config}" "${edge_recovery_caddy_next}"
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  [[ -f "${edge_recovery_marker}" && -f "${edge_recovery_caddy_next}" ]]

  for invalid_kind in \
    wrong-operator wrong-current wrong-hash missing symlink unsafe-mode unsafe-owner \
    divergent oversized; do
    reset_edge
    prepare_all_next
    case "${invalid_kind}" in
      wrong-operator)
        release_id=${other_release}
        ;;
      wrong-current)
        current_argument=${other_release}
        ;;
      wrong-hash)
        read -r live_hash _ <<<"$(sha256sum "${live_config}")"
        printf "operator %s\ncurrent %s\ncaddy-sha256 %064d\nnginx-sha256 %s\n" \
          "${release_id}" "${current_release}" 0 \
          "${live_hash}" \
          >"${edge_recovery_marker_next}"
        ;;
      missing) command rm -f -- "${edge_recovery_caddy_next}" ;;
      symlink)
        command rm -f -- "${edge_recovery_marker_next}"
        command ln -s /dev/null "${edge_recovery_marker_next}"
        ;;
      unsafe-mode) unsafe_mode_path=${edge_recovery_marker_next} ;;
      unsafe-owner) unsafe_owner_path=${edge_recovery_marker_next} ;;
      divergent)
        printf "xaddy-original\nroute\n" >"${edge_recovery_caddy_next}"
        ;;
      oversized) printf "x" >>"${edge_recovery_caddy_next}" ;;
    esac
    current_argument=${current_argument:-${current_release}}
    if (recover_edge_recovery_candidates "${current_argument}" >/dev/null 2>&1); then
      exit 1
    fi
    [[ ! -e "${edge_recovery_marker}" ]]
    [[ -e "${edge_recovery_marker_next}" || -L "${edge_recovery_marker_next}" ]]
    current_argument=
  done

  reset_edge
  prepare_historical_snapshots
  prepare_all_next
  original_promote_definition="$(declare -f promote_recovery_candidate)"
  original_promote_definition="${original_promote_definition/promote_recovery_candidate/real_promote_recovery_candidate}"
  eval "${original_promote_definition}"
  promote_recovery_candidate() {
    local -r committed_path=$3
    if [[ "${committed_path}" == "${edge_recovery_marker}" ]]; then
      real_promote_recovery_candidate "$@"
    else
      return 0
    fi
  }
  if (recover_edge_recovery_candidates "${current_release}" >/dev/null 2>&1); then
    exit 1
  fi
  [[ -f "${edge_recovery_marker}" && \
    -f "${edge_recovery_caddy_next}" && -f "${edge_recovery_nginx_next}" ]]
' _ "${edge_candidate_harness_flow}" || \
  fail 'edge staging-candidate recovery and crash-retry harness failed'
grep -Fq 'unlink -- "${edge_recovery_marker}"' <<<"${edge_recovery_retire_flow}" || \
  fail 'edge recovery commit must retire only the durable pending marker'
cleanup_flow="$(release_function_body cleanup)"
reject_rg_match \
  'ordinary process cleanup must not delete durable edge recovery snapshots' \
  'edge_recovery|edge-hardening-recovery' \
  <(printf '%s\n' "${cleanup_flow}")
for required_rollback_intent_contract in \
  '[[ -f "${rollback_intent_path}" && ! -L "${rollback_intent_path}" ]]' \
  "stat -c '%a:%u:%g' \"\${rollback_intent_path}\"" \
  '[[ "${original_current}" == "${release_id}"' \
  '"${original_current}" != "${original_previous}" ]]' \
  "printf '%s %s\\n' \"\${original_current}\" \"\${original_previous}\""; do
  grep -Fq -- "${required_rollback_intent_contract}" <<<"${rollback_intent_read_flow}" || \
    fail "durable rollback intent validation is missing: ${required_rollback_intent_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  rollback_intent_root="${deploy_root}/state/rollback-recovery"
  rollback_intent_path="${rollback_intent_root}/pending"
  current_release=20990102T000000Z
  previous_release=20990101T000000Z
  third_release=20990103T000000Z
  release_id=${current_release}
  mkdir -p \
    "${rollback_intent_root}" \
    "${deploy_root}/releases/${current_release}" \
    "${deploy_root}/releases/${previous_release}" \
    "${deploy_root}/releases/${third_release}"
  printf "current %s\nprevious %s\n" "${current_release}" "${previous_release}" \
    >"${rollback_intent_path}"
  stat() {
    [[ "$1" == -c && "$2" == "%a:%u:%g" ]]
    if [[ "$3" == "${rollback_intent_root}" ]]; then
      printf "700:0:0\n"
    else
      printf "600:0:0\n"
    fi
  }
  [[ "$(read_rollback_intent)" == "${current_release} ${previous_release}" ]]
  release_id=${third_release}
  if (read_rollback_intent >/dev/null 2>&1); then exit 1; fi
' _ "${rollback_intent_read_flow}" || \
  fail 'rollback intent immutable-operator identity harness failed'
for required_rollback_intent_arm in \
  'install -d -m 0700 -o root -g root -- "${rollback_intent_root}"' \
  'sync -f "${next_intent}"' \
  'mv -fT -- "${next_intent}" "${rollback_intent_path}"' \
  'read_rollback_intent >/dev/null'; do
  grep -Fq -- "${required_rollback_intent_arm}" <<<"${rollback_intent_arm_flow}" || \
    fail "durable rollback intent arming is missing: ${required_rollback_intent_arm}"
done
rollback_arm_file_sync_line="$(release_function_step_line arm_rollback_intent \
  'sync -f "${next_intent}" || return 1')"
rollback_arm_commit_line="$(release_function_step_line arm_rollback_intent \
  'mv -fT -- "${next_intent}" "${rollback_intent_path}" || return 1')"
rollback_arm_parent_sync_line="$(release_function_step_line arm_rollback_intent \
  'sync -f "${rollback_intent_root}" || return 1')"
rollback_arm_verify_line="$(release_function_step_line arm_rollback_intent \
  'read_rollback_intent >/dev/null')"
(( rollback_arm_file_sync_line < rollback_arm_commit_line && \
  rollback_arm_commit_line < rollback_arm_parent_sync_line && \
  rollback_arm_parent_sync_line < rollback_arm_verify_line )) || \
  fail 'rollback journal must fsync file before rename, parent fsync, and committed verification'
grep -Fq 'unlink -- "${rollback_intent_path}"' <<<"${rollback_intent_retire_flow}" || \
  fail 'rollback intent commit must atomically retire its pending marker'
grep -Fq '[[ "${old_current}" != "${old_previous}" ]]' \
  <<<"${rollback_link_switch_flow}" || \
  fail 'rollback link switch must reject an equal current/previous pair'
for required_reconciliation_contract in \
  'assert_staged_edge_host_contract allow-pending' \
  'assert_staged_edge_contract allow-pending' \
  'verify_release_compose_edge_contract "${original_current}"' \
  'verify_release_images "${original_current}"' \
  'prepare_hardened_nginx_config' \
  'compose_release "${original_previous}" up -d --no-build --pull never' \
  'switch_rollback_links "${original_current}" "${original_previous}"' \
  'record_deployment rollback-reconciled "${original_previous}"' \
  'retire_rollback_intent'; do
  grep -Fq -- "${required_reconciliation_contract}" <<<"${rollback_reconcile_flow}" || \
    fail "interrupted rollback reconciliation is missing: ${required_reconciliation_contract}"
done
for required_activation_intent_contract in \
  '[[ -f "${activation_intent_path}" && ! -L "${activation_intent_path}" ]]' \
  '[[ "$(awk '\''END { print NR + 0 }'\'' "${activation_intent_path}")" == '\''3'\'' ]]' \
  '"${target_release}" == "${release_id}"' \
  "printf '%s %s %s\\n' \"\${original_current}\" \"\${original_previous}\" \"\${target_release}\""; do
  grep -Fq -- "${required_activation_intent_contract}" <<<"${activation_intent_read_flow}" || \
    fail "durable activation intent validation is missing: ${required_activation_intent_contract}"
done
for required_activation_intent_arm in \
  'install -d -m 0700 -o root -g root -- "${activation_intent_root}"' \
  'sync -f "${next_intent}"' \
  'mv -fT -- "${next_intent}" "${activation_intent_path}"' \
  'read_activation_intent >/dev/null'; do
  grep -Fq -- "${required_activation_intent_arm}" <<<"${activation_intent_arm_flow}" || \
    fail "durable activation intent arming is missing: ${required_activation_intent_arm}"
done
activation_arm_file_sync_line="$(release_function_step_line arm_activation_intent \
  'sync -f "${next_intent}" || return 1')"
activation_arm_commit_line="$(release_function_step_line arm_activation_intent \
  'mv -fT -- "${next_intent}" "${activation_intent_path}" || return 1')"
activation_arm_parent_sync_line="$(release_function_step_line arm_activation_intent \
  'sync -f "${activation_intent_root}" || return 1')"
activation_arm_verify_line="$(release_function_step_line arm_activation_intent \
  'read_activation_intent >/dev/null')"
(( activation_arm_file_sync_line < activation_arm_commit_line && \
  activation_arm_commit_line < activation_arm_parent_sync_line && \
  activation_arm_parent_sync_line < activation_arm_verify_line )) || \
  fail 'activation journal must fsync file before rename, parent fsync, and committed verification'
grep -Fq 'unlink -- "${activation_intent_path}"' <<<"${activation_intent_retire_flow}" || \
  fail 'activation intent commit must atomically retire its pending marker'
for required_activation_reconciliation in \
  'assert_staged_edge_host_contract allow-pending' \
  'assert_staged_edge_contract allow-pending' \
  'verify_release_compose_edge_contract "${original_current}"' \
  'verify_release_images "${original_current}"' \
  'prepare_hardened_nginx_config' \
  'compose_release "${target_release}" up -d --no-build --pull never' \
  'switch_release_links "${original_current}"' \
  'record_deployment activate-reconciled "${target_release}"' \
  'retire_activation_intent'; do
  grep -Fq -- "${required_activation_reconciliation}" <<<"${activation_reconcile_flow}" || \
    fail "interrupted activation reconciliation is missing: ${required_activation_reconciliation}"
done
activation_reconcile_host_line="$(release_function_step_line reconcile_pending_activation \
  'assert_staged_edge_host_contract allow-pending')"
activation_reconcile_runtime_line="$(release_function_step_line reconcile_pending_activation \
  'compose_release "${target_release}" up -d --no-build --pull never \')"
activation_reconcile_strict_line="$(release_function_step_line reconcile_pending_activation \
  'assert_staged_edge_contract allow-pending')"
activation_reconcile_switch_line="$(release_function_step_line reconcile_pending_activation \
  'switch_release_links "${original_current}" || \')"
(( activation_reconcile_host_line < activation_reconcile_runtime_line && \
  activation_reconcile_runtime_line < activation_reconcile_strict_line && \
  activation_reconcile_strict_line < activation_reconcile_switch_line )) || \
  fail 'activation reconciliation must allow safe absence, repair runtime, then pass strict checks before links'
rollback_reconcile_host_line="$(release_function_step_line reconcile_pending_rollback \
  'assert_staged_edge_host_contract allow-pending')"
rollback_reconcile_runtime_line="$(release_function_step_line reconcile_pending_rollback \
  'compose_release "${original_previous}" up -d --no-build --pull never \')"
rollback_reconcile_strict_line="$(release_function_step_line reconcile_pending_rollback \
  'assert_staged_edge_contract allow-pending')"
rollback_reconcile_switch_line="$(release_function_step_line reconcile_pending_rollback \
  'switch_rollback_links "${original_current}" "${original_previous}" || \')"
(( rollback_reconcile_host_line < rollback_reconcile_runtime_line && \
  rollback_reconcile_runtime_line < rollback_reconcile_strict_line && \
  rollback_reconcile_strict_line < rollback_reconcile_switch_line )) || \
  fail 'rollback reconciliation must allow safe absence, repair runtime, then pass strict checks before links'
activation_host_line="$(release_function_step_line activate_release \
  'assert_staged_edge_host_contract')"
activation_runtime_line="$(release_function_step_line activate_release \
  'if ! compose_release "${release_id}" up -d --no-build --pull never --force-recreate bot web || \')"
activation_strict_line="$(release_function_step_line activate_release \
  'assert_staged_edge_contract' first)"
activation_intent_line="$(release_function_step_line activate_release \
  'if ! arm_activation_intent "${current_release}" "${previous_release:-none}" "${release_id}"; then')"
(( activation_host_line < activation_runtime_line && \
  activation_runtime_line < activation_strict_line && \
  activation_strict_line < activation_intent_line )) || \
  fail 'activation retry must use pre-runtime perimeter checks and pass strict runtime checks before intent'
rollback_host_line="$(release_function_step_line rollback_release \
  'assert_staged_edge_host_contract')"
rollback_runtime_line="$(release_function_step_line rollback_release \
  'if ! compose_release "${previous_release}" up -d --no-build --pull never --force-recreate bot web || \')"
rollback_strict_line="$(release_function_step_line rollback_release \
  'assert_staged_edge_contract' first)"
rollback_intent_line="$(release_function_step_line rollback_release \
  'if ! arm_rollback_intent "${current_release}" "${previous_release}"; then')"
(( rollback_host_line < rollback_runtime_line && \
  rollback_runtime_line < rollback_strict_line && \
  rollback_strict_line < rollback_intent_line )) || \
  fail 'rollback retry must use pre-runtime perimeter checks and pass strict runtime checks before intent'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  fail() { exit 91; }
  tracked_caddy_config=/tmp/tracked-caddy
  installed_caddy_config=/tmp/installed-caddy
  caddy_service=caddy.service
  live_config=/tmp/live-nginx
  assert_no_pending_link_intent() { :; }
  assert_no_pending_edge_recovery() { :; }
  check_docker_daemon_perimeter_contract() { :; }
  verify_caddy_config_contract() { :; }
  assert_permissioned_caddy_admin_socket() { :; }
  assert_caddy_live_config_matches_file() { :; }
  assert_public_tcp_listener_owned_by_caddy() { :; }
  assert_no_public_udp_listener() { :; }
  assert_docker_network_contract() { :; }
  verify_nginx_real_ip_contract() { :; }
  assert_legacy_certbot_units_quiesced() { :; }
  systemctl() {
    case "$1" in
      is-enabled) printf "enabled\n" ;;
      show) printf "active\n" ;;
      *) return 1 ;;
    esac
  }
  assert_running_compose_service_bindings() {
    local -r service_name=$1
    local -r cardinality_mode=${2:-strict}
    local count
    case "${service_name}" in
      web) count=${web_count} ;;
      bot) count=${bot_count} ;;
      *) exit 91 ;;
    esac
    [[ "${unsafe_service:-}" != "${service_name}" ]] || exit 91
    if [[ "${cardinality_mode}" == allow-zero ]]; then
      (( count <= 1 )) || exit 91
    else
      (( count == 1 )) || exit 91
    fi
  }

  web_count=0
  bot_count=0
  unsafe_service=
  assert_staged_edge_host_contract allow-pending
  if (assert_staged_edge_contract allow-pending) >/dev/null 2>&1; then exit 1; fi

  web_count=1
  bot_count=1
  assert_staged_edge_contract allow-pending

  web_count=2
  if (assert_staged_edge_host_contract allow-pending) >/dev/null 2>&1; then exit 1; fi
  web_count=1
  unsafe_service=bot
  if (assert_staged_edge_host_contract allow-pending) >/dev/null 2>&1; then exit 1; fi
' _ "${staged_edge_host_flow}" "${staged_edge_flow}" || \
  fail 'staged edge zero-runtime repair boundary harness failed'
activation_previous_commit_line="$(release_function_step_line switch_release_links \
  'mv -fT -- "${deploy_root}/previous.next" "${deploy_root}/previous" || return 1')"
activation_previous_flush_line="$(release_function_step_line switch_release_links \
  'sync -f "${deploy_root}" || return 1' first)"
activation_current_commit_line="$(release_function_step_line switch_release_links \
  'mv -fT -- "${deploy_root}/current.next" "${deploy_root}/current" || return 1')"
activation_current_flush_line="$(release_function_step_line switch_release_links \
  'sync -f "${deploy_root}" || return 1' last)"
(( activation_previous_commit_line < activation_previous_flush_line && \
  activation_previous_flush_line < activation_current_commit_line && \
  activation_current_commit_line < activation_current_flush_line )) || \
  fail 'activation release links must durably flush previous before committing current'
release_link_commit_line="$(release_function_step_line write_release_link \
  'mv -fT -- "${next_path}" "${link_path}" || return 1')"
release_link_flush_line="$(release_function_step_line write_release_link \
  'sync -f "${deploy_root}" || return 1')"
(( release_link_commit_line < release_link_flush_line )) || \
  fail 'each rollback release-link commit must be flushed before the next link mutation'
rollback_previous_write_line="$(release_function_step_line switch_rollback_links \
  'write_release_link previous "${old_current}" || return 1')"
rollback_current_write_line="$(release_function_step_line switch_rollback_links \
  'write_release_link current "${old_previous}" || return 1')"
(( rollback_previous_write_line < rollback_current_write_line )) || \
  fail 'rollback must durably publish previous before switching current'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  eval "$4"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  release_id=20990103T000000Z
  original_current=20990101T000000Z
  original_previous=20981231T000000Z
  mkdir -p \
    "${deploy_root}/releases/${release_id}" \
    "${deploy_root}/releases/${original_current}" \
    "${deploy_root}/releases/${original_previous}"
  sync_count=0
  fail_sync_at=0
  sync() {
    sync_count=$((sync_count + 1))
    (( fail_sync_at == 0 || sync_count != fail_sync_at ))
  }
  ln() {
    [[ "$1" == -sfnT && "$#" == 3 ]]
    command ln -sfn -- "$2" "$3"
  }
  mv() {
    [[ "$1" == -fT && "$2" == -- && "$#" == 4 ]]
    if [[ -e "$4" || -L "$4" ]]; then
      command unlink -- "$4"
    fi
    command mv -f -- "$3" "$4"
  }
  reset_links() {
    command ln -sfn "releases/${original_current}" "${deploy_root}/current"
    command ln -sfn "releases/${original_previous}" "${deploy_root}/previous"
    sync_count=0
  }

  reset_links
  switch_release_links "${original_current}"
  [[ "$(read_release_link current)" == "${release_id}" ]]
  [[ "$(read_release_link previous)" == "${original_current}" ]]
  [[ "${sync_count}" == 2 ]]
  for fail_sync_at in 1 2; do
    reset_links
    if switch_release_links "${original_current}"; then
      exit 1
    fi
    if [[ "${fail_sync_at}" == 1 ]]; then
      [[ "$(read_release_link current)" == "${original_current}" ]]
      [[ "$(read_release_link previous)" == "${original_current}" ]]
    else
      [[ "$(read_release_link current)" == "${release_id}" ]]
      [[ "$(read_release_link previous)" == "${original_current}" ]]
    fi
  done

  fail_sync_at=0
  reset_links
  switch_rollback_links "${original_current}" "${original_previous}"
  [[ "$(read_release_link current)" == "${original_previous}" ]]
  [[ "$(read_release_link previous)" == "${original_current}" ]]
  [[ "${sync_count}" == 2 ]]
  for fail_sync_at in 1 2; do
    reset_links
    if switch_rollback_links "${original_current}" "${original_previous}"; then
      exit 1
    fi
    if [[ "${fail_sync_at}" == 1 ]]; then
      [[ "$(read_release_link current)" == "${original_current}" ]]
      [[ "$(read_release_link previous)" == "${original_current}" ]]
    else
      [[ "$(read_release_link current)" == "${original_previous}" ]]
      [[ "$(read_release_link previous)" == "${original_current}" ]]
    fi
  done
' _ "$(release_function_body read_release_link)" \
  "${activation_link_switch_flow}" "${release_link_write_flow}" \
  "${rollback_link_switch_flow}" || \
  fail 'release-link durability failure-injection harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  scratch_directory="${harness_root}/scratch"
  rollback_intent_path="${harness_root}/pending"
  activation_intent_path="${harness_root}/activation.pending"
  mkdir -p "${scratch_directory}"
  intent_current=20990101T000000Z
  intent_previous=20990102T000000Z
  fail() { exit 91; }
  log() { :; }
  read_rollback_intent() { printf "%s %s\n" "${intent_current}" "${intent_previous}"; }
  read_release_link() {
    case "$1" in
      current) printf "%s\n" "${mock_current}" ;;
      previous) printf "%s\n" "${mock_previous}" ;;
      *) return 1 ;;
    esac
  }
  assert_staged_edge_host_contract() { :; }
  assert_staged_edge_contract() { :; }
  verify_release_compose_edge_contract() { :; }
  verify_release_images() { :; }
  prepare_hardened_nginx_config() { : >"$2"; }
  test_nginx_config() { :; }
  install_live_config() { :; }
  compose_release() { :; }
  wait_for_services() { :; }
  inner_upstream_https_smoke() { :; }
  outer_caddy_https_smoke() { :; }
  switch_rollback_links() {
    [[ "$1" == "${intent_current}" && "$2" == "${intent_previous}" ]]
    mock_current=${intent_previous}
    mock_previous=${intent_current}
    : >"${case_root}/links-switched"
  }
  record_deployment() {
    [[ "$1" == rollback-reconciled && "$2" == "${intent_previous}" ]]
    : >"${case_root}/audit-recorded"
  }
  retire_rollback_intent() { : >"${case_root}/intent-retired"; }

  for link_pair in before between complete; do
    case_root="${harness_root}/${link_pair}"
    mkdir -p "${case_root}"
    case "${link_pair}" in
      before)
        mock_current=${intent_current}
        mock_previous=${intent_previous}
        ;;
      between)
        mock_current=${intent_current}
        mock_previous=${intent_current}
        ;;
      complete)
        mock_current=${intent_previous}
        mock_previous=${intent_current}
        ;;
    esac
    reconcile_pending_rollback
    [[ -f "${case_root}/links-switched" ]]
    [[ -f "${case_root}/audit-recorded" ]]
    [[ -f "${case_root}/intent-retired" ]]
  done

  case_root="${harness_root}/invalid"
  mkdir -p "${case_root}"
  mock_current=20990103T000000Z
  mock_previous=${intent_current}
  if (reconcile_pending_rollback >/dev/null 2>&1); then
    exit 1
  fi
  [[ ! -e "${case_root}/links-switched" ]]
' _ "${rollback_reconcile_flow}" || \
  fail 'interrupted rollback reconciliation harness failed'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  scratch_directory="${harness_root}/scratch"
  activation_intent_path="${harness_root}/pending"
  rollback_intent_path="${harness_root}/rollback.pending"
  release_id=20990103T000000Z
  intent_current=20990101T000000Z
  intent_previous=20981231T000000Z
  mkdir -p "${scratch_directory}"
  fail() { exit 91; }
  log() { :; }
  read_activation_intent() {
    printf "%s %s %s\n" "${intent_current}" "${intent_previous}" "${release_id}"
  }
  read_release_link() {
    case "$1" in
      current) printf "%s\n" "${mock_current}" ;;
      previous) printf "%s\n" "${mock_previous}" ;;
      *) return 1 ;;
    esac
  }
  assert_staged_edge_host_contract() { :; }
  assert_staged_edge_contract() { :; }
  verify_release_compose_edge_contract() { :; }
  verify_release_images() { :; }
  prepare_hardened_nginx_config() { : >"$2"; }
  test_nginx_config() { :; }
  install_live_config() { :; }
  compose_release() { :; }
  wait_for_services() { :; }
  inner_upstream_https_smoke() { :; }
  outer_caddy_https_smoke() { :; }
  switch_release_links() {
    [[ "$1" == "${intent_current}" ]]
    mock_current=${release_id}
    mock_previous=${intent_current}
    : >"${case_root}/links-switched"
  }
  record_deployment() {
    [[ "$1" == activate-reconciled && "$2" == "${release_id}" ]]
    : >"${case_root}/audit-recorded"
  }
  retire_activation_intent() { : >"${case_root}/intent-retired"; }

  for link_pair in before between complete; do
    case_root="${harness_root}/${link_pair}"
    mkdir -p "${case_root}"
    case "${link_pair}" in
      before)
        mock_current=${intent_current}
        mock_previous=${intent_previous}
        ;;
      between)
        mock_current=${intent_current}
        mock_previous=${intent_current}
        ;;
      complete)
        mock_current=${release_id}
        mock_previous=${intent_current}
        ;;
    esac
    reconcile_pending_activation
    [[ -f "${case_root}/links-switched" ]]
    [[ -f "${case_root}/audit-recorded" ]]
    [[ -f "${case_root}/intent-retired" ]]
  done

  case_root="${harness_root}/invalid"
  mkdir -p "${case_root}"
  mock_current=20990104T000000Z
  mock_previous=${intent_current}
  if (reconcile_pending_activation >/dev/null 2>&1); then
    exit 1
  fi
  [[ ! -e "${case_root}/links-switched" ]]
' _ "${activation_reconcile_flow}" || \
  fail 'interrupted activation reconciliation harness failed'
reject_rg_match \
  'edge hardening must recreate the bind-mounted web config, not reload its stale inode' \
  --fixed-strings 'nginx -s reload' \
  <(printf '%s\n' "${edge_hardening_flow}" "${restart_current_web_flow}")
reject_rg_match \
  'edge hardening must not recreate the bot or touch certificate renewal' \
  'force-recreate[[:space:]]+bot|compose_release.*certbot|issue_certificate|ensure_host_renewal|systemctl[[:space:]]+(enable|disable|restart)' \
  <(printf '%s\n' "${edge_hardening_flow}" "${restart_current_web_flow}")
bash -c '
  set -Eeuo pipefail
  eval "$1"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  release_id=20990102T000000Z
  current_release=20990101T000000Z
  apply_rollback=true
  caddy_service=caddy.service
  tracked_caddy_config="${harness_root}/tracked.Caddyfile"
  installed_caddy_config="${harness_root}/installed.Caddyfile"
  live_config="${harness_root}/live-nginx.conf"
  edge_recovery_root="${harness_root}/edge-recovery"
  edge_recovery_marker="${edge_recovery_root}/pending"
  edge_recovery_caddy="${edge_recovery_root}/Caddyfile.original"
  edge_recovery_nginx="${edge_recovery_root}/nginx.original.conf"
  edge_recovery_marker_next="${edge_recovery_marker}.next"
  edge_recovery_caddy_next="${edge_recovery_caddy}.next"
  edge_recovery_nginx_next="${edge_recovery_nginx}.next"
  scratch_directory="${harness_root}/scratch"
  mkdir -p "${scratch_directory}"
  printf "tracked-caddy\n" >"${tracked_caddy_config}"

  fail() { exit 97; }
  log() { :; }
  read_release_link() { printf "20990101T000000Z\n"; }
  assert_no_pending_link_intent() { :; }
  edge_recovery_staging_exists() {
    [[ -e "${edge_recovery_marker_next}" || -L "${edge_recovery_marker_next}" || \
      -e "${edge_recovery_caddy_next}" || -L "${edge_recovery_caddy_next}" || \
      -e "${edge_recovery_nginx_next}" || -L "${edge_recovery_nginx_next}" ]]
  }
  recover_edge_recovery_candidates() { :; }
  check_docker_daemon_perimeter_contract() { :; }
  read_edge_recovery_marker() {
    [[ -f "${edge_recovery_marker}" ]] || return 1
    printf "%s %s\n" "${release_id}" '20990101T000000Z'
  }
  verify_release_compose_edge_contract() { :; }
  verify_release_images() { :; }
  assert_docker_network_contract() { :; }
  service_health() {
    local -r service_name=$2
    if [[ "${service_name}" == bot ]]; then
      [[ "${missing_bot:-false}" != true ]]
      return
    fi
    [[ "${pending_retry:-false}" != true || "${runtime_repaired:-false}" == true ]]
  }
  assert_running_compose_service_bindings() {
    local -r service_name=$1
    local -r cardinality_mode=${2:-strict}
    if [[ "${service_name}" == bot && "${missing_bot:-false}" == true && \
      "${cardinality_mode}" == strict ]]; then
      return 1
    fi
  }
  assert_staged_edge_contract() { :; }
  assert_legacy_certbot_units_quiesced() { :; }
  detect_caddy_admin_address() { printf "tcp/localhost:2019\n"; }
  reconcile_stale_caddy_admin_socket() { :; }
  assert_public_tcp_listener_owned_by_caddy() { :; }
  verify_served_inner_certificates() { :; }
  test_nginx_config() { :; }
  systemctl() {
    case "$1" in
      is-enabled) printf "enabled\n" ;;
      show) printf "active\n" ;;
      *) return 1 ;;
    esac
  }
  install() {
    local -a arguments=("$@")
    local source=${arguments[${#arguments[@]}-2]}
    local destination=${arguments[${#arguments[@]}-1]}
    command cp -- "${source}" "${destination}"
  }
  prepare_hardened_caddy_config() { printf "hardened-caddy\n" >"$2"; }
  prepare_hardened_nginx_config() { printf "hardened-nginx\n" >"$2"; }
  arm_edge_recovery_snapshots() {
    mkdir -p "${edge_recovery_root}"
    command cp -- "$1" "${edge_recovery_caddy}"
    command cp -- "$2" "${edge_recovery_nginx}"
    : >"${edge_recovery_marker}"
  }
  verify_edge_recovery_snapshots() { [[ -f "${edge_recovery_marker}" ]]; }
  retire_edge_recovery_snapshots() { command rm -f -- "${edge_recovery_marker}"; }
  maybe_fail_once() {
    local step=$1
    if [[ "${failure_step}" == recovery-failure && "${step}" == outer1 && \
      ! -e "${case_root}/failure-used" ]]; then
      : >"${case_root}/failure-used"
      return 1
    fi
    if [[ "${failure_step}" == "${step}" && ! -e "${case_root}/failure-used" ]]; then
      : >"${case_root}/failure-used"
      return 1
    fi
  }
  replace_installed_caddy_config() {
    : >"${case_root}/host-mutated"
    if [[ "${failure_step}" == recovery-failure && "$1" == "${edge_recovery_caddy}" ]]; then
      return 1
    fi
    maybe_fail_once replace-caddy || return 1
    command cp -- "$1" "${installed_caddy_config}"
  }
  reload_caddy_edge() {
    maybe_fail_once reload-caddy || return 1
  }
  assert_no_public_udp_listener() {
    maybe_fail_once udp || return 1
  }
  outer_caddy_https_smoke() {
    local count=0 step
    [[ ! -f "${case_root}/outer-count" ]] || count="$(<"${case_root}/outer-count")"
    count=$((count + 1))
    printf "%s\n" "${count}" >"${case_root}/outer-count"
    step="outer${count}"
    maybe_fail_once "${step}" || return 1
  }
  install_live_config() {
    : >"${case_root}/host-mutated"
    maybe_fail_once install-nginx || return 1
    command cp -- "$1" "${live_config}"
  }
  restart_current_web() {
    maybe_fail_once restart-web || return 1
    runtime_repaired=true
  }
  inner_upstream_https_smoke() {
    maybe_fail_once inner || return 1
  }
  verify_caddy_config_contract() {
    if [[ "$1" == "${installed_caddy_config}" && "$(<"$1")" == hardened-caddy ]]; then
      maybe_fail_once verify-caddy || return 1
    fi
  }
  verify_nginx_real_ip_contract() {
    maybe_fail_once verify-nginx || return 1
  }

  for failure_step in \
    replace-caddy reload-caddy udp outer1 install-nginx restart-web inner outer2 \
    verify-caddy verify-nginx recovery-failure none; do
    case_root="${harness_root}/${failure_step}"
    mkdir -p "${case_root}" "${scratch_directory}"
    printf "original-caddy\n" >"${installed_caddy_config}"
    printf "original-nginx\n" >"${live_config}"
    rm -f -- "${case_root}/failure-used" "${case_root}/outer-count" \
      "${edge_recovery_marker}" "${edge_recovery_caddy}" "${edge_recovery_nginx}" \
      "${edge_recovery_marker_next}" "${edge_recovery_caddy_next}" \
      "${edge_recovery_nginx_next}"
    if (harden_edge) >/dev/null 2>&1; then
      [[ "${failure_step}" == none ]] || exit 1
      [[ "$(<"${installed_caddy_config}")" == hardened-caddy ]]
      [[ "$(<"${live_config}")" == hardened-nginx ]]
    else
      [[ "${failure_step}" != none ]] || exit 1
      [[ -f "${case_root}/failure-used" ]]
      if [[ "${failure_step}" == recovery-failure ]]; then
        [[ -f "${edge_recovery_marker}" ]]
        [[ "$(<"${edge_recovery_caddy}")" == original-caddy ]]
        [[ "$(<"${edge_recovery_nginx}")" == original-nginx ]]
      else
        [[ "$(<"${installed_caddy_config}")" == original-caddy ]]
        [[ "$(<"${live_config}")" == original-nginx ]]
        [[ ! -e "${edge_recovery_marker}" ]]
      fi
    fi
  done

  pending_retry=true
  runtime_repaired=false
  failure_step=none
  case_root="${harness_root}/pending-retry"
  mkdir -p "${case_root}" "${edge_recovery_root}" "${scratch_directory}"
  printf "original-caddy\n" >"${edge_recovery_caddy}"
  printf "original-nginx\n" >"${edge_recovery_nginx}"
  printf "hardened-caddy\n" >"${installed_caddy_config}"
  printf "original-nginx\n" >"${live_config}"
  : >"${edge_recovery_marker}"
  harden_edge >/dev/null
  [[ "${runtime_repaired}" == true ]]
  [[ "$(<"${installed_caddy_config}")" == hardened-caddy ]]
  [[ "$(<"${live_config}")" == hardened-nginx ]]
  [[ ! -e "${edge_recovery_marker}" ]]

  missing_bot=true
  runtime_repaired=false
  failure_step=none
  case_root="${harness_root}/pending-missing-bot"
  mkdir -p "${case_root}" "${edge_recovery_root}" "${scratch_directory}"
  printf "original-caddy\n" >"${edge_recovery_caddy}"
  printf "original-nginx\n" >"${edge_recovery_nginx}"
  printf "partially-hardened-caddy\n" >"${installed_caddy_config}"
  printf "original-nginx\n" >"${live_config}"
  : >"${edge_recovery_marker}"
  if (harden_edge) >/dev/null 2>&1; then
    exit 1
  fi
  [[ "$(<"${installed_caddy_config}")" == partially-hardened-caddy ]]
  [[ "$(<"${live_config}")" == original-nginx ]]
  [[ -e "${edge_recovery_marker}" ]]
  [[ ! -e "${case_root}/host-mutated" ]]
' _ "${edge_hardening_flow}" || \
  fail 'edge hardening apply/recovery failure-injection harness failed'
reject_rg_match \
  'rollback must not downgrade the host renewal worker to its runtime target' \
  'ensure_host_renewal_bundle|verify_candidate_host_renewal_bundle' \
  <(awk '
    $0 == "rollback_release() {" { inside = 1 }
    inside { print }
    inside && $0 == "}" { exit }
  ' "${standalone_release_script}")
rg --fixed-strings --quiet \
  "fail \"certificate renewal recovery is pending or unsafe; run: \${renewal_recovery_instruction}\"" \
  "${standalone_release_script}" || \
  fail 'release recovery-state gate must print the exact recovery-only instruction'
rg --fixed-strings --quiet \
  'docker run --rm --name "${recovery_helper_container}" --pull never \' \
  "${standalone_release_script}" || \
  fail 'release recovery-state probe must use a deterministic reapable container name'
rg --fixed-strings --quiet \
  'volume_match="$(docker volume ls --quiet --filter "name=^${letsencrypt_volume}$")" || return 1' \
  "${standalone_release_script}" || \
  fail 'release recovery-state probe must distinguish an absent ACME volume from inspect failure'
rg --fixed-strings --quiet \
  'container_names="$(docker container ls --all --format '\''{{.Names}}'\'')" || return 1' \
  "${standalone_release_script}" || \
  fail 'release recovery-state probe must fail closed when container enumeration fails'
rg --fixed-strings --quiet -- \
  "--label 'com.docker.compose.project=cometa-bank'" \
  "${standalone_release_script}" || \
  fail 'release recovery-state probe must carry its Compose project ownership label'
rg --fixed-strings --quiet -- \
  "--label 'com.docker.compose.service=certbot'" \
  "${standalone_release_script}" || \
  fail 'release recovery-state probe must carry its Compose service ownership label'
bash "${project_root}/scripts/test-standalone-renewal-bundle.sh" || \
  fail 'standalone host renewal-bundle migration and rollback harness failed'

reject_rg_match \
  'standalone deployment depends on the legacy shared Hostinger stack' \
  '/home/metaflexer|aisatisfy-blog|cometa-proxy' \
  "${project_root}/deploy/standalone"

legacy_renewal_script="${project_root}/deploy/scripts/renew-certificates.sh"
legacy_lifecycle_line() {
  local -r pattern=$1
  local match line_number
  match="$(rg --fixed-strings --line-number "${pattern}" "${legacy_renewal_script}")" || \
    fail "legacy certificate renewal lifecycle step is missing: ${pattern}"
  [[ "${match}" != *$'\n'* ]] || \
    fail "legacy certificate renewal lifecycle step is ambiguous: ${pattern}"
  line_number="${match%%:*}"
  [[ "${line_number}" =~ ^[0-9]+$ ]] || \
    fail "legacy certificate renewal lifecycle step has no line number: ${pattern}"
  printf '%s\n' "${line_number}"
}

legacy_snapshot_line="$(legacy_lifecycle_line \
  "snapshot_lineages || fail 'could not snapshot every current certificate lineage'")"
legacy_arm_line="$(legacy_lifecycle_line \
  "arm_durable_recovery || fail 'could not persist the pre-renewal recovery bundle'")"
legacy_renew_line="$(legacy_lifecycle_line 'renew --no-random-sleep-on-renew || fail')"
legacy_validate_line="$(legacy_lifecycle_line \
  "validate_candidate_lineages || fail 'candidate lineage expiry, SAN, key, or trust validation failed'")"
legacy_nginx_test_line="$(legacy_lifecycle_line \
  "docker exec \"\${PROXY_CONTAINER}\" nginx -t || fail 'candidate lineages failed the proxy configuration test'")"
legacy_nginx_reload_line="$(legacy_lifecycle_line \
  "docker exec \"\${PROXY_CONTAINER}\" nginx -s reload || fail 'proxy reload failed'")"
legacy_probe_line="$(legacy_lifecycle_line \
  "probe_candidate_served_certificates || fail 'proxy did not serve every validated candidate certificate'")"
legacy_commit_line="$(legacy_lifecycle_line \
  "retire_durable_recovery || fail 'could not commit the validated certificate state'")"

(( legacy_snapshot_line < legacy_arm_line &&
  legacy_arm_line < legacy_renew_line &&
  legacy_renew_line < legacy_validate_line &&
  legacy_validate_line < legacy_nginx_test_line &&
  legacy_nginx_test_line < legacy_nginx_reload_line &&
  legacy_nginx_reload_line < legacy_probe_line &&
  legacy_probe_line < legacy_commit_line )) || \
  fail 'legacy certificate renewal must snapshot, arm rollback, validate, reload, probe, then commit'
rg --fixed-strings --quiet 'if stop_renewal_container && restore_previous_state; then' \
  "${legacy_renewal_script}" || \
  fail 'legacy certificate renewal cleanup must stop its writer before restoring the served state'
rg --fixed-strings --quiet \
  "recover_pending_state || fail 'could not recover the pending pre-renewal certificate state'" \
  "${legacy_renewal_script}" || \
  fail 'legacy certificate renewal must recover a durable pending state before renewal'
rg --fixed-strings --quiet 'cmp -s "${certificate_public}" "${key_public}"' \
  "${legacy_renewal_script}" || \
  fail 'legacy certificate renewal must validate certificate/private-key correspondence'
rg --fixed-strings --quiet \
  'openssl verify -purpose sslserver -CApath /etc/ssl/certs' \
  "${legacy_renewal_script}" || \
  fail 'legacy certificate renewal must validate the candidate trust chain now'
rg --fixed-strings --quiet \
  'openssl verify -purpose sslserver -attime "${validation_time}" -CApath /etc/ssl/certs' \
  "${legacy_renewal_script}" || \
  fail 'legacy certificate renewal must validate the candidate trust chain through its safety window'
bash "${project_root}/scripts/test-legacy-certificate-renewal.sh" || \
  fail 'legacy certificate renewal rollback harness failed'

reject_rg_match \
  'a token-shaped value exists in production code or deployment files' \
  --glob '!*.test.ts' \
  --glob '!*.md' \
  '[0-9]{6,20}:[A-Za-z0-9_-]{30,}' \
  "${project_root}/bot" "${project_root}/deploy" "${project_root}/src"

activation_timing="$(bash -c '
    source "$1"
    printf "%s %s %s %s\n" \
      "${bot_setup_deadline_seconds}" \
      "${initial_long_poll_timeout_seconds}" \
      "${health_readiness_margin_seconds}" \
      "${health_deadline_seconds}"
  ' _ "${project_root}/deploy/bot/activate.sh"
)" || fail 'could not inspect bot activation readiness constants'
read -r \
  activation_setup_seconds \
  activation_poll_seconds \
  activation_margin_seconds \
  activation_health_seconds <<<"${activation_timing}"

setup_deadline_ms="$(sed -nE \
  's/^const SETUP_DEADLINE_MS = ([0-9_]+);$/\1/p' \
  "${project_root}/bot/setup.ts")"
poll_timeout_seconds="$(sed -nE \
  's/^const POLL_TIMEOUT_SECONDS = ([0-9_]+);$/\1/p' \
  "${project_root}/bot/poller.ts")"
setup_deadline_ms="${setup_deadline_ms//_/}"
poll_timeout_seconds="${poll_timeout_seconds//_/}"

[[ "${setup_deadline_ms}" =~ ^[0-9]+$ ]] || \
  fail 'could not read SETUP_DEADLINE_MS from bot/setup.ts'
[[ "${poll_timeout_seconds}" =~ ^[0-9]+$ ]] || \
  fail 'could not read POLL_TIMEOUT_SECONDS from bot/poller.ts'
(( setup_deadline_ms % 1000 == 0 )) || \
  fail 'SETUP_DEADLINE_MS must be an exact number of seconds'
(( activation_setup_seconds * 1000 == setup_deadline_ms )) || \
  fail 'bot activation setup budget has drifted from SETUP_DEADLINE_MS'
(( activation_poll_seconds == poll_timeout_seconds )) || \
  fail 'bot activation poll budget has drifted from POLL_TIMEOUT_SECONDS'
(( activation_margin_seconds >= 60 )) || \
  fail 'bot activation readiness margin must be at least 60 seconds'
(( activation_health_seconds >= 240 )) || \
  fail 'bot activation readiness deadline must be at least 240 seconds'
(( activation_health_seconds >= \
  activation_setup_seconds + activation_poll_seconds + activation_margin_seconds )) || \
  fail 'bot activation readiness deadline does not cover setup, first poll, and margin'

for dockerfile in \
  deploy/standalone/Bot.Dockerfile \
  deploy/standalone/Web.Dockerfile; do
  from_count=0
  while IFS= read -r from_line; do
    from_count=$((from_count + 1))
    [[ "${from_line}" =~ ^FROM[[:space:]]+[^[:space:]]+@sha256:[a-f0-9]{64}([[:space:]]+AS[[:space:]]+[A-Za-z0-9._-]+)?$ ]] || \
      fail "unpinned or malformed base image in ${dockerfile}: ${from_line}"
  done < <(rg '^FROM[[:space:]]' "${project_root}/${dockerfile}")
  (( from_count > 0 )) || fail "Dockerfile has no FROM instruction: ${dockerfile}"
done
rg --quiet 'certbot/certbot:v[0-9.]+@sha256:[a-f0-9]{64}' \
  "${project_root}/deploy/standalone/compose.yaml" || \
  fail 'Certbot image must use a digest pin'

standalone_compose="${project_root}/deploy/standalone/compose.yaml"
node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const composePath = process.argv[1];
  const lines = readFileSync(composePath, "utf8").split(/\r?\n/);
  const fail = (message) => { throw new Error(message); };
  const serviceBlock = (serviceName) => {
    const start = lines.indexOf(`  ${serviceName}:`);
    if (start < 0) fail(`standalone Compose service is missing: ${serviceName}`);
    let end = lines.length;
    for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    return lines.slice(start + 1, end);
  };
  const publishedPorts = (serviceName) => {
    const block = serviceBlock(serviceName);
    const portsStart = block.indexOf("    ports:");
    if (portsStart < 0) return [];
    const ports = [];
    for (let cursor = portsStart + 1; cursor < block.length; cursor += 1) {
      const line = block[cursor];
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= 4) break;
      const item = line.match(/^\s{6}-\s*"([^"]+)"\s*$/);
      if (!item) fail(`unsupported ${serviceName} port declaration: ${line.trim()}`);
      ports.push(item[1].trim());
    }
    return ports;
  };
  const servicesStart = lines.indexOf("services:");
  if (servicesStart < 0) fail("standalone Compose services block is missing");
  const serviceNames = [];
  for (let cursor = servicesStart + 1; cursor < lines.length; cursor += 1) {
    if (/^[A-Za-z0-9_-]+:\s*$/.test(lines[cursor])) break;
    const service = lines[cursor].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (service) serviceNames.push(service[1]);
  }
  if (!serviceNames.includes("web")) fail("standalone Compose web service is missing");
  let bindMountCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index].match(/^(\s*)- type:\s*bind\s*$/);
    if (!item) continue;
    bindMountCount += 1;
    const itemIndent = item[1].length;
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        block.push(line);
        continue;
      }
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= itemIndent) break;
      block.push(line);
    }
    const safeSetting = `${" ".repeat(itemIndent + 4)}create_host_path: false`;
    if (!block.includes(safeSetting)) {
      const source = block.find((line) => line.trimStart().startsWith("source:"))?.trim();
      fail(`bind mount must set create_host_path: false: ${source ?? `item ${bindMountCount}`}`);
    }
  }

  if (bindMountCount !== 3) {
    fail(`standalone Compose bind mount count changed: expected 3, got ${bindMountCount}`);
  }
  const webPorts = publishedPorts("web").sort();
  const expectedWebPorts = ["127.0.0.1:8080:8080", "127.0.0.1:8443:8443"].sort();
  if (JSON.stringify(webPorts) !== JSON.stringify(expectedWebPorts)) {
    fail(`web must publish only exact loopback 8080/8443 bindings, got: ${webPorts.join(", ")}`);
  }
  for (const serviceName of serviceNames.filter((name) => name !== "web")) {
    if (publishedPorts(serviceName).length !== 0) {
      fail(`${serviceName} must not publish a host port`);
    }
  }
' "${standalone_compose}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  rendered_compose="$(COMETA_RELEASE_ID='20990101T000000Z' \
    COMETA_DEPLOY_ROOT='/srv/cometa-bank' \
    docker compose \
      -f "${standalone_compose}" \
      config --format json)"
  node --input-type=module --eval '
    import { readFileSync } from "node:fs";
    const config = JSON.parse(readFileSync(0, "utf8"));
    const fail = (message) => { throw new Error(message); };
    const webPorts = (config.services.web.ports ?? []).map((port) => ({
      hostIp: String(port.host_ip ?? ""),
      published: String(port.published),
      target: String(port.target),
      protocol: String(port.protocol ?? "tcp"),
    })).sort((left, right) => left.published.localeCompare(right.published));
    const expectedWebPorts = [
      { hostIp: "127.0.0.1", published: "8080", target: "8080", protocol: "tcp" },
      { hostIp: "127.0.0.1", published: "8443", target: "8443", protocol: "tcp" },
    ];
    if (JSON.stringify(webPorts) !== JSON.stringify(expectedWebPorts)) {
      fail(`web must publish only loopback 8080/8443, got: ${JSON.stringify(webPorts)}`);
    }
    for (const [serviceName, service] of Object.entries(config.services)) {
      if (serviceName !== "web" && (service.ports ?? []).length !== 0) {
        fail(`${serviceName} must not publish a host port`);
      }
    }
    if (config.networks.edge.internal !== true) fail("edge network must be internal");
    if (config.networks.public.internal === true) fail("public network must permit published web ports");
    const webNetworks = Object.keys(config.services.web.networks ?? {}).sort();
    if (JSON.stringify(webNetworks) !== JSON.stringify(["edge", "public"])) {
      fail("web must join only edge and public networks");
    }
    const botNetworks = Object.keys(config.services.bot.networks ?? {}).sort();
    if (JSON.stringify(botNetworks) !== JSON.stringify(["edge", "egress"])) {
      fail("bot must join only edge and egress networks");
    }
    for (const serviceName of ["web", "bot"]) {
      const service = config.services[serviceName];
      if (service.pull_policy !== "never") fail(`${serviceName} may pull at activation`);
      if (service.read_only !== true) fail(`${serviceName} root filesystem must be read-only`);
      if (!service.cap_drop?.includes("ALL")) fail(`${serviceName} must drop all capabilities`);
    }
    for (const volume of config.services.bot.volumes ?? []) {
      if (volume.type === "bind" && volume.bind?.create_host_path === true) {
        fail(`rendered bot bind mount enables host-path creation: ${volume.source}`);
      }
    }
  ' <<<"${rendered_compose}"
fi

release_script="${project_root}/deploy/standalone/scripts/release.sh"
database_image_probe="$(sed -n \
  '/^database_check_with_image() {$/,/^}$/p' "${release_script}")"
materialization_probe="$(sed -n \
  '/^verify_materialized_database() {$/,/^}$/p' "${release_script}")"
database_backup_flow="$(sed -n \
  '/^prepare_database_backup() {$/,/^}$/p' "${release_script}")"

for required_probe in \
  'PRAGMA wal_checkpoint(TRUNCATE)' \
  'checkpoint?.busy !== 0 || checkpoint?.log !== 0' \
  'PRAGMA quick_check' \
  'PRAGMA user_version' \
  'PRAGMA schema_version' \
  "sqlite_schema WHERE name NOT LIKE 'sqlite_%'"; do
  grep -Fq "${required_probe}" <<<"${database_image_probe}" || \
    fail "candidate database image probe is missing: ${required_probe}"
done

for required_probe in \
  'PRAGMA quick_check;' \
  'PRAGMA user_version;' \
  'PRAGMA schema_version;' \
  "sqlite_schema WHERE name NOT LIKE 'sqlite_%'" \
  '[[ "${actual_contract}" == "${expected_contract}" ]]'; do
  grep -Fq "${required_probe}" <<<"${materialization_probe}" || \
    fail "host database materialization probe is missing: ${required_probe}"
done

bash -c '
  set -Eeuo pipefail
  eval "$1"
  sqlite3() {
    case "$*" in
      *"PRAGMA quick_check;"*) printf "ok\n" ;;
      *"PRAGMA user_version;"*) printf "2\n" ;;
      *"PRAGMA schema_version;"*) printf "17\n" ;;
      *"SELECT count(*) FROM sqlite_schema"*) printf "6\n" ;;
      *) return 1 ;;
    esac
  }
  verify_materialized_database /ignored.sqlite "2|17|6"
  if verify_materialized_database /ignored.sqlite "2|17|5"; then
    exit 1
  fi
' _ "${materialization_probe}" || \
  fail 'host database materialization probe does not enforce the candidate contract'

flow_line() {
  local -r needle=$1
  local line
  line="$(awk -v needle="${needle}" 'index($0, needle) { print NR; exit }' \
    <<<"${database_backup_flow}")"
  [[ "${line}" =~ ^[0-9]+$ ]] || \
    fail "database compatibility flow is missing: ${needle}"
  printf '%s\n' "${line}"
}

fallback_image_line="$(flow_line 'verify_release_images "${fallback_release}"')"
database_exists_line="$(flow_line '[[ -f "${live_database_path}" ]] || return 0')"
compat_install_line="$(flow_line 'install -m 0600 -- "${backup_path}" "${compat_copy}"')"
compat_owner_line="$(flow_line 'chown -- "+${bot_uid}:+${bot_uid}" "${compat_copy}"')"
target_image_line="$(flow_line 'target_contract="$(database_check_with_image')"
target_materialized_line="$(flow_line 'verify_materialized_database "${compat_copy}" "${target_contract}"')"
fallback_image_probe_line="$(flow_line 'fallback_contract="$(database_check_with_image')"
fallback_materialized_line="$(flow_line 'verify_materialized_database "${compat_copy}" "${fallback_contract}"')"

(( fallback_image_line < database_exists_line && \
  database_exists_line < compat_install_line && \
  compat_install_line < compat_owner_line && \
  compat_owner_line < target_image_line && \
  target_image_line < target_materialized_line && \
  target_materialized_line < fallback_image_probe_line && \
  fallback_image_probe_line < fallback_materialized_line )) || \
  fail 'database compatibility flow must set numeric ownership before probing images'

reject_rg_match \
  'database compatibility copy must not pass a numeric service ID through install user lookup' \
  'install[^\n]*[[:space:]]-[og][[:space:]]' \
  <(printf '%s\n' "${database_backup_flow}")

bash -c '
  set -Eeuo pipefail
  database_backup_flow=$1
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT

  deploy_root="${harness_root}/deploy"
  live_database_path="${deploy_root}/data/cometa-bank.sqlite"
  bot_uid=10001
  release_id=20990101T000000Z
  compat_copy=""
  expected_backup="${deploy_root}/backups/20990103T000000Z-before-${release_id}.sqlite"
  expected_compat="${expected_backup}.compat"
  install_marker="${harness_root}/install-called"
  chown_marker="${harness_root}/chown-called"
  mkdir -p "${deploy_root}/data" "${deploy_root}/backups"
  printf "live-database\n" >"${deploy_root}/data/cometa-bank.sqlite"

  fail() { printf "ERROR: %s\n" "$1" >&2; return 1; }
  log() { :; }
  date() { printf "20990103T000000Z\n"; }
  verify_release_images() { :; }
  sqlite3() {
    local -r database_path=$1
    local -r statement=$2
    case "${statement}" in
      "PRAGMA quick_check;") printf "ok\n" ;;
      ".backup '\''${expected_backup}'\''") command cp -- "${database_path}" "${expected_backup}" ;;
      *) return 1 ;;
    esac
  }
  install() {
    local argument
    for argument in "$@"; do
      [[ "${argument}" != "-o" && "${argument}" != "-g" ]] || return 64
    done
    [[ $# == 5 && $1 == "-m" && $2 == "0600" && $3 == "--" && \
      $4 == "${expected_backup}" && $5 == "${expected_compat}" ]] || return 65
    command cp -- "$4" "$5"
    command chmod 0600 "$5"
    : >"${install_marker}"
  }
  chown() {
    [[ $# == 3 && $1 == "--" && $2 == "+10001:+10001" && \
      $3 == "${expected_compat}" ]] || return 66
    : >"${chown_marker}"
  }
  database_check_with_image() {
    [[ $2 == "${expected_compat}" && -f "${install_marker}" && \
      -f "${chown_marker}" ]] || return 67
    printf "2|17|6\n"
  }
  verify_materialized_database() {
    [[ $1 == "${expected_compat}" && $2 == "2|17|6" ]]
  }

  eval "${database_backup_flow}"
  prepare_database_backup 20990103T000001Z ""
  [[ -f "${expected_backup}" && ! -e "${expected_compat}" && \
    -f "${install_marker}" && -f "${chown_marker}" ]]
' _ "${database_backup_flow}" || \
  fail 'database compatibility copy does not support a numeric UID/GID without passwd entries'

for nginx_config in \
  "${project_root}/deploy/standalone/nginx/https.conf" \
  "${project_root}/deploy/nginx/euphoria.bot.conf"; do
  for route in \
    'location = /api/tma/bootstrap {' \
    'location = /api/tma/bank-import {' \
    'location = /api/tma/bank-command {' \
    'location = /api/tma/bank-rates {'; do
    rg --fixed-strings --quiet "${route}" "${nginx_config}" || \
      fail "TMA edge route is missing from ${nginx_config}: ${route}"
  done
  rg --fixed-strings --quiet 'client_max_body_size 5m;' "${nginx_config}" || \
    fail "TMA bank import size boundary is missing from ${nginx_config}"
  rg --fixed-strings --quiet 'client_max_body_size 64k;' "${nginx_config}" || \
    fail "TMA bank command size boundary is missing from ${nginx_config}"
  rg --fixed-strings --quiet 'proxy_pass http://$cometa_bot_upstream:8787/bank-import;' \
    "${nginx_config}" || fail "TMA bank import upstream is missing from ${nginx_config}"
  rg --fixed-strings --quiet 'proxy_pass http://$cometa_bot_upstream:8787/bank-command;' \
    "${nginx_config}" || fail "TMA bank command upstream is missing from ${nginx_config}"
  rg --fixed-strings --quiet 'client_max_body_size 1k;' "${nginx_config}" || \
    fail "TMA bank rates size boundary is missing from ${nginx_config}"
  rg --fixed-strings --quiet 'proxy_pass http://$cometa_bot_upstream:8787/bank-rates;' \
    "${nginx_config}" || fail "TMA bank rates upstream is missing from ${nginx_config}"
done

ledger_mode_flow="$(sed -n \
  '/^enable_server_ledger_mode() {$/,/^}$/p' "${release_script}")"
ledger_switch_flow="$(sed -n \
  '/^switch_live_ledger_mode_to_server() {$/,/^}$/p' "${release_script}")"
ledger_reconcile_flow="$(sed -n \
  '/^reconcile_failed_ledger_mode_switch() {$/,/^}$/p' "${release_script}")"
ledger_bot_restart_flow="$(sed -n \
  '/^restart_bot_for_server_commands() {$/,/^}$/p' "${release_script}")"
ledger_backup_flow="$(sed -n \
  '/^prepare_ledger_mode_backup() {$/,/^}$/p' "${release_script}")"
https_smoke_flow="$(release_function_body https_smoke_on_boundary)"
api_smoke_profile="$(release_function_body release_api_smoke_profile)"
tls_web_probe="$(release_function_body tls_web_smoke)"
https_release_alias_probe="$(release_function_body tls_release_alias_smoke)"
https_unauthenticated_probe="$(release_function_body tls_unauthenticated_probe)"
outer_www_redirect_probe="$(release_function_body outer_caddy_www_redirect_smoke)"
inner_smoke_wrapper="$(release_function_body inner_upstream_https_smoke)"
outer_smoke_wrapper="$(release_function_body outer_caddy_https_smoke)"
legacy_bridge_operator_probe="$(release_function_body legacy_bridge_operator_path)"
pinned_bridge_warning_probe="$(release_function_body warn_pinned_bridge_operator)"
authority_bot_probe="$(sed -n \
  '/^probe_authority_bot_image() {$/,/^}$/p' "${release_script}")"
authority_web_probe="$(sed -n \
  '/^probe_authority_web_image() {$/,/^}$/p' "${release_script}")"

for required_marker in \
  bank_authority_disabled \
  bank_import_required \
  /bank-import \
  /bank-command \
  /bank-rates \
  ledger_mode \
  setLedgerMode; do
  grep -Fq "${required_marker}" <<<"${authority_bot_probe}" || \
    fail "bot authority image probe is missing: ${required_marker}"
done

for required_smoke_contract in \
  'api_profile="$(release_api_smoke_profile "${target_release}")"' \
  'tls_web_smoke "${boundary}" "/app/${target_release}/"' \
  'tls_release_alias_smoke "${boundary}" "${target_release}"' \
  "tls_unauthenticated_probe \"\${boundary}\" '/api/tma/bootstrap'" \
  'if [[ "${api_profile}" == '\''authority'\'' ]]; then' \
  "tls_unauthenticated_probe \"\${boundary}\" '/api/tma/bank-import'" \
  "tls_unauthenticated_probe \"\${boundary}\" '/api/tma/bank-command'" \
  "tls_unauthenticated_probe \"\${boundary}\" '/api/tma/bank-rates'" \
  '"stateVersion":5' \
  '"clientMutationId":"00000000000000000000000000000000"'; do
  grep -Fq "${required_smoke_contract}" <<<"${https_smoke_flow}" || \
    fail "shared inner/outer HTTPS smoke is missing: ${required_smoke_contract}"
done
for required_profile_contract in \
  '[[ -f "${target_config}" && ! -L "${target_config}" ]]' \
  "grep -Fq 'location = /api/tma/bootstrap {'" \
  'for route in bank-import bank-command bank-rates; do' \
  'authority_route_count=$((authority_route_count + 1))' \
  "0) printf 'legacy\\n'" \
  "3) printf 'authority\\n'" \
  'partial authority API'; do
  grep -Fq "${required_profile_contract}" <<<"${api_smoke_profile}" || \
    fail "release API smoke-profile guard is missing: ${required_profile_contract}"
done
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  harness_root="$(mktemp -d)"
  trap '\''rm -rf -- "${harness_root}"'\'' EXIT
  deploy_root="${harness_root}"
  legacy_release=20990101T000000Z
  authority_release=20990102T000000Z
  partial_release=20990103T000000Z
  symlink_release=20990104T000000Z
  for target_release in \
    "${legacy_release}" \
    "${authority_release}" \
    "${partial_release}" \
    "${symlink_release}"; do
    mkdir -p "${deploy_root}/releases/${target_release}/deploy/standalone/nginx"
  done
  legacy_config="${deploy_root}/releases/${legacy_release}/deploy/standalone/nginx/https.conf"
  authority_config="${deploy_root}/releases/${authority_release}/deploy/standalone/nginx/https.conf"
  partial_config="${deploy_root}/releases/${partial_release}/deploy/standalone/nginx/https.conf"
  symlink_config="${deploy_root}/releases/${symlink_release}/deploy/standalone/nginx/https.conf"
  printf "%s\n" "location = /api/tma/bootstrap {" >"${legacy_config}"
  printf "%s\n" \
    "location = /api/tma/bootstrap {" \
    "location = /api/tma/bank-import {" \
    "location = /api/tma/bank-command {" \
    "location = /api/tma/bank-rates {" >"${authority_config}"
  printf "%s\n" \
    "location = /api/tma/bootstrap {" \
    "location = /api/tma/bank-import {" >"${partial_config}"
  ln -s "${legacy_config}" "${symlink_config}"
  operator_script="${deploy_root}/releases/${authority_release}/deploy/standalone/scripts/release.sh"
  symlink_operator_script="${deploy_root}/releases/${symlink_release}/deploy/standalone/scripts/release.sh"
  mkdir -p "$(dirname -- "${operator_script}")" "$(dirname -- "${symlink_operator_script}")"
  : >"${operator_script}"
  ln -s /dev/null "${symlink_operator_script}"
  fail() { exit 91; }
  [[ "$(release_api_smoke_profile "${legacy_release}")" == legacy ]]
  [[ "$(release_api_smoke_profile "${authority_release}")" == authority ]]
  [[ "$(legacy_bridge_operator_path "${legacy_release}" "${authority_release}")" == \
    "${operator_script}" ]]
  [[ -z "$(legacy_bridge_operator_path "${authority_release}" "${authority_release}")" ]]
  if (legacy_bridge_operator_path "${legacy_release}" "${symlink_release}" \
    >/dev/null 2>&1); then
    exit 1
  fi
  if (release_api_smoke_profile "${partial_release}" >/dev/null 2>&1); then
    exit 1
  fi
  if (release_api_smoke_profile "${symlink_release}" >/dev/null 2>&1); then
    exit 1
  fi
  log() { printf "%s\n" "$*"; }
  for warning_context in activation-risk activation-live rollback-live; do
    warning_output="$(warn_pinned_bridge_operator "${warning_context}" \
      "${legacy_release}" "${operator_script}")"
    [[ "${warning_output}" == *"WARNING:"* ]]
    [[ "${warning_output}" == *"${operator_script}"* ]]
  done
  [[ -z "$(warn_pinned_bridge_operator activation-risk \
    "${authority_release}" "")" ]]
  if (warn_pinned_bridge_operator invalid "${legacy_release}" "${operator_script}" \
    >/dev/null 2>&1); then
    exit 1
  fi
' _ "${api_smoke_profile}" "${legacy_bridge_operator_probe}" \
  "${pinned_bridge_warning_probe}" || \
  fail 'release API smoke-profile compatibility harness failed'
for required_release_alias_contract in \
  '"https://${domain}:${port}/app/${unknown_release}/"' \
  '[[ "${status}" == '\''200'\'' ]]'; do
  grep -Fq "${required_release_alias_contract}" <<<"${https_release_alias_probe}" || \
    fail "rollback-safe Mini App release alias smoke is missing: ${required_release_alias_contract}"
done
for required_unauthenticated_contract in \
  "[[ \"\${status}\" == '401' ]]" \
  '"error":"invalid_init_data"'; do
  grep -Fq "${required_unauthenticated_contract}" <<<"${https_unauthenticated_probe}" || \
    fail "inner/outer HTTPS unauthenticated probe is missing: ${required_unauthenticated_contract}"
done
for required_www_redirect_contract in \
  'expected_location="https://${domain}/app/${target_release}/"' \
  '--resolve "${www_domain}:443:127.0.0.1"' \
  '"https://${www_domain}:443/app/${target_release}/"' \
  '[[ "${status}" == '\''301'\'' || "${status}" == '\''308'\'' ]]' \
  '[[ "${location}" == "${expected_location}" ]]'; do
  grep -Fq -- "${required_www_redirect_contract}" <<<"${outer_www_redirect_probe}" || \
    fail "outer Caddy www redirect smoke is missing: ${required_www_redirect_contract}"
done
reject_rg_match \
  'outer Caddy www redirect smoke must verify public TLS' \
  --fixed-strings -- '--insecure' \
  <(printf '%s\n' "${outer_www_redirect_probe}")
for boundary_probe in \
  "${tls_web_probe}" \
  "${https_release_alias_probe}" \
  "${https_unauthenticated_probe}" \
  "${outer_www_redirect_probe}"; do
  for required_probe_deadline in \
    '--connect-timeout "${tls_probe_connect_timeout}"' \
    '--max-time "${tls_probe_max_time}"'; do
    grep -Fq -- "${required_probe_deadline}" <<<"${boundary_probe}" || \
      fail "HTTPS probe has no bounded deadline: ${required_probe_deadline}"
  done
done
for boundary_probe in \
  "${tls_web_probe}" \
  "${https_release_alias_probe}" \
  "${https_unauthenticated_probe}"; do
  for required_inner_boundary in \
    "inner)" \
    "port='8443'"; do
    grep -Fq -- "${required_inner_boundary}" <<<"${boundary_probe}" || \
      fail "inner upstream TLS boundary is missing: ${required_inner_boundary}"
  done
  for required_outer_boundary in \
    "outer) port='443'" \
    '"https://${domain}:${port}'; do
    grep -Fq -- "${required_outer_boundary}" <<<"${boundary_probe}" || \
      fail "outer Caddy TLS boundary is missing: ${required_outer_boundary}"
  done
  reject_rg_match \
    'inner and outer TLS probes must verify certificates' \
    --fixed-strings -- '--insecure' \
    <(printf '%s\n' "${boundary_probe}")
done
reject_rg_match \
  'release lifecycle must never disable TLS verification' \
  --fixed-strings -- '--insecure' "${release_script}"
for required_inner_certificate_contract in \
  "for hostname in \"\${domain}\" \"\${www_domain}\"; do" \
  'timeout --signal=TERM --kill-after="${tls_handshake_kill_after}" --foreground' \
  '"${tls_handshake_timeout}" openssl s_client' \
  '-verify_hostname "${hostname}"' \
  '-verify_return_error' \
  '-CApath /etc/ssl/certs' \
  'openssl x509 -in "${leaf_certificate}" -noout -checkend 1814400' \
  'certificate_covers_host "${leaf_certificate}" "${hostname}"'; do
  grep -Fq -- "${required_inner_certificate_contract}" \
    <<<"${served_inner_certificate_flow}" || \
    fail "served inner-certificate guard is missing: ${required_inner_certificate_contract}"
done
grep -Fq 'verify_served_inner_certificates || return 1' <<<"${inner_smoke_wrapper}" || \
  fail 'every inner HTTPS aggregate must verify the served certificate first'
grep -Fq 'https_smoke_on_boundary inner "$1"' <<<"${inner_smoke_wrapper}" || \
  fail 'inner upstream smoke wrapper must target loopback 8443'
grep -Fq 'https_smoke_on_boundary outer "$1"' <<<"${outer_smoke_wrapper}" || \
  fail 'outer Caddy smoke wrapper must target public TLS 443'
grep -Fq 'outer_caddy_www_redirect_smoke "$1"' <<<"${outer_smoke_wrapper}" || \
  fail 'outer Caddy smoke wrapper must verify the www canonical redirect'
bash -c '
  set -Eeuo pipefail
  eval "$1"
  eval "$2"
  eval "$3"
  failure=none
  release_api_smoke_profile() {
    [[ "${failure}" != profile ]] || return 1
    printf "authority\n"
  }
  tls_web_smoke() {
    [[ "${failure}" != web ]]
  }
  tls_release_alias_smoke() {
    [[ "${failure}" != alias ]]
  }
  tls_unauthenticated_probe() {
    local probe_name=${2#/api/tma/}
    [[ "${failure}" != "${probe_name}" ]]
  }
  outer_caddy_www_redirect_smoke() {
    [[ "${failure}" != redirect ]]
  }
  verify_served_inner_certificates() {
    [[ "${failure}" != certificate ]]
  }
  fail() { return 1; }

  target_release=20990101T000000Z
  for failure in profile web alias bootstrap bank-import bank-command bank-rates; do
    if https_smoke_on_boundary inner "${target_release}" >/dev/null 2>&1; then
      exit 1
    fi
  done
  failure=certificate
  if inner_upstream_https_smoke "${target_release}" >/dev/null 2>&1; then
    exit 1
  fi
  failure=web
  if inner_upstream_https_smoke "${target_release}" >/dev/null 2>&1; then
    exit 1
  fi
  if outer_caddy_https_smoke "${target_release}" >/dev/null 2>&1; then
    exit 1
  fi
  failure=redirect
  if outer_caddy_https_smoke "${target_release}" >/dev/null 2>&1; then
    exit 1
  fi
  failure=none
  https_smoke_on_boundary inner "${target_release}" >/dev/null
  inner_upstream_https_smoke "${target_release}" >/dev/null
  outer_caddy_https_smoke "${target_release}" >/dev/null
' _ "${https_smoke_flow}" "${inner_smoke_wrapper}" "${outer_smoke_wrapper}" || \
  fail 'inner/outer HTTPS smoke failure-propagation harness failed'
for staged_smoke_function in \
  prepare_release \
  activate_release \
  rollback_runtime \
  show_status \
  show_ledger_mode_status \
  enable_server_ledger_mode; do
  staged_smoke_body="$(release_function_body "${staged_smoke_function}")"
  grep -Fq 'inner_upstream_https_smoke' <<<"${staged_smoke_body}" || \
    fail "${staged_smoke_function} must exercise the inner HTTPS upstream"
  grep -Fq 'outer_caddy_https_smoke' <<<"${staged_smoke_body}" || \
    fail "${staged_smoke_function} must exercise the outer Caddy edge"
done
rollback_smoke_body="$(release_function_body rollback_release)"
for required_rollback_real_ip_contract in \
  'prepare_hardened_nginx_config' \
  'test_nginx_config "${previous_release}" "${rollback_config}"' \
  'install_live_config "${rollback_config}"'; do
  grep -Fq "${required_rollback_real_ip_contract}" <<<"${rollback_smoke_body}" || \
    fail "rollback trusted real-IP contract is missing: ${required_rollback_real_ip_contract}"
done
for applied_rollback_smoke in inner_upstream_https_smoke outer_caddy_https_smoke; do
  grep -Fq "${applied_rollback_smoke}" <<<"${rollback_smoke_body}" || \
    fail "applied rollback must exercise ${applied_rollback_smoke}"
done
rollback_apply_gate_line="$(release_function_step_line rollback_release \
  '[[ "${apply_rollback}" == true ]] || {')"
rollback_first_inner_smoke_line="$(release_function_step_line rollback_release \
  'inner_upstream_https_smoke "${previous_release}"' first)"
rollback_first_outer_smoke_line="$(release_function_step_line rollback_release \
  'outer_caddy_https_smoke "${previous_release}"' first)"
(( rollback_apply_gate_line < rollback_first_inner_smoke_line && \
  rollback_apply_gate_line < rollback_first_outer_smoke_line )) || \
  fail 'rollback HTTPS smokes must be asserted only for the applied path, not dry-run'
for required_bridge_operator_contract in \
  'api_profile="$(release_api_smoke_profile "${legacy_release}")"' \
  '[[ "${api_profile}" == '\''legacy'\'' ]] || return 0' \
  'operator_script="${deploy_root}/releases/${operator_release}/deploy/standalone/scripts/release.sh"' \
  '[[ -f "${operator_script}" && ! -L "${operator_script}" ]]' \
  'printf '\''%s\n'\'' "${operator_script}"'; do
  grep -Fq "${required_bridge_operator_contract}" <<<"${legacy_bridge_operator_probe}" || \
    fail "pinned legacy bridge operator guard is missing: ${required_bridge_operator_contract}"
done
for required_pinned_warning_contract in \
  '[[ -n "${operator_path}" ]] || return 0' \
  'activation-risk)' \
  'if activation fails or restores it' \
  '${deploy_root}/current/deploy/standalone/scripts/release.sh' \
  'pinned immutable candidate operator: ${operator_path}' \
  'activation-live)' \
  'rollback-live)' \
  "*) fail 'unknown pinned bridge warning context'"; do
  grep -Fq "${required_pinned_warning_contract}" <<<"${pinned_bridge_warning_probe}" || \
    fail "pinned bridge warning helper is missing: ${required_pinned_warning_contract}"
done
activate_flow="$(release_function_body activate_release)"
rollback_flow="$(release_function_body rollback_release)"
grep -Fq 'rollback must be run through the immutable current release operator' \
  <<<"${rollback_flow}" || \
  fail 'initial rollback must bind its lifecycle operator to the current release'
for required_activation_bridge_contract in \
  'bridge_operator_path="$(legacy_bridge_operator_path "${current_release}" "${release_id}")"' \
  'warn_pinned_bridge_operator activation-risk "${current_release}" "${bridge_operator_path}"' \
  'warn_pinned_bridge_operator activation-live "${current_release}" "${bridge_operator_path}"'; do
  grep -Fq "${required_activation_bridge_contract}" <<<"${activate_flow}" || \
    fail "activation legacy bridge warning is missing: ${required_activation_bridge_contract}"
done
for required_rollback_bridge_contract in \
  'bridge_operator_path="$(legacy_bridge_operator_path "${previous_release}" "${current_release}")"' \
  'warn_pinned_bridge_operator rollback-live "${previous_release}" "${bridge_operator_path}"'; do
  grep -Fq "${required_rollback_bridge_contract}" <<<"${rollback_flow}" || \
    fail "rollback legacy bridge warning is missing: ${required_rollback_bridge_contract}"
done
activation_bridge_probe_line="$(release_function_step_line activate_release \
  'bridge_operator_path="$(legacy_bridge_operator_path "${current_release}" "${release_id}")"')"
activation_risk_warning_line="$(release_function_step_line activate_release \
  'warn_pinned_bridge_operator activation-risk "${current_release}" "${bridge_operator_path}"')"
activation_edge_guard_line="$(release_function_step_line activate_release \
  'assert_staged_edge_contract' first)"
activation_commit_line="$(release_function_step_line activate_release \
  'if ! record_deployment activate "${release_id}"; then')"
activation_warning_line="$(release_function_step_line activate_release \
  'warn_pinned_bridge_operator activation-live "${current_release}" "${bridge_operator_path}"')"
(( activation_bridge_probe_line < activation_risk_warning_line && \
  activation_risk_warning_line < activation_edge_guard_line && \
  activation_edge_guard_line < activation_commit_line && \
  activation_commit_line < activation_warning_line )) || \
  fail 'activation must warn about its pinned bridge before any guarded work and after commit'
rollback_bridge_probe_line="$(release_function_step_line rollback_release \
  'bridge_operator_path="$(legacy_bridge_operator_path "${previous_release}" "${current_release}")"')"
rollback_commit_line="$(release_function_step_line rollback_release \
  'if ! record_deployment rollback "${previous_release}"; then')"
rollback_warning_line="$(release_function_step_line rollback_release \
  'warn_pinned_bridge_operator rollback-live "${previous_release}" "${bridge_operator_path}"')"
(( rollback_bridge_probe_line < rollback_commit_line && \
  rollback_commit_line < rollback_warning_line )) || \
  fail 'rollback must pin its surviving bridge operator before mutation and warn only after commit'
for required_marker in \
  /api/tma/bank-import \
  /api/tma/bank-command \
  /api/tma/bank-rates \
  ledger-authority-mode \
  ledger-client-contract \
  'EXPECTED_RELEASE_ID=${target_release}' \
  'scoped_entry="/usr/share/nginx/html/app/${EXPECTED_RELEASE_ID}/index.html"' \
  'cmp -s /usr/share/nginx/html/index.html "${scoped_entry}"'; do
  grep -Fq "${required_marker}" <<<"${authority_web_probe}" || \
    fail "web authority image probe is missing: ${required_marker}"
done
for required_guard in \
  'verify_release_images "${target_release}"' \
  'probe_authority_bot_image "${target_release}"' \
  'probe_authority_web_image "${target_release}"' \
  '[[ "${release_id}" == "${current_release}" ]]' \
  '[[ "${current_release}" != "${previous_release}" ]]'; do
  rg --fixed-strings --quiet "${required_guard}" "${release_script}" || \
    fail "ledger authority bridge guard is missing: ${required_guard}"
done

for required_backup_step in \
  ".backup '\${backup_path}'" \
  "stat -c '%u:%g:%a'" \
  'PRAGMA quick_check;' \
  "'SELECT ledger_mode FROM service_state WHERE singleton = 1;'" \
  'install -m 0600 -- "${backup_path}" "${compat_copy}"' \
  'chown -- "+${bot_uid}:+${bot_uid}" "${compat_copy}"' \
  'verify_local_authority_backup_with_image "${current_release}" "${compat_copy}"' \
  'verify_local_authority_backup_with_image "${previous_release}" "${compat_copy}"' \
  'rm -f -- "${compat_copy}"' \
  'sync -f "${backup_path}" || fail'; do
  grep -Fq "${required_backup_step}" <<<"${ledger_backup_flow}" || \
    fail "ledger-mode backup guard is missing: ${required_backup_step}"
done
grep -Fq "fail 'ledger-mode backup preparation failed; database remains local'" \
  <<<"${ledger_mode_flow}" || \
  fail 'ledger-mode caller must reject a failed backup command substitution'

ledger_bridge_line="$(release_function_step_line enable_server_ledger_mode \
  'assert_authority_bridge "${current_release}" "${previous_release}"')"
ledger_integrity_line="$(release_function_step_line enable_server_ledger_mode \
  'verify_live_database_integrity' first)"
ledger_backup_line="$(release_function_step_line enable_server_ledger_mode \
  'backup_path="$(prepare_ledger_mode_backup "${current_release}" "${previous_release}")"')"
ledger_ready_event_line="$(release_function_step_line enable_server_ledger_mode \
  'record_deployment ledger-mode-server-ready "${current_release}" || \')"
ledger_switch_line="$(release_function_step_line enable_server_ledger_mode \
  'switch_live_ledger_mode_to_server "${current_release}"')"
ledger_final_event_line="$(release_function_step_line enable_server_ledger_mode \
  'if ! record_deployment ledger-mode-server "${current_release}"; then')"
ledger_bot_restart_line="$(release_function_step_line enable_server_ledger_mode \
  'if ! restart_bot_for_server_commands "${current_release}"; then' last)"
ledger_health_line="$(release_function_step_line enable_server_ledger_mode \
  '! outer_caddy_https_smoke "${current_release}"; then' last)"
(( ledger_bridge_line < ledger_integrity_line && \
  ledger_integrity_line < ledger_backup_line && \
  ledger_backup_line < ledger_ready_event_line && \
  ledger_ready_event_line < ledger_switch_line && \
  ledger_switch_line < ledger_final_event_line && \
  ledger_final_event_line < ledger_bot_restart_line && \
  ledger_bot_restart_line < ledger_health_line )) || \
  fail 'ledger authority must verify bridge/integrity, back up, audit, switch, audit, restart bot, then health-check'

grep -Fq 'compose_release "${current_release}" restart --timeout 20 bot' \
  <<<"${ledger_bot_restart_flow}" || \
  fail 'ledger authority must restart the current bot to publish the server command profile'
reject_rg_match \
  'ledger command-profile restart must not start or recreate unrelated services' \
  'compose_release[^\n]*(up|run)|docker[[:space:]]+run|[[:space:]]web([[:space:]]|$)' \
  <(printf '%s\n' "${ledger_bot_restart_flow}")

for required_reconciliation_step in \
  'if ! (verify_live_database_integrity); then' \
  'mode="$(read_database_ledger_mode)"' \
  'if [[ "${mode}" == '\''server'\'' ]]; then' \
  'final audit will continue' \
  'verified database remains local'; do
  grep -Fq "${required_reconciliation_step}" <<<"${ledger_reconcile_flow}" || \
    fail "ledger-mode failure reconciliation is missing: ${required_reconciliation_step}"
done
grep -Fq 'if ! switch_live_ledger_mode_to_server "${current_release}"; then' \
  <<<"${ledger_mode_flow}" || \
  fail 'ledger-mode helper failure must enter persisted-state reconciliation'
grep -Fq 'reconcile_failed_ledger_mode_switch' <<<"${ledger_mode_flow}" || \
  fail 'ledger-mode helper failure must reconcile the persisted SQLite result'
for required_server_reconciliation in \
  'if [[ "${apply_rollback}" != true ]]; then' \
  'record_deployment ledger-mode-server-reconciled "${current_release}" || \' \
  'restart_bot_for_server_commands "${current_release}"' \
  'server ledger authority and its durable audit trail are reconciled'; do
  grep -Fq "${required_server_reconciliation}" <<<"${ledger_mode_flow}" || \
    fail "already-server reconciliation is missing: ${required_server_reconciliation}"
done

rg --fixed-strings --quiet 'docker exec --user "${bot_uid}:${bot_uid}"' \
  <<<"${ledger_switch_flow}" || \
  fail 'ledger authority switch must run as the existing bot service UID'
rg --fixed-strings --quiet \
  '.prepare("UPDATE service_state SET ledger_mode = ? WHERE singleton = 1 AND ledger_mode = ?")' \
  <<<"${ledger_switch_flow}" || \
  fail 'ledger authority switch must use the singular parameterized update'
reject_rg_match \
  'ledger authority operator must not start another bot or service container' \
  'compose_release[^\n]*(up|run)|docker[[:space:]]+run' \
  <(printf '%s\n' "${ledger_switch_flow}")
reject_rg_match \
  'ledger authority operator must not expose a reverse switch to local mode' \
  "SET ledger_mode[[:space:]]*=[[:space:]]*'local'|ledger-mode[[:space:]]+local|setLedgerMode\([^)]*local" \
  <(printf '%s\n' "${release_script}")

journal_write_line="$(release_function_step_line record_deployment \
  '"${web_image_id}" "${bot_image_id}" >>"${deploy_root}/deployments.jsonl" || return 1')"
journal_mode_line="$(release_function_step_line record_deployment \
  'chmod 0600 "${deploy_root}/deployments.jsonl" || return 1')"
journal_sync_line="$(release_function_step_line record_deployment \
  'sync -f "${deploy_root}/deployments.jsonl" || return 1')"
(( journal_write_line < journal_mode_line && journal_mode_line < journal_sync_line )) || \
  fail 'deployment journal must be written, permissioned, and durably flushed before commit'

activation_ready_line="$(release_function_step_line activate_release \
  'if ! record_deployment activation-ready "${release_id}"; then')"
activation_intent_line="$(release_function_step_line activate_release \
  'if ! arm_activation_intent "${current_release}" "${previous_release:-none}" "${release_id}"; then')"
activation_link_line="$(release_function_step_line activate_release \
  'if ! switch_release_links "${current_release}"; then')"
activation_commit_event_line="$(release_function_step_line activate_release \
  'if ! record_deployment activate "${release_id}"; then')"
activation_intent_retire_line="$(release_function_step_line activate_release \
  'retire_activation_intent || \' last)"
rollback_ready_line="$(release_function_step_line rollback_release \
  'if ! record_deployment rollback-ready "${previous_release}"; then')"
rollback_intent_line="$(release_function_step_line rollback_release \
  'if ! arm_rollback_intent "${current_release}" "${previous_release}"; then')"
rollback_link_line="$(release_function_step_line rollback_release \
  'if ! switch_rollback_links "${current_release}" "${previous_release}"; then')"
rollback_commit_line="$(release_function_step_line rollback_release \
  'if ! record_deployment rollback "${previous_release}"; then')"
rollback_intent_retire_line="$(release_function_step_line rollback_release \
  'retire_rollback_intent || \' last)"
(( activation_ready_line < activation_intent_line && \
  activation_intent_line < activation_link_line && \
  activation_link_line < activation_commit_event_line && \
  activation_commit_event_line < activation_intent_retire_line && \
  rollback_ready_line < rollback_intent_line && \
  rollback_intent_line < rollback_link_line && \
  rollback_link_line < rollback_commit_line && \
  rollback_commit_line < rollback_intent_retire_line )) || \
  fail 'durably flushed ready events must precede release-link commits'

activate_authority_guard_line="$(release_function_step_line activate_release \
  'guard_server_authority_release_transition "${release_id}" "${current_release}"')"
activate_backup_line="$(release_function_step_line activate_release \
  'prepare_database_backup "${release_id}" "${current_release}"')"
rollback_authority_guard_line="$(release_function_step_line rollback_release \
  'guard_server_authority_release_transition "${previous_release}" "${current_release}"')"
rollback_backup_line="$(release_function_step_line rollback_release \
  'prepare_database_backup "${previous_release}" "${current_release}"')"
(( activate_authority_guard_line < activate_backup_line && \
  rollback_authority_guard_line < rollback_backup_line )) || \
  fail 'server authority release guards must run before activation or rollback database mutation'

bash "${project_root}/scripts/test-standalone-ledger-mode.sh" || \
  fail 'standalone ledger-mode deterministic harness failed'

printf 'Deployment guards passed.\n'
