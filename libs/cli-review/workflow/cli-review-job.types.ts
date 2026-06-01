import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CliReviewInput } from '@libs/cli-review/domain/types/cli-review.types';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

export interface CliReviewJobGitContext {
    remote?: string;
    branch?: string;
    commitSha?: string;
    /**
     * Merge-base between HEAD and the upstream default branch on the user's
     * machine. The sandbox checks out this commit (which is guaranteed to be
     * on the remote) and applies the diff on top, so reviews work for
     * branches that haven't been pushed yet and for uncommitted changes.
     */
    mergeBaseSha?: string;
    /**
     * Optional GitHub PAT (trial mode only). Sits in the job payload only
     * for the duration of the queue run — never persisted to automation
     * execution rows.
     */
    githubPat?: string;
    inferredPlatform?: PlatformType;
    cliVersion?: string;
}

/**
 * How the CLI request was authenticated. Persisted to dataExecution so the
 * dashboard can show "Team: <name>" or "Personal" without ever exposing the
 * key/token itself.
 */
export interface CliReviewJobAuthContext {
    mode: 'team-key' | 'personal';
    /** UUID of the team_cli_keys row when mode === 'team-key'. */
    teamKeyId?: string;
    /** Human label set by the user when generating the key. */
    teamKeyName?: string;
    /** Logged-in user UUID when mode === 'personal'. */
    userId?: string;
    /** Logged-in user email when mode === 'personal' (independent of git config). */
    userEmail?: string;
}

export interface CliReviewJobPayload {
    organizationAndTeamData: OrganizationAndTeamData;
    input: CliReviewInput;
    isTrialMode?: boolean;
    userEmail?: string;
    gitContext?: CliReviewJobGitContext;
    cliAuth?: CliReviewJobAuthContext;
}
