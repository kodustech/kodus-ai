import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * Deterministic evidence a customer's own CI already produced for a commit,
 * normalized across code hosts.
 *
 * Hosts expose this at two very different depths, and the split matters:
 * every host can say "a check named X passed or failed" (GitHub check runs
 * and commit statuses, GitLab pipeline jobs, Azure PR statuses, Bitbucket
 * build statuses, Forgejo commit statuses), but only some expose per-line
 * findings (GitHub check-run annotations, Bitbucket Code Insights). Callers
 * that only need "did their pipeline already run Semgrep" are served by the
 * former; callers that want publishable findings need the latter.
 */
export type CheckEvidence = {
    /** Host identifier for the run, as a string. */
    id: string;
    /** Display name of the check, e.g. "semgrep", "CodeQL", "build". */
    name: string;
    status: CheckEvidenceStatus;
    /** Null while the run has not completed. */
    conclusion: CheckEvidenceConclusion | null;
    /** Link to the run on the host, when it provides one. */
    url: string | null;
    /**
     * Application that reported the check, when the host distinguishes the
     * reporter from the check name (GitHub app slug, Bitbucket reporter key).
     */
    reporter?: string;
    completedAt: string | null;
    platform: PlatformType;
    /**
     * Per-line findings. Undefined means "this host or this call did not
     * fetch them" — never confuse it with an empty array, which means the
     * check genuinely reported nothing.
     */
    annotations?: CheckAnnotation[];
};

export type CheckEvidenceStatus = 'queued' | 'in_progress' | 'completed';

export type CheckEvidenceConclusion =
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'skipped'
    | 'stale'
    | 'action_required';

export type CheckAnnotation = {
    /** Repo-relative path as the reporting tool emitted it. */
    path: string;
    startLine: number;
    endLine: number;
    level: 'notice' | 'warning' | 'failure';
    message: string;
    title?: string;
    /** Rule identifier when the reporting tool provides one. */
    ruleId?: string;
    url?: string;
};

export type GetCheckEvidenceParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { owner: string; name: string; id?: string };
    /** Head commit of the pull request under review. */
    commitSha: string;
    /** Some hosts key statuses by pull request rather than by commit. */
    prNumber?: number;
    /**
     * Fetch per-line findings too. Off by default because it costs an extra
     * round trip per check run on every host that supports it.
     */
    includeAnnotations?: boolean;
};

/**
 * What a host can actually report, so callers can degrade instead of guessing
 * from an empty result.
 */
export type CheckEvidenceSupport = {
    /** Check names plus pass/fail for a commit. */
    statuses: boolean;
    /** Per-line findings. */
    annotations: boolean;
};
