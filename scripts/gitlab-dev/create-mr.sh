#!/usr/bin/env bash
# Step 3 of 3 — push the `feat/discount-codes` branch and open an MR
# against `main`. The branch carries five deliberate review-worthy
# issues so Kodus is virtually guaranteed to surface at least one
# suggestion (missing await, unvalidated input flowing into a Record
# indexer, hardcoded admin secret, loose `==` + magic number, unused
# import + stale TODO).
#
# Idempotent — if the branch and MR already exist, the script reports
# them and exits 0 without re-pushing.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

echo "════════════════════════════════════════════════════════════════"
echo " gitlab-dev — create-mr"
echo "════════════════════════════════════════════════════════════════"

if [ ! -f "${PROJECT_ID_FILE}" ]; then
    cat >&2 <<EOF
error: ${PROJECT_ID_FILE} missing — create the project first:
    bash scripts/gitlab-dev/create-project.sh
EOF
    exit 1
fi
PROJECT_ID="$(cat "${PROJECT_ID_FILE}")"

echo
echo "==> resolving admin PAT"
acquire_admin_pat

# ─── feature branch ──────────────────────────────────────────────────
echo
echo "==> ensuring branch ${FEATURE_BRANCH}"
BRANCH_ENCODED="$(urlencode "${FEATURE_BRANCH}")"
BRANCH_STATUS=$(api_status "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/repository/branches/${BRANCH_ENCODED}")

if [ "${BRANCH_STATUS}" = "404" ]; then
    api -X POST "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/repository/branches?branch=${BRANCH_ENCODED}&ref=main" >/dev/null
    echo "    created from main"

    # NEW: src/discounts.ts — seeds unused-import, hardcoded secret,
    # stale TODO, and loose-equality issues.
    DISCOUNTS_B64=$(cat <<'EOF' | b64
// TODO: pull discount catalogue from the database once the migration lands.
import { findUser } from './users';

const ADMIN_TOKEN = "kodus-admin-prod-2026";

const DISCOUNTS: Record<string, number> = {
    WELCOME10: 0.10,
    SUMMER25: 0.25,
    BLACKFRIDAY: 0.40,
};

export async function fetchRemoteDiscount(code: string): Promise<number> {
    await new Promise((r) => setTimeout(r, 5));
    return DISCOUNTS[code] ?? 0;
}

export function getDiscount(code: string): number {
    return DISCOUNTS[code];
}

export function isAdminToken(token: string): boolean {
    return token == ADMIN_TOKEN;
}
EOF
)

    # MODIFIED: src/orders.ts — seeds missing-await + magic-number
    # issues. The Promise is multiplied as if it were a number, which
    # is also a great hook for the type-correctness side of review.
    ORDERS_FEAT_B64=$(cat <<'EOF' | b64
import { findUser } from './users';
import { fetchRemoteDiscount, getDiscount } from './discounts';

export type OrderItem = {
    sku: string;
    qty: number;
    price: number;
};

export type Order = {
    id: string;
    userId: string;
    items: OrderItem[];
    discountCode?: string;
};

export function orderTotal(order: Order): number {
    const subtotal = order.items.reduce((acc, item) => acc + item.qty * item.price, 0);
    const discount = order.discountCode ? fetchRemoteDiscount(order.discountCode) : 0;
    return subtotal * (1 - (discount as unknown as number));
}

export function buildOrderSummary(order: Order): string {
    const user = findUser(order.userId);
    const total = orderTotal(order);
    if (total > 100) {
        return `${user?.name ?? 'unknown'} — VIP order — $${total.toFixed(2)}`;
    }
    return `${user?.name ?? 'unknown'} — ${order.items.length} items — $${total.toFixed(2)}`;
}

export function applyDiscountCode(order: Order, code: string): Order {
    return { ...order, discountCode: code };
}

export function lookupDiscount(code: string): number {
    return getDiscount(code);
}
EOF
)

    PAYLOAD=$(python3 <<EOF
import json
print(json.dumps({
    "branch": "${FEATURE_BRANCH}",
    "commit_message": "feat(orders): apply discount codes at checkout",
    "actions": [
        {"action": "create", "file_path": "src/discounts.ts", "content": "${DISCOUNTS_B64}",   "encoding": "base64"},
        {"action": "update", "file_path": "src/orders.ts",    "content": "${ORDERS_FEAT_B64}", "encoding": "base64"},
    ],
}))
EOF
)
    api -X POST "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/repository/commits" \
        -d "${PAYLOAD}" >/dev/null
    echo "    pushed feature commit"
else
    echo "    already exists"
fi

# ─── merge request ───────────────────────────────────────────────────
echo
echo "==> ensuring MR ${FEATURE_BRANCH} → main"
EXISTING_MR=$(api "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/merge_requests?source_branch=${FEATURE_BRANCH}&state=opened" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['web_url'] if d else '', end='')")

if [ -z "${EXISTING_MR}" ]; then
    MR_BODY=$(python3 - "${FEATURE_BRANCH}" <<'EOF'
import json
print(json.dumps({
    "source_branch": sys.argv[1],
    "target_branch": "main",
    "title": "feat(orders): apply discount codes at checkout",
    "description": (
        "Adds support for discount codes on orders.\n\n"
        "- New `discounts.ts` module exposes a `getDiscount(code)` lookup\n"
        "  and an async `fetchRemoteDiscount` for the upcoming\n"
        "  database-backed catalogue.\n"
        "- `orders.ts` consumes the discount when computing `orderTotal`.\n"
        "- VIP summary line for high-value orders.\n\n"
        "Closes #1."
    ),
    "remove_source_branch": True,
}))
EOF
)
    MR_URL=$(api -X POST "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/merge_requests" \
        -d "${MR_BODY}" | jq_field "['web_url']")
    echo "    opened ${MR_URL}"
else
    MR_URL="${EXISTING_MR}"
    echo "    already open: ${MR_URL}"
fi
echo "${MR_URL}" > "${MR_URL_FILE}"

cat <<EOF

  MR:  ${MR_URL}

  Trigger a review from the Kodus side once the integration is wired.
EOF
