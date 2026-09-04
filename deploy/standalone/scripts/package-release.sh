#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly script_directory
project_root="$(cd -- "${script_directory}/../../.." && pwd -P)"
readonly project_root

release_id="$(date -u +'%Y%m%dT%H%M%SZ')"
output_directory='/private/tmp'
archive_path=''
checksum_path=''
archive_listing_path=''
archive_payload_path=''
package_complete=false

cleanup() {
  [[ -z "${archive_listing_path}" ]] || rm -f -- "${archive_listing_path}"
  [[ -z "${archive_payload_path}" ]] || rm -f -- "${archive_payload_path}"
  if [[ "${package_complete}" != true ]]; then
    [[ -z "${archive_path}" ]] || rm -f -- "${archive_path}"
    [[ -z "${checksum_path}" ]] || rm -f -- "${checksum_path}"
  fi
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'Usage: package-release.sh [--release-id YYYYMMDDTHHMMSSZ] [--output DIR] [--self-check]' \
    '' \
    'Creates a credential-free source archive and a matching SHA-256 file.' \
    'Use --self-check to validate the archive guards without creating a package.'
}

readonly forbidden_archive_name_pattern='(^|/)(\._[^/]*|\.DS_Store|\.env[^/]*|\.npmrc|\.yarnrc[^/]*|\.pypirc|\.netrc|\.pgpass|\.my\.cnf|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]+\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ovpn)|[^/]+\.tfstate(\.backup)?|kubeconfig|[^/]+\.kubeconfig|\.?htpasswd|credentials(\.json)?|application_default_credentials\.json|service[-_]?account[^/]*\.json|secrets?\.json|auth\.json)$|(^|/)\.docker/config\.json$'
readonly credential_content_pattern='([0-9]{6,20}:[A-Za-z0-9_-]{30,}|-----BEGIN[[:space:]]+((OPENSSH|RSA|DSA|EC|ENCRYPTED)[[:space:]]+)?PRIVATE[[:space:]]+KEY-----|A(KIA|SIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255}|npm_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,255}|(sk|rk)_(live|test)_[A-Za-z0-9]{16,255}|sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,255}|AIza[0-9A-Za-z_-]{35}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|dop_v1_[a-f0-9]{64}|SK[0-9a-fA-F]{32})'

archive_name_is_forbidden() {
  LC_ALL=C grep -Eiq "${forbidden_archive_name_pattern}" <<<"$1"
}

archive_entry_is_allowed() {
  local entry=$1

  while [[ "${entry}" == ./* ]]; do
    entry=${entry#./}
  done
  entry=${entry%/}

  case "${entry}" in
    .dockerignore|package.json|pnpm-lock.yaml|tsconfig.json|tsconfig.app.json|\
      tsconfig.bot.json|tsconfig.node.json|vite.config.ts|index.html|\
      bot|bot/*|deploy|deploy/*|public|public/*|scripts|scripts/*|src|src/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

verify_archive_listing() {
  local entry=''

  test -s "${archive_listing_path}" || fail 'release archive has an empty listing'
  while IFS= read -r entry || [[ -n "${entry}" ]]; do
    [[ -n "${entry}" ]] || fail 'release archive contains an empty member name'
    [[ "${entry}" != /* ]] || fail 'release archive contains an absolute member path'
    [[ "${entry}" != *$'\r'* && "${entry}" != *$'\t'* && "${entry}" != *'\'* ]] || \
      fail 'release archive contains an ambiguous member path'
    [[ "/${entry}/" != *'/../'* ]] || \
      fail 'release archive contains a parent-directory traversal'
    archive_entry_is_allowed "${entry}" || \
      fail 'release archive contains a member outside the source allowlist'
    if archive_name_is_forbidden "${entry}"; then
      fail 'release archive contains a credential-like filename'
    fi
  done <"${archive_listing_path}"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_archive_payload() {
  local entry=''
  local scan_status=0

  while IFS= read -r entry || [[ -n "${entry}" ]]; do
    [[ "${entry}" == */ ]] && continue

    : >"${archive_payload_path}"
    tar -xOzf "${archive_path}" "${entry}" >"${archive_payload_path}" || \
      fail 'could not read a release archive member payload'

    if rg --text --pcre2 --quiet \
      "${credential_content_pattern}" "${archive_payload_path}"; then
      fail 'release archive contains credential-like content'
    else
      scan_status=$?
      (( scan_status == 1 )) || fail 'credential content scanner failed'
    fi
  done <"${archive_listing_path}"
}

self_check_archive_guards() {
  local sample=''
  local token_sample=''
  local key_label='KEY'
  local private_key_sample=''
  local -a forbidden_samples=(
    '.env'
    'config/.env.production'
    '.npmrc'
    '.yarnrc.yml'
    '.ssh/id_ed25519'
    'certificates/client.p12'
    '.docker/config.json'
    'cluster.kubeconfig'
    'terraform.tfstate.backup'
  )
  local -a allowed_samples=(
    'deploy/bot/install-secret.sh'
    'src/platform/environment.ts'
    'public/certificates/root.crt'
    'deploy/standalone/README.md'
  )

  for sample in "${forbidden_samples[@]}"; do
    archive_name_is_forbidden "${sample}" || \
      fail 'internal archive filename guard self-check failed'
  done
  for sample in "${allowed_samples[@]}"; do
    if archive_name_is_forbidden "${sample}"; then
      fail 'internal archive filename false-positive self-check failed'
    fi
  done

  archive_entry_is_allowed 'src/main.tsx' || \
    fail 'internal archive allowlist self-check failed'
  if archive_entry_is_allowed '../outside'; then
    fail 'internal archive allowlist rejection self-check failed'
  fi

  token_sample="$(printf '1%.0s' {1..6}):$(printf 'A%.0s' {1..30})"
  private_key_sample="-----BEGIN OPENSSH PRIVATE ${key_label}-----"
  rg --text --pcre2 --quiet "${credential_content_pattern}" <<<"${token_sample}" || \
    fail 'internal token content guard self-check failed'
  rg --text --pcre2 --quiet "${credential_content_pattern}" <<<"${private_key_sample}" || \
    fail 'internal private-key content guard self-check failed'
  if rg --text --pcre2 --quiet "${credential_content_pattern}" \
    <<<'BOT_TOKEN is read from a root-owned runtime file'; then
    fail 'internal content guard false-positive self-check failed'
  fi
}

self_check_only=false

while (( $# > 0 )); do
  case "$1" in
    --release-id)
      (( $# >= 2 )) || fail '--release-id requires a value'
      release_id=$2
      shift 2
      ;;
    --output)
      (( $# >= 2 )) || fail '--output requires a value'
      output_directory=$2
      shift 2
      ;;
    --self-check)
      self_check_only=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || \
  fail 'release ID must use UTC format YYYYMMDDTHHMMSSZ'
[[ "${output_directory}" == /* ]] || fail '--output must be an absolute path'
test -d "${output_directory}" || fail "output directory does not exist: ${output_directory}"

for command_name in awk date find grep mktemp pnpm rg rm tar; do
  command -v "${command_name}" >/dev/null 2>&1 || \
    fail "required command not found: ${command_name}"
done
if ! command -v sha256sum >/dev/null 2>&1 && \
  ! command -v shasum >/dev/null 2>&1; then
  fail 'sha256sum or shasum is required'
fi

self_check_archive_guards
if [[ "${self_check_only}" == true ]]; then
  printf '%s\n' 'Archive guards: OK'
  exit 0
fi

archive_path="${output_directory}/cometa-bank-${release_id}.tgz"
checksum_path="${archive_path}.sha256"
test ! -e "${archive_path}" || fail "archive already exists: ${archive_path}"
test ! -e "${checksum_path}" || fail "checksum already exists: ${checksum_path}"

declare -a release_inputs=(
  .dockerignore
  package.json
  pnpm-lock.yaml
  tsconfig.json
  tsconfig.app.json
  tsconfig.bot.json
  tsconfig.node.json
  vite.config.ts
  index.html
  bot
  deploy
  public
  scripts
  src
)
declare -a source_inputs=()
for release_input in "${release_inputs[@]}"; do
  test -e "${project_root}/${release_input}" || \
    fail "required release input does not exist: ${release_input}"
  source_inputs+=("${project_root}/${release_input}")
done

symlink_path="$(find "${source_inputs[@]}" -type l -print -quit)"
[[ -z "${symlink_path}" ]] || \
  fail 'release inputs contain a symlink'

unsafe_input_path=false
while IFS= read -r -d '' source_path; do
  if [[ "${source_path}" == *$'\n'* || "${source_path}" == *$'\r'* || \
    "${source_path}" == *$'\t'* || "${source_path}" == *'\'* ]]; then
    unsafe_input_path=true
    break
  fi
done < <(find "${source_inputs[@]}" -print0)
[[ "${unsafe_input_path}" == false ]] || \
  fail 'release inputs contain an ambiguous path'

(cd -- "${project_root}" && pnpm verify)

umask 077
COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --exclude='._*' \
  --exclude='*/._*' \
  --exclude='.DS_Store' \
  --exclude='*/.DS_Store' \
  --exclude='bot/dist' \
  --exclude='dist' \
  --exclude='node_modules' \
  --exclude='deploy/bot/.env.example' \
  -czf "${archive_path}" \
  -C "${project_root}" \
  "${release_inputs[@]}"

archive_listing_path="$(mktemp "${TMPDIR:-/tmp}/cometa-bank-listing.XXXXXX")" || \
  fail 'could not create archive listing scratch file'
archive_payload_path="$(mktemp "${TMPDIR:-/tmp}/cometa-bank-payload.XXXXXX")" || \
  fail 'could not create archive payload scratch file'

tar -tzf "${archive_path}" >"${archive_listing_path}" || \
  fail 'could not read the release archive listing'
verify_archive_listing

# `-O` writes member data only to our private scratch file. The member path was
# already validated, and tar never creates a filesystem path during this scan.
verify_archive_payload

archive_hash="$(sha256_file "${archive_path}")"
printf '%s  %s\n' "${archive_hash}" "$(basename -- "${archive_path}")" >"${checksum_path}"

package_complete=true
printf 'Release archive: %s\nSHA-256: %s\n' "${archive_path}" "${archive_hash}"
