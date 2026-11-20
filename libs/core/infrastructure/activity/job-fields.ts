/**
 * The org, repository and PR a workflow job is about, read best effort from
 * its payload, whatever produced it: a code review job, a raw GitHub, GitLab,
 * Bitbucket or Azure webhook, a chat command. Used to name the job in stall
 * reports, the shutdown log and the stale-job reaper.
 */
export interface JobFields {
    organizationId?: string;
    repository?: string;
    prNumber?: number;
    platform?: string;
}

const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};
const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v ? v.slice(0, 200) : undefined;

export function jobFields(job: {
    payload?: unknown;
    organizationAndTeamData?: { organizationId?: string };
    organizationId?: string;
}): JobFields {
    const p = (job.payload ?? {}) as any;
    // Webhook jobs wrap the provider payload.
    const w = (
        p.payload && typeof p.payload === 'object' ? p.payload : p
    ) as any;
    const repo =
        p.repository ?? w.repository ?? w.project ?? w.resource?.repository;
    return {
        organizationId:
            str(job.organizationAndTeamData?.organizationId) ??
            str(job.organizationId) ??
            str(p.organizationAndTeamData?.organizationId) ??
            str(p.organizationId),
        repository:
            str(repo?.full_name) ??
            str(repo?.fullName) ??
            str(repo?.path_with_namespace) ??
            str(repo?.name) ??
            str(p.repositoryName),
        prNumber:
            num(p.prNumber) ??
            num(p.pullRequestNumber) ??
            num(p.pullRequest?.number) ??
            num(w.pull_request?.number) ??
            num(w.issue?.number) ??
            num(w.object_attributes?.iid) ??
            num(w.merge_request?.iid) ??
            num(w.pullrequest?.id) ??
            num(w.resource?.pullRequestId),
        platform: str(p.platformType) ?? str(p.platform),
    };
}
