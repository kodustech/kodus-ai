# Shared env + helpers for the gitlab-dev scripts. Source from each
# entry point — never run directly.
#
# Resolves the admin PAT lazily, caches it under .tmp/, and exposes
# `api` / `api_status` curl wrappers so the per-step scripts can stay
# focused on the work they're doing.

# Re-sourcing this file in a script that already sourced it is a no-op
# guarded by GITLAB_DEV_COMMON_LOADED so we don't double-define helpers.
if [ -n "${GITLAB_DEV_COMMON_LOADED:-}" ]; then return 0; fi
GITLAB_DEV_COMMON_LOADED=1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${REPO_ROOT}/docker/gitlab-dev/docker-compose.yml"

# All paths the scripts read from / write to. Centralised so we don't
# drift between steps.
TMP_DIR="${REPO_ROOT}/.tmp"
ADMIN_PAT_FILE="${TMP_DIR}/gitlab-dev-admin-pat.txt"
USER_PAT_FILE="${TMP_DIR}/gitlab-dev-pat.txt"
PROJECT_URL_FILE="${TMP_DIR}/gitlab-dev-project-url.txt"
PROJECT_ID_FILE="${TMP_DIR}/gitlab-dev-project-id.txt"
MR_URL_FILE="${TMP_DIR}/gitlab-dev-mr-url.txt"

# Tunables — all overridable from the environment.
GITLAB_URL="${GITLAB_URL:-http://gitlab.lvh.me:8929}"
GITLAB_CONTAINER="${GITLAB_CONTAINER:-kodus-gitlab-dev}"
USER_NAME="${USER_NAME:-kodus-dev}"
USER_EMAIL="${USER_EMAIL:-kodus-dev@kodus.test}"
# GitLab's user-create API runs the password through a "common
# password" deny-list (root is exempt because its password is set at
# omnibus install time, not via the API). Anything looking like
# "WordYear!" — including "KodusDev!2026" — gets rejected with
# "must not contain commonly used combinations of words and letters".
# Keep this string opaque so the API accepts it; the user PAT is what
# actually authenticates Kodus, this password is only for web login.
USER_PASSWORD="${USER_PASSWORD:-Pq7nVe_4xK-2zLm-9Wb-Tf3aR-Mfh8}"
GROUP_PATH="${GROUP_PATH:-kodus-playground}"
PROJECT_NAME="${PROJECT_NAME:-discount-service}"
PROJECT_PATH="${GROUP_PATH}/${PROJECT_NAME}"
FEATURE_BRANCH="${FEATURE_BRANCH:-feat/discount-codes}"

mkdir -p "${TMP_DIR}"

# ─── helpers ─────────────────────────────────────────────────────────

jq_field() {
    # Read JSON from stdin, print the field at the given Python index
    # expression (e.g. "['id']" or "[0]['web_url']"). Picked over jq
    # because python3 is already in the SSO E2E baseline and avoids one
    # more host dependency.
    python3 -c "import json,sys; print(json.load(sys.stdin)$1)"
}

urlencode() {
    python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}

require_container_running() {
    if ! docker ps --format '{{.Names}}' | grep -q "^${GITLAB_CONTAINER}$"; then
        cat >&2 <<EOF
error: container "${GITLAB_CONTAINER}" is not running.

Start GitLab first:
    bash scripts/gitlab-dev/start.sh
EOF
        exit 1
    fi
}

# ─── admin PAT ───────────────────────────────────────────────────────
# `acquire_admin_pat` sets ADMIN_PAT in the calling shell and ensures
# the `api` / `api_status` helpers below work.
#
# Strategy:
#   1. If .tmp/gitlab-dev-admin-pat.txt exists and still works against
#      GET /user, reuse it. This keeps re-runs cheap and avoids
#      revoking a working token only to mint a new one.
#   2. Otherwise mint a fresh PAT via `gitlab-rails runner` inside the
#      container. We use the runner (not the OAuth password grant)
#      because (a) GitLab is locking that grant down in 16.x and (b)
#      it can't issue the `admin_mode` scope we need for user/group
#      admin endpoints.
acquire_admin_pat() {
    require_container_running

    if [ -f "${ADMIN_PAT_FILE}" ]; then
        local cached
        cached="$(cat "${ADMIN_PAT_FILE}")"
        local status
        status=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "PRIVATE-TOKEN: ${cached}" \
            "${GITLAB_URL}/api/v4/user" || true)
        if [ "${status}" = "200" ]; then
            ADMIN_PAT="${cached}"
            return 0
        fi
        echo "    cached admin PAT is no longer valid (status=${status}); re-minting"
    fi

    # The `admin_mode` scope was added in GitLab 17.5. Older versions
    # validate the scope list against a hardcoded allow-list and raise
    # ActiveRecord::RecordInvalid if they see an unknown name. Try the
    # new scope first (for >= 17.5 where admin operations now require
    # it) and gracefully retry without on older instances.
    ADMIN_PAT=$(docker exec -i "${GITLAB_CONTAINER}" gitlab-rails runner - <<'RUBY' 2>/dev/null | tail -n 1
u = User.find_by_username('root')
u.personal_access_tokens.where(name: 'kodus-bootstrap-admin').find_each(&:revoke!)
attrs = { name: 'kodus-bootstrap-admin', expires_at: 365.days.from_now }
begin
  t = u.personal_access_tokens.create!(
    attrs.merge(scopes: %w[api sudo admin_mode read_repository write_repository]),
  )
rescue ActiveRecord::RecordInvalid
  t = u.personal_access_tokens.create!(
    attrs.merge(scopes: %w[api sudo read_repository write_repository]),
  )
end
puts t.token
RUBY
)

    if [ -z "${ADMIN_PAT}" ]; then
        echo "error: gitlab-rails runner did not return an admin PAT." >&2
        echo "       Tail container logs: docker logs ${GITLAB_CONTAINER}" >&2
        exit 1
    fi

    echo "${ADMIN_PAT}" > "${ADMIN_PAT_FILE}"
    chmod 600 "${ADMIN_PAT_FILE}"
}

# REST helpers. They lazy-acquire ADMIN_PAT on first use so individual
# scripts don't have to remember to call acquire_admin_pat themselves.
api() {
    : "${ADMIN_PAT:?ADMIN_PAT not set — call acquire_admin_pat first}"
    curl -sf -H "PRIVATE-TOKEN: ${ADMIN_PAT}" \
        -H "Content-Type: application/json" "$@"
}

api_status() {
    : "${ADMIN_PAT:?ADMIN_PAT not set — call acquire_admin_pat first}"
    curl -s -o /dev/null -w "%{http_code}" \
        -H "PRIVATE-TOKEN: ${ADMIN_PAT}" "$@"
}

# b64 encode stdin → stdout. Used to ship file contents through the
# commits API without escape-hell.
b64() {
    python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.buffer.read()).decode())"
}
