// Egress approvals' shared vocabulary (docs/runtime/egress-allowlist.md §9):
// the API, the runtime-worker and the hub all read it.

/** The environment id of an org-wide approval: every environment of the org gets it, a sandbox never (G5). */
export const ORG_EGRESS_SCOPE = '*';

/** How an approved host is reached (§6): inspected (GET/HEAD under its paths) or full access. */
export const EGRESS_APPROVAL_MODES = ['inspected', 'passthrough'] as const;
export type EgressApprovalMode = (typeof EGRESS_APPROVAL_MODES)[number];

/** Who may add a host to an environment (D3): owners, owners and the repo admins of its repositories, or nobody (the org list only). */
export const EGRESS_WHO_MAY_ADD = ['owners', 'owners_and_repo_admins', 'nobody'] as const;
export type EgressWhoMayAdd = (typeof EGRESS_WHO_MAY_ADD)[number];

/** The path prefixes an inspected approval gets when nobody names them: every read on the host. */
export const DEFAULT_INSPECTED_PATHS: readonly string[] = ['/'];
