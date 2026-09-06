#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly compose_file="${script_dir}/../compose.yaml"
readonly deploy_root="${COMETA_DEPLOY_ROOT:-/srv/cometa-bank}"
readonly minimum_docker_version='28.0.0'
readonly minimum_compose_version='2.20.0'
readonly compose_project='cometa-bank'
readonly caddy_config='/etc/caddy/Caddyfile'
readonly caddy_service='caddy.service'
readonly caddy_admin_socket='/var/lib/caddy/.local/share/caddy/admin.sock'
readonly caddy_admin_listen="unix/${caddy_admin_socket}|0200"
readonly live_nginx_config="${deploy_root}/state/nginx/default.conf"
readonly legacy_renewal_service='cometa-bank-cert-renew.service'
readonly legacy_renewal_timer='cometa-bank-cert-renew.timer'
readonly domain='euphoria.bot'
readonly www_domain='www.euphoria.bot'
readonly inner_tls_endpoint='127.0.0.1:8443'
readonly inner_tls_timeout_seconds='8'
readonly minimum_certificate_validity_seconds='1814400'

expected_ssh_port=''

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: host-preflight.sh --ssh-port PORT\n'
}

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

# shellcheck source=deploy/standalone/scripts/docker-daemon-perimeter.sh
source "${script_dir}/docker-daemon-perimeter.sh"

check_ufw_allowlist() {
  local ufw_status=$1
  local ipv6_value=''
  local incoming_allow_output=''
  local rule protocol port family key
  local -a incoming_allows=()
  local -A expected_rules=()
  local -A actual_rules=()

  [[ -r /etc/default/ufw ]] || fail '/etc/default/ufw is unavailable'
  ipv6_value="$(awk -F= '
    /^[[:space:]]*IPV6[[:space:]]*=/ {
      value = $2
      gsub(/[[:space:]\047\042]/, "", value)
      print tolower(value)
      exit
    }
  ' /etc/default/ufw)" || fail 'could not parse UFW IPv6 configuration'
  case "${ipv6_value}" in
    yes|no) ;;
    *) fail 'cannot determine whether UFW IPv6 support is enabled' ;;
  esac

  for port in "${expected_ssh_port}" 80 443; do
    expected_rules["v4:${port}/tcp"]=1
    if [[ "${ipv6_value}" == 'yes' ]]; then
      expected_rules["v6:${port}/tcp"]=1
    fi
  done

  incoming_allow_output="$(awk '
      /^\[[[:space:]]*[0-9]+\]/ {
        line = $0
        sub(/^\[[[:space:]]*[0-9]+\][[:space:]]*/, "", line)
        sub(/[[:space:]]+#.*$/, "", line)
        gsub(/[[:space:]]+/, " ", line)
        sub(/^ /, "", line)
        sub(/ $/, "", line)
        if (line ~ / (ALLOW|LIMIT) IN /) {
          print line
        }
      }
    ' <<<"${ufw_status}")" || fail 'could not parse numbered UFW rules'
  if [[ -n "${incoming_allow_output}" ]]; then
    mapfile -t incoming_allows <<<"${incoming_allow_output}"
  fi

  for rule in "${incoming_allows[@]}"; do
    family=''
    port=''
    protocol=''
    if [[ "${rule}" =~ ^([0-9]{1,5})/(tcp)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+Anywhere$ ]]; then
      family='v4'
      port=${BASH_REMATCH[1]}
      protocol=${BASH_REMATCH[2]}
    elif [[ "${rule}" =~ ^([0-9]{1,5})/(tcp)[[:space:]]+\(v6\)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+Anywhere[[:space:]]+\(v6\)$ ]]; then
      family='v6'
      port=${BASH_REMATCH[1]}
      protocol=${BASH_REMATCH[2]}
    else
      fail "unexpected inbound UFW allow rule: ${rule}"
    fi

    key="${family}:${port}/${protocol}"
    [[ -n "${expected_rules[${key}]:-}" ]] || fail "unexpected inbound UFW allow rule: ${rule}"
    [[ -z "${actual_rules[${key}]:-}" ]] || fail "duplicate inbound UFW allow rule: ${rule}"
    actual_rules["${key}"]=1
  done

  for key in "${!expected_rules[@]}"; do
    [[ -n "${actual_rules[${key}]:-}" ]] || fail "missing inbound UFW allow rule: ${key}"
  done
}

caddy_service_pid() {
  local pid comm
  pid="$(timeout --foreground --signal=TERM --kill-after=2s 8s \
    systemctl show --property MainPID --value "${caddy_service}")" || return 1
  [[ "${pid}" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  comm="$(tr -d '\n' <"/proc/${pid}/comm")" || return 1
  [[ "${comm}" == caddy ]] || return 1
  printf '%s\n' "${pid}"
}

validate_caddy_listener_owner() {
  local line=$1
  local expected_pid=$2
  [[ "${line}" == *'users:(("caddy",pid='* ]] || return 1
  awk -v expected_pid="${expected_pid}" '
    {
      remaining = $0
      count = 0
      while (match(remaining, /pid=[0-9]+/)) {
        value = substr(remaining, RSTART + 4, RLENGTH - 4)
        if (value != expected_pid) exit 1
        count += 1
        remaining = substr(remaining, RSTART + RLENGTH)
      }
      exit(count == 1 ? 0 : 1)
    }
  ' <<<"${line}"
}

check_tcp_listeners() {
  local state recv_q send_q local_address peer_address remainder
  local host port listeners caddy_pid confirmed_caddy_pid
  local public_ssh_listener=false
  local public_http_listener=false
  local public_https_listener=false

  caddy_pid="$(caddy_service_pid)" || fail 'cannot resolve caddy.service PID'
  listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s ss -H -lntp)" || \
    fail 'could not inspect host TCP listeners'
  while read -r state recv_q send_q local_address peer_address remainder; do
    [[ "${state}" == 'LISTEN' ]] || continue
    [[ "${local_address}" == *:* ]] || fail "cannot parse TCP listener address: ${local_address}"

    port=${local_address##*:}
    host=${local_address%:*}
    host=${host%%%*}
    host=${host#[}
    host=${host%]}
    [[ "${port}" =~ ^[0-9]{1,5}$ ]] || fail "cannot parse TCP listener port: ${local_address}"

    if [[ "${host}" == 127.* || "${host}" == '::1' || "${host}" == ::ffff:127.* ]]; then
      continue
    fi

    case "${port}" in
      "${expected_ssh_port}")
        [[ "${remainder}" == *'"sshd"'* || "${remainder}" == *'"systemd"'* ]] || \
          fail "expected SSH port is owned by an unexpected process: ${local_address}"
        public_ssh_listener=true
        ;;
      80)
        validate_caddy_listener_owner "${remainder}" "${caddy_pid}" || \
          fail "public HTTP port is not owned exclusively by caddy.service: ${local_address}"
        public_http_listener=true
        ;;
      443)
        validate_caddy_listener_owner "${remainder}" "${caddy_pid}" || \
          fail "public HTTPS port is not owned exclusively by caddy.service: ${local_address}"
        public_https_listener=true
        ;;
      *) fail "unexpected non-loopback TCP listener: ${local_address}" ;;
    esac
  done <<<"${listeners}"

  [[ "${public_ssh_listener}" == true ]] || \
    fail "nothing is listening publicly on expected SSH port ${expected_ssh_port}"
  [[ "${public_http_listener}" == true ]] || fail 'Caddy is not listening publicly on TCP 80'
  [[ "${public_https_listener}" == true ]] || fail 'Caddy is not listening publicly on TCP 443'
  confirmed_caddy_pid="$(caddy_service_pid)" || \
    fail 'cannot recheck caddy.service PID after listener enumeration'
  [[ "${confirmed_caddy_pid}" == "${caddy_pid}" ]] || \
    fail 'caddy.service changed while public listeners were being inspected'
}

check_udp_listeners() {
  local listeners
  listeners="$(ss -H -lunp 'sport = :443')" || fail 'could not inspect public UDP port 443'
  [[ -z "${listeners}" ]] || \
    fail 'public UDP port 443 must stay closed while UFW exposes TCP only'
}

check_nginx_real_ip_contract() {
  local directive_count required_line
  [[ -f "${live_nginx_config}" && ! -L "${live_nginx_config}" ]] || \
    fail 'live Nginx config is missing or symlinked'
  directive_count="$(awk '
    $1 == "set_real_ip_from" || $1 == "real_ip_header" || $1 == "real_ip_recursive" {
      count += 1
    }
    END { print count + 0 }
  ' "${live_nginx_config}")" || fail 'could not inspect the live Nginx real-IP contract'
  [[ "${directive_count}" == '6' ]] || fail 'live Nginx real-IP contract must have six directives'
  for required_line in \
    'set_real_ip_from 127.0.0.1;' \
    'set_real_ip_from 10.0.0.0/8;' \
    'set_real_ip_from 172.16.0.0/12;' \
    'set_real_ip_from 192.168.0.0/16;' \
    'real_ip_header X-Forwarded-For;' \
    'real_ip_recursive on;'; do
    [[ "$(grep -Fxc -- "${required_line}" "${live_nginx_config}")" == '1' ]] || \
      fail "live Nginx real-IP contract is missing or duplicates: ${required_line}"
  done
}

check_compose_release_topology() {
  local compose_json=$1

  jq -e '
    def is_port($target; $published):
      .host_ip == "127.0.0.1"
      and .target == $target
      and .published == $published
      and .protocol == "tcp"
      and .mode == "ingress";
    (.services.web.ports // []) as $ports
    | ($ports | length) == 2
      and any($ports[]; is_port(8080; "8080"))
      and any($ports[]; is_port(8443; "8443"))
      and ([.services | to_entries[] | select(.key != "web") | .value.ports[]?] | length == 0)
      and ([.services | to_entries[] | select((.value.network_mode // "") != "")] | length == 0)
      and (.name == "cometa-bank")
      and ((.services | keys | sort) == ["bot", "certbot", "web"])
      and ((.services.web.networks | keys | sort) == ["edge", "public"])
      and ((.services.bot.networks | keys | sort) == ["edge", "egress"])
      and ((.services.certbot.networks | keys | sort) == ["egress"])
      and ((.networks | keys | sort) == ["edge", "egress", "public"])
      and (.networks.edge.name == "cometa-bank_edge")
      and (.networks.egress.name == "cometa-bank_egress")
      and (.networks.public.name == "cometa-bank_public")
      and all(.networks[];
        .driver == "bridge"
        and ((.external // false) == false)
        and ((.attachable // false) == false)
        and (if has("enable_ipv4") then .enable_ipv4 == true else true end)
        and (if has("enable_ipv6") then .enable_ipv6 == false else true end)
        and ((.ipam // {}) == {}))
      and (.networks.edge.internal == true)
      and ((.networks.egress.internal // false) == false)
      and ((.networks.public.internal // false) == false)
      and (.networks.edge.driver_opts == {"com.docker.network.bridge.enable_icc":"true"})
      and (.networks.egress.driver_opts == {"com.docker.network.bridge.enable_icc":"false"})
      and (.networks.public.driver_opts == {"com.docker.network.bridge.enable_icc":"false"})
  ' <<<"${compose_json}" >/dev/null || \
    fail 'release Compose does not preserve the exact service, port, and bridge-network topology'
}

check_running_service_port_bindings() {
  local service container_output container_count container_id bindings_json

  for service in web bot; do
    container_output="$(
      docker ps \
        --filter 'label=com.docker.compose.project=cometa-bank' \
        --filter "label=com.docker.compose.service=${service}" \
        --format '{{.ID}}'
    )" || fail "could not enumerate running cometa-bank ${service} containers"
    [[ -n "${container_output}" ]] || \
      fail "no running cometa-bank ${service} container was found"
    container_count="$(awk 'NF { count += 1 } END { print count + 0 }' \
      <<<"${container_output}")" || \
      fail "could not count running cometa-bank ${service} containers"
    [[ "${container_count}" =~ ^[0-9]+$ ]] || \
      fail "running cometa-bank ${service} container count is invalid"
    [[ "${container_count}" == '1' ]] || \
      fail "expected exactly one running cometa-bank ${service} container"
    container_id="$(awk 'NF { print; exit }' <<<"${container_output}")"
    [[ "${container_id}" =~ ^[a-f0-9]{12,64}$ ]] || \
      fail "running cometa-bank ${service} container has an invalid ID"
    bindings_json="$(docker inspect --format '{{json .HostConfig.PortBindings}}' \
      "${container_id}")" || \
      fail "could not inspect running cometa-bank ${service} port bindings"
    case "${service}" in
      web)
        jq -e '
          (keys | sort) == ["8080/tcp", "8443/tcp"]
          and .["8080/tcp"] == [{"HostIp":"127.0.0.1","HostPort":"8080"}]
          and .["8443/tcp"] == [{"HostIp":"127.0.0.1","HostPort":"8443"}]
        ' <<<"${bindings_json}" >/dev/null || \
          fail 'running web container does not use the exact loopback-only port bindings'
        ;;
      bot)
        jq -e '(. // {}) | type == "object" and length == 0' \
          <<<"${bindings_json}" >/dev/null || \
          fail 'running bot container must not publish a host port'
        ;;
      *) return 1 ;;
    esac
  done
}

check_docker_network_contract() {
  local network_name=$1
  local logical_name=$2
  local internal=$3
  local expected_icc=$4
  local network_names network_count network_json

  [[ "${network_name}" == "${compose_project}_${logical_name}" ]] || \
    fail "unexpected Docker network name: ${network_name}"
  [[ "${logical_name}" == 'edge' || "${logical_name}" == 'egress' || \
    "${logical_name}" == 'public' ]] || fail "unexpected logical Docker network: ${logical_name}"
  [[ "${internal}" == true || "${internal}" == false ]] || return 1
  [[ "${expected_icc}" == true || "${expected_icc}" == false ]] || return 1
  network_names="$(docker network ls --format '{{.Name}}')" || \
    fail 'could not enumerate Docker networks'
  network_count="$(awk -v expected="${network_name}" \
    '$0 == expected { count += 1 } END { print count + 0 }' <<<"${network_names}")"
  [[ "${network_count}" == '1' ]] || \
    fail "expected exactly one Docker network named ${network_name}; found ${network_count}"
  network_json="$(docker network inspect --format '{{json .}}' "${network_name}")" || \
    fail "could not inspect Docker network ${network_name}"
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
    ' <<<"${network_json}" >/dev/null || \
    fail "Docker network ${network_name} does not match the isolated bridge topology"
}

check_running_service_network_topology() {
  local service container_output container_count container_id network_mode networks_json

  check_docker_network_contract 'cometa-bank_edge' 'edge' true true
  check_docker_network_contract 'cometa-bank_egress' 'egress' false false
  check_docker_network_contract 'cometa-bank_public' 'public' false false

  for service in web bot; do
    container_output="$(
      docker ps \
        --filter 'label=com.docker.compose.project=cometa-bank' \
        --filter "label=com.docker.compose.service=${service}" \
        --format '{{.ID}}'
    )" || fail "could not enumerate running cometa-bank ${service} containers"
    [[ -n "${container_output}" ]] || fail "no running cometa-bank ${service} container was found"
    container_count="$(awk 'NF { count += 1 } END { print count + 0 }' \
      <<<"${container_output}")" || \
      fail "could not count running cometa-bank ${service} containers"
    [[ "${container_count}" =~ ^[0-9]+$ ]] || \
      fail "running cometa-bank ${service} container count is invalid"
    [[ "${container_count}" == '1' ]] || \
      fail "expected exactly one running cometa-bank ${service} container"
    container_id="$(awk 'NF { print; exit }' <<<"${container_output}")"
    [[ "${container_id}" =~ ^[a-f0-9]{12,64}$ ]] || \
      fail "running cometa-bank ${service} container has an invalid ID"
    network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "${container_id}")" || \
      fail "could not inspect running cometa-bank ${service} network mode"
    [[ -n "${network_mode}" && "${network_mode}" != 'host' && \
      "${network_mode}" != container:* ]] || \
      fail "running cometa-bank ${service} must use an isolated Docker network namespace"
    networks_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "${container_id}")" || \
      fail "could not inspect running cometa-bank ${service} network attachments"
    case "${service}" in
      web)
        jq -e '(keys | sort) == ["cometa-bank_edge", "cometa-bank_public"]' \
          <<<"${networks_json}" >/dev/null || \
          fail 'running web container has an unexpected Docker network attachment'
        ;;
      bot)
        jq -e '(keys | sort) == ["cometa-bank_edge", "cometa-bank_egress"]' \
          <<<"${networks_json}" >/dev/null || \
          fail 'running bot container has an unexpected Docker network attachment'
        ;;
      *) return 1 ;;
    esac
    jq -e --arg network_mode "${network_mode}" 'has($network_mode)' \
      <<<"${networks_json}" >/dev/null || \
      fail "running cometa-bank ${service} primary network mode is not an attached network"
  done
}

check_served_inner_tls() {
  local hostname leaf_certificate

  for hostname in "${domain}" "${www_domain}"; do
    leaf_certificate="$(
      timeout --signal=TERM --kill-after=2s "${inner_tls_timeout_seconds}s" \
        openssl s_client \
          -connect "${inner_tls_endpoint}" \
          -servername "${hostname}" \
          -showcerts \
          -verify 5 \
          -verify_return_error \
          -verify_hostname "${hostname}" \
          -CApath /etc/ssl/certs </dev/null 2>/dev/null \
        | openssl x509 -outform PEM 2>/dev/null
    )" || fail "inner TLS handshake or leaf extraction failed for ${hostname}"
    [[ "${leaf_certificate}" == *'-----BEGIN CERTIFICATE-----'* && \
      "${leaf_certificate}" == *'-----END CERTIFICATE-----'* ]] || \
      fail "inner TLS endpoint returned no leaf certificate for ${hostname}"
    openssl x509 -noout -checkend "${minimum_certificate_validity_seconds}" \
      <<<"${leaf_certificate}" >/dev/null || \
      fail "inner TLS certificate for ${hostname} expires in less than 21 days"
  done
}

check_caddy_config() {
  local adapted_config

  systemctl is-enabled --quiet caddy.service || fail 'caddy.service is not enabled'
  systemctl is-active --quiet caddy.service || fail 'caddy.service is not active'
  [[ -r "${caddy_config}" ]] || fail "Caddy config is unreadable: ${caddy_config}"
  caddy validate --config "${caddy_config}" --adapter caddyfile >/dev/null || \
    fail 'the active Caddyfile is invalid'
  adapted_config="$(caddy adapt --config "${caddy_config}" --adapter caddyfile)" || \
    fail 'could not adapt the active Caddyfile'
  jq -e --arg admin_listen "${caddy_admin_listen}" '
    def routes_for($hostname):
      [.apps.http.servers[]?.routes[]?
        | select(any(.match[]?.host[]?; . == $hostname))];
    def proxies_for($route):
      [$route | .. | objects | select(.handler? == "reverse_proxy")];
    def no_hsts($route):
      ([$route | .. | objects | to_entries[]
        | select((.key | ascii_downcase) == "strict-transport-security")] | length) == 0;
    def expected_route($hostname):
      routes_for($hostname) as $routes
      | ($routes | length) == 1
        and (proxies_for($routes[0]) as $proxies
          | ($proxies | length) == 1
            and ($proxies[0].upstreams == [{"dial":"127.0.0.1:8443"}])
            and ($proxies[0].headers.request.set.Host == ["{http.request.host}"])
            and ($proxies[0].transport.protocol == "http")
            and ($proxies[0].transport.tls.server_name == $hostname)
            and (($proxies[0].transport.tls.insecure_skip_verify // false) == false)
            and no_hsts($routes[0]));
    expected_route("euphoria.bot")
      and expected_route("www.euphoria.bot")
      and ([.apps.http.servers[]?] as $servers
        | ($servers | length) > 0
          and all($servers[]; .protocols == ["h1", "h2"])
          and .admin.listen == $admin_listen
          and .admin.config.persist == false)
  ' <<<"${adapted_config}" >/dev/null || \
    fail 'Caddy must preserve both euphoria Hosts on the loopback HTTPS upstream without HSTS'
}

check_caddy_admin_socket() {
  local path metadata owner group mode pid confirmed_pid listeners matching count line
  local tcp_admin_listeners expected_config live_config
  for path in \
    /var/lib/caddy \
    /var/lib/caddy/.local \
    /var/lib/caddy/.local/share \
    /var/lib/caddy/.local/share/caddy; do
    [[ -d "${path}" && ! -L "${path}" ]] || fail "unsafe Caddy admin parent: ${path}"
    metadata="$(stat -c '%U:%G:%a' -- "${path}")" || fail "cannot inspect ${path}"
    IFS=: read -r owner group mode <<<"${metadata}"
    [[ "${owner}" == caddy && "${group}" == caddy && "${mode}" =~ ^[0-7]{3,4}$ ]] || \
      fail "Caddy admin parent has an unexpected owner: ${path}"
    (( (8#${mode} & 022) == 0 )) || fail "Caddy admin parent is writable by another account: ${path}"
  done
  [[ -S "${caddy_admin_socket}" && ! -L "${caddy_admin_socket}" ]] || \
    fail 'permissioned Caddy admin Unix socket is missing or symlinked'
  [[ "$(stat -c '%U:%G:%a' -- "${caddy_admin_socket}")" == 'caddy:caddy:200' ]] || \
    fail 'Caddy admin Unix socket must be caddy-owned with mode 0200'
  pid="$(caddy_service_pid)" || fail 'cannot resolve caddy.service PID'
  listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s ss -H -lxnp)" || \
    fail 'cannot inspect Caddy Unix listeners'
  matching="$(awk -v expected="${caddy_admin_socket}" '
    $1 == "u_str" && $2 == "LISTEN" {
      for (field = 1; field <= NF; field += 1) if ($field == expected) print
    }
  ' <<<"${listeners}")" || fail 'cannot parse Caddy Unix listeners'
  count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"${matching}")" || \
    fail 'cannot count Caddy Unix listeners'
  [[ "${count}" == '1' ]] || fail 'expected exactly one Caddy admin Unix listener'
  line="$(awk 'NF { print; exit }' <<<"${matching}")"
  validate_caddy_listener_owner "${line}" "${pid}" || \
    fail 'Caddy admin Unix listener is not owned exclusively by caddy.service'
  tcp_admin_listeners="$(timeout --foreground --signal=TERM --kill-after=2s 8s \
    ss -H -ltnp 'sport = :2019')" || \
    fail 'cannot inspect the legacy Caddy TCP admin listener'
  [[ -z "${tcp_admin_listeners}" ]] || fail 'legacy Caddy TCP admin listener is open'
  confirmed_pid="$(caddy_service_pid)" || \
    fail 'cannot recheck caddy.service PID after admin listener enumeration'
  [[ "${confirmed_pid}" == "${pid}" ]] || \
    fail 'caddy.service changed while its admin listener was being inspected'
  expected_config="$(caddy adapt --config "${caddy_config}" --adapter caddyfile | \
    jq -cS .)" || fail 'cannot canonicalize the installed Caddy config'
  live_config="$(curl --disable --fail --silent --show-error --noproxy '*' \
      --connect-timeout 5 --max-time 10 --unix-socket "${caddy_admin_socket}" \
      'http://localhost/config/' | jq -cS .)" || \
    fail 'cannot read the live Caddy config through its permissioned socket'
  [[ "${expected_config}" == "${live_config}" ]] || \
    fail 'live Caddy config differs from the installed Caddyfile'
}

check_legacy_renewal_unit() {
  local unit=$1
  local allow_static=$2
  local enabled_state active_state

  enabled_state="$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
  case "${enabled_state}" in
    disabled|masked) ;;
    static)
      [[ "${allow_static}" == true ]] || \
        fail "legacy renewal timer is not explicitly disabled: ${unit} (${enabled_state})"
      ;;
    *) fail "legacy renewal unit can still start automatically: ${unit} (${enabled_state})" ;;
  esac
  active_state="$(systemctl is-active "${unit}" 2>/dev/null || true)"
  [[ "${active_state}" == 'inactive' ]] || \
    fail "legacy renewal unit is not inactive: ${unit} (${active_state})"
}

while (( $# > 0 )); do
  case "$1" in
    --ssh-port)
      (( $# >= 2 )) || fail '--ssh-port requires a value'
      expected_ssh_port=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

(( EUID == 0 )) || fail 'run this preflight through sudo'
[[ "${expected_ssh_port}" =~ ^[0-9]{1,5}$ ]] || fail '--ssh-port is required and must be numeric'
(( expected_ssh_port >= 1 && expected_ssh_port <= 65535 )) || fail 'invalid SSH port'
[[ "${deploy_root}" == /* && "${deploy_root}" != '/' && "${deploy_root}" != *'..'* ]] || \
  fail 'COMETA_DEPLOY_ROOT must be a narrow absolute path without ..'

for command_name in awk caddy curl date docker dockerd env getent jq openssl sha256sum sshd ss stat systemctl timeout tr ufw; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command not found: ${command_name}"
done

assert_docker_cli_local_contract
assert_no_pending_docker_perimeter_recovery
docker_engine_version="$(docker version --format '{{.Server.Version}}')" || \
  fail 'Docker daemon is unavailable'
docker_compose_version="$(docker compose version --short)" || \
  fail 'Docker Compose plugin is unavailable'
version_at_least "${docker_engine_version}" "${minimum_docker_version}" || \
  fail "Docker Engine ${minimum_docker_version} or newer is required; found ${docker_engine_version}"
version_at_least "${docker_compose_version}" "${minimum_compose_version}" || \
  fail "Docker Compose ${minimum_compose_version} or newer is required; found ${docker_compose_version}"
check_docker_daemon_perimeter_contract

[[ -f "${compose_file}" ]] || fail "release compose file not found: ${compose_file}"
compose_json="$(
  COMETA_RELEASE_ID='host-preflight' COMETA_DEPLOY_ROOT="${deploy_root}" \
    docker compose -f "${compose_file}" --profile tools config --format json
)" || fail "Docker Compose cannot render the extracted release: ${compose_file}"
check_compose_release_topology "${compose_json}"

if grep -ERiq '^[[:space:]]*Match[[:space:]]' \
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d; then
  fail 'SSH Match blocks require an explicit per-user/address security review'
fi
ssh_user="${SUDO_USER:-root}"
[[ "${ssh_user}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'cannot determine a safe SSH user context'
sshd_config="$(sshd -T -C "user=${ssh_user},addr=127.0.0.1,host=$(hostname)")"
grep -Eq '^pubkeyauthentication yes$' <<<"${sshd_config}" || fail 'SSH public-key auth is disabled'
grep -Eq '^passwordauthentication no$' <<<"${sshd_config}" || fail 'disable SSH password authentication first'
grep -Eq '^kbdinteractiveauthentication no$' <<<"${sshd_config}" || \
  fail 'disable SSH keyboard-interactive authentication first'
grep -Eq '^permitrootlogin (no|prohibit-password|without-password)$' <<<"${sshd_config}" || \
  fail 'root SSH login still permits passwords'

ufw_status="$(ufw status verbose)"
grep -Fq 'Status: active' <<<"${ufw_status}" || fail 'UFW is inactive'
grep -Eq 'Default: deny \(incoming\), allow \(outgoing\)' <<<"${ufw_status}" || \
  fail 'UFW does not use default-deny incoming policy'
ufw_numbered_status="$(ufw status numbered)"
check_ufw_allowlist "${ufw_numbered_status}"

check_caddy_config
check_caddy_admin_socket
check_running_service_port_bindings
check_running_service_network_topology
check_served_inner_tls
check_nginx_real_ip_contract
check_legacy_renewal_unit "${legacy_renewal_timer}" false
check_legacy_renewal_unit "${legacy_renewal_service}" true
check_tcp_listeners
check_udp_listeners

printf '%s\n' \
  'Host preflight passed:' \
  "- Docker Engine ${docker_engine_version} and Compose ${docker_compose_version} meet minimum versions" \
  '- the effective Docker daemon keeps direct routing off and iptables management on' \
  '- the release and running services use the exact isolated public/edge/egress bridge topology' \
  '- the served inner TLS certificate is trusted, hostname-valid, and valid for at least 21 days' \
  '- enabled and active Caddy owns public TCP 80/443 with verified upstream TLS and no UDP listener' \
  '- the live Nginx config restores trusted client IPs before rate limiting' \
  '- the legacy Certbot renewal timer and service are inactive and cannot auto-start' \
  '- SSH is key-only' \
  '- UFW has only the expected inbound allow rules' \
  '- no unexpected non-loopback TCP listener was found'
