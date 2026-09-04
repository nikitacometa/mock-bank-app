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
  deploy/standalone/scripts/package-release.sh \
  deploy/standalone/scripts/provision-host.sh \
  deploy/standalone/scripts/release.sh \
  deploy/standalone/scripts/renew-certificates-entrypoint.sh \
  deploy/standalone/scripts/renew-certificates.sh; do
  test -x "${project_root}/${script}" || fail "deployment script is not executable: ${script}"
done

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
release_function_step_line() {
  local -r function_name=$1
  local -r pattern=$2
  local -r occurrence=${3:-only}
  local function_body match line_number

  function_body="$(awk -v signature="${function_name}() {" '
    $0 == signature { inside = 1 }
    inside { print }
    inside && $0 == "}" { exit }
  ' "${standalone_release_script}")"
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

activate_bundle_line="$(release_function_step_line activate_release \
  'verify_candidate_host_renewal_bundle "${release_id}" || \')"
activate_migration_line="$(release_function_step_line activate_release \
  'assert_host_renewal_migration_complete')"
activate_state_line="$(release_function_step_line activate_release 'assert_renewal_state_clean')"
activate_backup_line="$(release_function_step_line activate_release \
  'prepare_database_backup "${release_id}" "${current_release}"')"
(( activate_bundle_line < activate_migration_line &&
  activate_migration_line < activate_state_line && activate_state_line < activate_backup_line )) || \
  fail 'activation must verify the candidate worker and clean recovery state before mutation'

rollback_bundle_line="$(release_function_step_line rollback_release \
  'verify_recorded_host_renewal_bundle || \')"
rollback_migration_line="$(release_function_step_line rollback_release \
  'assert_host_renewal_migration_complete')"
rollback_state_line="$(release_function_step_line rollback_release 'assert_renewal_state_clean')"
rollback_backup_line="$(release_function_step_line rollback_release \
  'prepare_database_backup "${previous_release}" "${current_release}"')"
(( rollback_bundle_line < rollback_migration_line &&
  rollback_migration_line < rollback_state_line && rollback_state_line < rollback_backup_line )) || \
  fail 'rollback must preserve the recorded worker and reject pending renewal recovery before mutation'

prepare_preflight_line="$(release_function_step_line prepare_release \
  'assert_prepare_renewal_state_clean')"
prepare_bundle_line="$(release_function_step_line prepare_release \
  'ensure_host_renewal_bundle "${release_id}" "${current_release}" || \')"
prepare_migration_line="$(release_function_step_line prepare_release \
  'assert_host_renewal_migration_complete')"
prepare_state_line="$(release_function_step_line prepare_release 'assert_renewal_state_clean')"
(( prepare_preflight_line < prepare_bundle_line &&
  prepare_bundle_line < prepare_migration_line && prepare_migration_line < prepare_state_line )) || \
  fail 'prepare must reject pending certificate recovery before upgrading its host worker'
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

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  rendered_compose="$(COMETA_RELEASE_ID='20990101T000000Z' \
    COMETA_DEPLOY_ROOT='/srv/cometa-bank' \
    docker compose \
      -f "${project_root}/deploy/standalone/compose.yaml" \
      config --format json)"
  node --input-type=module --eval '
    import { readFileSync } from "node:fs";
    const config = JSON.parse(readFileSync(0, "utf8"));
    const fail = (message) => { throw new Error(message); };
    const published = (config.services.web.ports ?? []).map((port) => String(port.published)).sort();
    if (JSON.stringify(published) !== JSON.stringify(["443", "80"])) fail("only 80/443 may be public");
    if (config.services.bot.ports !== undefined) fail("bot must not publish a host port");
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
      if (volume.type === "bind" && volume.bind?.create_host_path !== false) {
        fail(`bot bind mount may auto-create ${volume.source}`);
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
database_exists_line="$(flow_line '[[ -f "${database_path}" ]] || return 0')"
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

printf 'Deployment guards passed.\n'
