import type { EgressApproval, EgressWhoMayAdd } from "../contracts";

// The words the outbound-access screens use for an approval
// (docs/runtime/egress-allowlist.md §9). Pure, so the screens and their tests read the same.

/** inspected: reads only under its paths; passthrough: full access (every approval made before tiers). */
export const egressTierLabel = (a: Pick<EgressApproval, "mode" | "pathPrefixes">): string => {
    if (a.mode !== "inspected") return "Full access";
    const paths = a.pathPrefixes?.length ? a.pathPrefixes : ["/"];
    return paths.length === 1 && paths[0] === "/" ? "Reads only" : `Reads only under ${paths.join(", ")}`;
};

/** D5: approvals do not expire; the row says when a claim last got the host, or that none has. */
export const egressLastUseLabel = (a: Pick<EgressApproval, "lastSentAt" | "revokedAt">): string =>
    a.revokedAt ? "Revoked" : a.lastSentAt ? "Last used" : "Not used yet";

export const egressSourceLabel = (a: Pick<EgressApproval, "source">): string =>
    a.source === "settings" ? "added in settings" : "allowed from a blocker";

/** Live approvals first, newest first; revoked ones after, for the record. */
export const sortEgressApprovals = (rows: EgressApproval[]): EgressApproval[] =>
    [...rows].sort(
        (x, y) =>
            Number(!!x.revokedAt) - Number(!!y.revokedAt) ||
            (Date.parse(y.approvedAt ?? "") || 0) - (Date.parse(x.approvedAt ?? "") || 0),
    );

export const WHO_MAY_ADD_LABEL: Record<EgressWhoMayAdd, string> = {
    owners: "Owners",
    owners_and_repo_admins: "Owners and the repo admins of the environment's repositories",
    nobody: "Nobody: every environment gets the org list only",
};

/** D2: what turning the recommended list off does, said before it is done. */
export const RECOMMENDED_OFF_WARNING =
    "With the recommended list off, the package registries and download hosts leave every claim of the org: a setup or a Run that installs from them fails until a host is added to the org list or to its environment.";
