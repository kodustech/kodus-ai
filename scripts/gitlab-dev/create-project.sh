#!/usr/bin/env bash
# Step 2 of 3 — provision the test user, group, and seed project on the
# running GitLab instance. Mints a personal access token for the test
# user and (optionally) registers a project webhook so events flow to
# wherever Kodus is reachable from outside the docker network.
#
# Idempotent — re-running just refreshes the user PAT and (if WEBHOOK_URL
# changed) replaces the webhook.
#
# Env knobs:
#   WEBHOOK_URL   if set, a Merge Request + Note webhook will be added
#                 to the project pointing at this URL. Use whatever URL
#                 your Kodus API is reachable at from inside the GitLab
#                 container — e.g. your existing zrok/ngrok URL, or
#                 http://kodus-api:3001/gitlab/webhook for the docker
#                 dev stack. Skipping this leaves the project without
#                 a webhook; Kodus will register one itself when you
#                 connect the integration through the UI.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

echo "════════════════════════════════════════════════════════════════"
echo " gitlab-dev — create-project"
echo "════════════════════════════════════════════════════════════════"

echo
echo "==> resolving admin PAT"
acquire_admin_pat

# ─── user ────────────────────────────────────────────────────────────
echo
echo "==> ensuring user ${USER_NAME}"
USER_ID=$(api "${GITLAB_URL}/api/v4/users?username=${USER_NAME}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '', end='')")

if [ -z "${USER_ID}" ]; then
    USER_ID=$(api -X POST "${GITLAB_URL}/api/v4/users" -d "$(cat <<EOF
{
    "email": "${USER_EMAIL}",
    "username": "${USER_NAME}",
    "name": "Kodus Dev",
    "password": "${USER_PASSWORD}",
    "skip_confirmation": true
}
EOF
)" | jq_field "['id']")
    echo "    created (id=${USER_ID})"
else
    echo "    already exists (id=${USER_ID})"
fi

# ─── group ───────────────────────────────────────────────────────────
echo
echo "==> ensuring group ${GROUP_PATH}"
GROUP_ID=$(api "${GITLAB_URL}/api/v4/groups?search=${GROUP_PATH}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); m=[g for g in d if g['path']=='${GROUP_PATH}']; print(m[0]['id'] if m else '', end='')")

if [ -z "${GROUP_ID}" ]; then
    GROUP_ID=$(api -X POST "${GITLAB_URL}/api/v4/groups" -d "$(cat <<EOF
{
    "name": "Kodus Playground",
    "path": "${GROUP_PATH}",
    "visibility": "private"
}
EOF
)" | jq_field "['id']")
    echo "    created (id=${GROUP_ID})"
else
    echo "    already exists (id=${GROUP_ID})"
fi

# Add the test user as a Maintainer (access_level 40) so the PAT can
# push branches and open MRs. Idempotent: GitLab returns 409 if the
# membership already exists.
api -X POST "${GITLAB_URL}/api/v4/groups/${GROUP_ID}/members" \
    -d "{\"user_id\":${USER_ID},\"access_level\":40}" >/dev/null 2>&1 || true

# ─── project ─────────────────────────────────────────────────────────
echo
echo "==> ensuring project ${PROJECT_PATH}"
PROJECT_PATH_ENCODED="$(urlencode "${PROJECT_PATH}")"
PROJECT_STATUS=$(api_status "${GITLAB_URL}/api/v4/projects/${PROJECT_PATH_ENCODED}")

if [ "${PROJECT_STATUS}" = "404" ]; then
    PROJECT_ID=$(api -X POST "${GITLAB_URL}/api/v4/projects" -d "$(cat <<EOF
{
    "name": "${PROJECT_NAME}",
    "path": "${PROJECT_NAME}",
    "namespace_id": ${GROUP_ID},
    "default_branch": "main",
    "initialize_with_readme": false,
    "visibility": "private"
}
EOF
)" | jq_field "['id']")
    echo "    created (id=${PROJECT_ID})"
else
    PROJECT_ID=$(api "${GITLAB_URL}/api/v4/projects/${PROJECT_PATH_ENCODED}" | jq_field "['id']")
    echo "    already exists (id=${PROJECT_ID})"
fi

PROJECT_WEB_URL="${GITLAB_URL}/${PROJECT_PATH}"
echo "${PROJECT_WEB_URL}" > "${PROJECT_URL_FILE}"
echo "${PROJECT_ID}" > "${PROJECT_ID_FILE}"

# ─── seed main branch ────────────────────────────────────────────────
# Skip if main already has any commits. GitLab returns 404 on the
# commits endpoint when the repo is empty, hence the || echo "0".
COMMIT_COUNT=$(api "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/repository/commits?ref_name=main&per_page=1" 2>/dev/null \
    | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "${COMMIT_COUNT}" = "0" ]; then
    echo
    echo "==> seeding main branch"

    README_B64=$(cat <<'EOF' | b64
# discount-service

Tiny order-pricing service used as a fixture for the Kodus self-hosted
GitLab integration tests. The code is intentionally small — just enough
shape for a code reviewer to have something meaningful to comment on.
EOF
)

    PKG_B64=$(cat <<'EOF' | b64
{
    "name": "discount-service",
    "version": "0.1.0",
    "private": true,
    "scripts": {
        "build": "tsc -p tsconfig.json",
        "start": "node dist/server.js"
    },
    "dependencies": {
        "express": "^4.18.2"
    },
    "devDependencies": {
        "@types/express": "^4.17.21",
        "@types/node": "^20.10.0",
        "typescript": "^5.3.0"
    }
}
EOF
)

    TSCONFIG_B64=$(cat <<'EOF' | b64
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "commonjs",
        "strict": true,
        "esModuleInterop": true,
        "outDir": "dist",
        "rootDir": "src"
    },
    "include": ["src"]
}
EOF
)

    USERS_B64=$(cat <<'EOF' | b64
export type User = {
    id: string;
    name: string;
    email: string;
};

const USERS: User[] = [
    { id: 'u_1', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'u_2', name: 'Alan Turing', email: 'alan@example.com' },
    { id: 'u_3', name: 'Grace Hopper', email: 'grace@example.com' },
];

export function findUser(id: string): User | undefined {
    return USERS.find((u) => u.id === id);
}

export function listUsers(): User[] {
    return USERS.slice();
}
EOF
)

    ORDERS_B64=$(cat <<'EOF' | b64
import { findUser } from './users';

export type OrderItem = {
    sku: string;
    qty: number;
    price: number;
};

export type Order = {
    id: string;
    userId: string;
    items: OrderItem[];
};

export function orderTotal(order: Order): number {
    return order.items.reduce((acc, item) => acc + item.qty * item.price, 0);
}

export function buildOrderSummary(order: Order): string {
    const user = findUser(order.userId);
    const total = orderTotal(order);
    return `${user?.name ?? 'unknown'} — ${order.items.length} items — $${total.toFixed(2)}`;
}
EOF
)

    SERVER_B64=$(cat <<'EOF' | b64
import express from 'express';
import { listUsers, findUser } from './users';
import { buildOrderSummary, Order } from './orders';

const app = express();
app.use(express.json());

app.get('/users', (_req, res) => {
    res.json(listUsers());
});

app.get('/users/:id', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
});

app.post('/orders/summary', (req, res) => {
    const order = req.body as Order;
    res.json({ summary: buildOrderSummary(order) });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
    console.log(`discount-service listening on :${port}`);
});
EOF
)

    PAYLOAD=$(python3 <<EOF
import json
print(json.dumps({
    "branch": "main",
    "commit_message": "Initial commit: discount-service skeleton",
    "actions": [
        {"action": "create", "file_path": "README.md",     "content": "${README_B64}",   "encoding": "base64"},
        {"action": "create", "file_path": "package.json",  "content": "${PKG_B64}",      "encoding": "base64"},
        {"action": "create", "file_path": "tsconfig.json", "content": "${TSCONFIG_B64}", "encoding": "base64"},
        {"action": "create", "file_path": "src/users.ts",  "content": "${USERS_B64}",    "encoding": "base64"},
        {"action": "create", "file_path": "src/orders.ts", "content": "${ORDERS_B64}",   "encoding": "base64"},
        {"action": "create", "file_path": "src/server.ts", "content": "${SERVER_B64}",   "encoding": "base64"},
    ],
}))
EOF
)
    api -X POST "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/repository/commits" \
        -d "${PAYLOAD}" >/dev/null
    echo "    seeded 6 files on main"
else
    echo
    echo "==> main already has commits — skipping seed"
fi

# ─── user PAT ────────────────────────────────────────────────────────
# Always re-mint so the .tmp file is authoritative. Existing tokens
# under the same name are revoked first to keep the user's token list
# tidy.
echo
echo "==> minting PAT for ${USER_NAME}"
EXISTING_TOKENS=$(api "${GITLAB_URL}/api/v4/users/${USER_ID}/impersonation_tokens?state=active" \
    | python3 -c "import json,sys; print(','.join(str(t['id']) for t in json.load(sys.stdin) if t['name']=='kodus-dev-bootstrap'))")

if [ -n "${EXISTING_TOKENS}" ]; then
    for tid in $(echo "${EXISTING_TOKENS}" | tr ',' ' '); do
        api -X DELETE "${GITLAB_URL}/api/v4/users/${USER_ID}/impersonation_tokens/${tid}" >/dev/null 2>&1 || true
    done
fi

# Scope set mirrors the Kody docs at docs.kodus.io for "GitLab PAT
# Token" — `api`, `read_api`, `read_user`, `read_repository`,
# `write_repository`. Keeping the dev fixture in sync with the docs
# means a token minted here is drop-in replaceable with one a user
# generates by hand.
#
# `expires_at` is required by GitLab 16+; never-expiring PATs were
# removed. One year out is plenty for a dev fixture and matches what
# the Kody docs suggest users pick when creating their own token.
EXPIRES_AT="$(date -d '+365 days' +%Y-%m-%d 2>/dev/null || date -v+365d +%Y-%m-%d)"
PAT=$(api -X POST "${GITLAB_URL}/api/v4/users/${USER_ID}/impersonation_tokens" -d "$(cat <<EOF
{
    "name": "kodus-dev-bootstrap",
    "scopes": ["api", "read_api", "read_user", "read_repository", "write_repository"],
    "expires_at": "${EXPIRES_AT}"
}
EOF
)" | jq_field "['token']")

if [ -z "${PAT}" ]; then
    echo "error: failed to mint PAT for ${USER_NAME}" >&2
    exit 1
fi

echo "${PAT}" > "${USER_PAT_FILE}"
chmod 600 "${USER_PAT_FILE}"
echo "    PAT written to ${USER_PAT_FILE}"

# ─── optional webhook ────────────────────────────────────────────────
# If WEBHOOK_URL is set, register/replace a project hook covering the
# events Kodus actually consumes (merge_requests_events, note_events).
# Skipping this leaves the project without a hook; the real Kodus
# integration registers one itself on setup, so this is only useful
# when you want to drive the project directly (e.g. via a zrok tunnel)
# before the integration is wired up.
if [ -n "${WEBHOOK_URL:-}" ]; then
    echo
    echo "==> registering project webhook → ${WEBHOOK_URL}"
    # Remove any hooks pointing at the same URL so we don't pile up
    # duplicates across re-runs.
    HOOKS=$(api "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/hooks")
    DUPS=$(echo "${HOOKS}" | python3 -c "import json,sys,os; want=os.environ['WEBHOOK_URL']; print(','.join(str(h['id']) for h in json.load(sys.stdin) if h['url']==want))")
    if [ -n "${DUPS}" ]; then
        for hid in $(echo "${DUPS}" | tr ',' ' '); do
            api -X DELETE "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/hooks/${hid}" >/dev/null 2>&1 || true
        done
    fi
    api -X POST "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/hooks" -d "$(cat <<EOF
{
    "url": "${WEBHOOK_URL}",
    "merge_requests_events": true,
    "note_events": true,
    "enable_ssl_verification": false
}
EOF
)" >/dev/null
    echo "    webhook installed"
fi

cat <<EOF

  Project:     ${PROJECT_WEB_URL}
  User PAT:    ${PAT}
               (also at ${USER_PAT_FILE})

  Register in Kodus as a self-hosted GitLab integration with:
      host  = ${GITLAB_URL}
      token = <PAT above>

  Next:
    bash scripts/gitlab-dev/create-mr.sh   # pushes feature branch + opens MR
EOF
