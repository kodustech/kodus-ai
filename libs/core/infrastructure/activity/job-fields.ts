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
    /**
     * The PR's size as the provider reported it in the webhook body. Only
     * GitHub sends it there; the worker's memory line uses it to tell what a
     * review of a given size holds.
     */
    changedFiles?: number;
    changedLines?: number;
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
    // The provider's webhook body: a code review job carries it as
    // `codeManagementPayload` (EnqueueCodeReviewJobUseCase), a webhook job as
    // `payload`.
    const w = ([p.codeManagementPayload, p.payload].find(
        (v) => v && typeof v === 'object',
    ) ?? p) as any;
    const repo =
        p.repository ?? w.repository ?? w.project ?? w.resource?.repository;
    const additions = num(w.pull_request?.additions) ?? 0;
    const deletions = num(w.pull_request?.deletions) ?? 0;
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
        changedFiles: num(w.pull_request?.changed_files),
        changedLines: additions + deletions || undefined,
    };
}
