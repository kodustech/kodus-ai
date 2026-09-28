/**
 * Self-hosted doctor (#1987): one read-only pass that answers "are my reviews
 * working?" for an admin who has never read this code.
 *
 *   fail    ✘  reviews do not run
 *   warn    !  reviews run degraded
 *   info    i  an optional feature is off
 *   skip    -  a setting skips reviews on purpose
 *   unknown ?  the check could not tell (never reported as fine)
 *   ok      ✔
 */
export type DoctorStatus = 'fail' | 'warn' | 'unknown' | 'info' | 'skip' | 'ok';

export interface DoctorResult {
    /** Stable id of the check, e.g. `llm.completion`. */
    check: string;
    status: DoctorStatus;
    /** What is wrong (or fine), in admin words. */
    title: string;
    /** What the admin loses. Required for fail / warn. */
    impact?: string;
    /** The one thing to do. Internal names (env vars, tables) go here only. */
    fix?: string;
    /** Where it applies: `org/team`, `org/team/repo`. Absent = whole install. */
    scope?: string;
}

export type ReviewsVerdict = 'NOT_RUNNING' | 'DEGRADED' | 'OK';

export interface DoctorReport {
    verdict: ReviewsVerdict;
    version: string;
    generatedAt: string;
    durationMs: number;
    results: DoctorResult[];
}

/** One team as the webhook path sees it (webhook-context.service.ts:46). */
export interface DoctorTeam {
    organizationId: string;
    organizationName: string;
    organizationActive: boolean;
    teamId: string;
    teamName: string;
    teamStatus: string;
    platform?: string;
    integrationActive: boolean;
    repositories: Array<{
        id: string;
        name: string;
        fullName?: string;
        defaultBranch?: string;
    }>;
    codeReviewAutomationActive: boolean;
}

export interface DoctorContext {
    teams: DoctorTeam[];
    /** A code-review automation row exists at all (seed). */
    codeReviewAutomationSeeded: boolean;
    /** Valid self-hosted license (Enterprise); false = Community Edition. */
    licensed: boolean;
    env: NodeJS.ProcessEnv;
}

export interface DoctorCheck {
    id: string;
    run(ctx: DoctorContext): Promise<DoctorResult[]>;
}

export function teamScope(team: DoctorTeam, repo?: string): string {
    const base = `${team.organizationName}/${team.teamName}`;
    return repo ? `${base}/${repo}` : base;
}

const PLATFORM_LABELS: Record<string, string> = {
    GITHUB: 'GitHub',
    GITLAB: 'GitLab',
    BITBUCKET: 'Bitbucket',
    AZURE_REPOS: 'Azure Repos',
    FORGEJO: 'Forgejo',
};

export function platformLabel(platform?: string): string {
    return (platform && PLATFORM_LABELS[platform]) || platform || 'Git';
}
