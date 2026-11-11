import type { ApprovalPolicy } from "@services/approval-policies/types";

export function approvalPolicyScope(policy: ApprovalPolicy): string {
    const conditions: string[] = [];
    if (policy.labels?.length)
        conditions.push(`Labels: ${policy.labels.join(", ")}`);
    if (policy.authors?.length || policy.authorTeams?.length) {
        const authors = [
            ...(policy.authors ?? []),
            ...(policy.authorTeams ?? []).map((team) => `@${team}`),
        ];
        conditions.push(`Authors: ${authors.join(", ")}`);
    }
    if (policy.includedFiles?.length)
        conditions.push(`Only ${policy.includedFiles.join(", ")}`);
    if (policy.excludedFiles?.length)
        conditions.push(`Except ${policy.excludedFiles.join(", ")}`);
    if (policy.maxChangedLines !== undefined)
        conditions.push(`Up to ${policy.maxChangedLines} changed lines`);
    if (policy.instruction?.trim()) conditions.push("Eligibility instruction");
    return conditions.length ? conditions.join(" · ") : "All clean PRs";
}
