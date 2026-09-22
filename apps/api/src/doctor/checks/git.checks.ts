import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { RepositoryAccessDiagnosis } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryAccessDiagnosis.type';

import {
    DoctorCheck,
    DoctorContext,
    DoctorResult,
    DoctorTeam,
    platformLabel,
    teamScope,
} from '../doctor.types';

/** Caps provider calls on installs with hundreds of selected repositories. */
export const MAX_REPOS_PER_TEAM = 25;

/** The env var holding each provider's webhook URL (see doctor.sh). */
export const WEBHOOK_URL_ENV: Record<string, string> = {
    [PlatformType.GITHUB]: 'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.GITLAB]: 'API_GITLAB_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.BITBUCKET]: 'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.AZURE_REPOS]: 'GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.FORGEJO]: 'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
};

export interface GitDeps {
    diagnose(
        team: DoctorTeam,
        repository: DoctorTeam['repositories'][number],
    ): Promise<RepositoryAccessDiagnosis>;
    /** Resolves with the HTTP status, or rejects with a network error. */
    reach(url: string): Promise<number>;
}

function names(repos: string[]): string {
    const shown = repos.slice(0, 5).join(', ');
    return repos.length > 5 ? `${shown} and ${repos.length - 5} more` : shown;
}

function reviewableTeams(ctx: DoctorContext): DoctorTeam[] {
    return ctx.teams.filter(
        (t) => t.platform && t.integrationActive && t.repositories.length,
    );
}

/** Token can read, can write, and a hook delivers events, per selected repo. */
export function gitAccessCheck(deps: GitDeps): DoctorCheck {
    return {
        id: 'git.access',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];

            for (const team of reviewableTeams(ctx)) {
                const scope = teamScope(team);
                const repos = team.repositories.slice(0, MAX_REPOS_PER_TEAM);
                const readDenied: string[] = [];
                const writeDenied: string[] = [];
                const hookMissing: string[] = [];
                const unverified = {
                    read: [] as string[],
                    write: [] as string[],
                    hook: [] as string[],
                };
                const errors = new Set<string>();

                for (const repo of repos) {
                    const d = await deps.diagnose(team, repo);
                    if (d.error) {
                        errors.add(d.error);
                    }
                    if (d.read === 'denied') {
                        readDenied.push(repo.name);
                        continue;
                    }
                    if (d.write === 'denied') {
                        writeDenied.push(repo.name);
                    }
                    if (d.hook === 'missing') {
                        hookMissing.push(repo.name);
                    }
                    for (const part of ['read', 'write', 'hook'] as const) {
                        if (d[part] === 'unknown') {
                            unverified[part].push(repo.name);
                        }
                    }
                }

                const providerSaid = errors.size
                    ? ` Provider said: ${[...errors].slice(0, 2).join('; ')}`
                    : '';

                if (readDenied.length) {
                    results.push({
                        check: 'git.read',
                        status: 'fail',
                        scope,
                        title: `The Git token cannot read ${names(readDenied)}.`,
                        impact: 'Kody cannot fetch these pull requests, so they are never reviewed.',
                        fix: `Reconnect ${platformLabel(team.platform)} in Settings > Git with a token that has access to these repositories, or remove them from the selection.${providerSaid}`,
                    });
                }
                if (writeDenied.length) {
                    results.push({
                        check: 'git.write',
                        status: 'fail',
                        scope,
                        title: `The Git token can read but not comment on ${names(writeDenied)}.`,
                        impact: 'Reviews run but their comments are rejected, so nothing appears on the PR.',
                        fix: `Give the token write access to pull requests on these repositories (GitLab: Reporter or higher), then reconnect in Settings > Git.`,
                    });
                }
                if (hookMissing.length) {
                    results.push({
                        check: 'git.webhook',
                        status: 'fail',
                        scope,
                        title: `No Kodus webhook on ${names(hookMissing)}.`,
                        impact: 'Kodus is never told about new pull requests there, so they are not reviewed.',
                        fix: `Deselect and reselect these repositories in Settings > Git with a token that can manage webhooks (GitLab: Maintainer), or add the hook by hand pointing to ${ctx.env[WEBHOOK_URL_ENV[team.platform!]] || 'your webhook URL'} (pull request events).`,
                    });
                }
                const unverifiedParts = [
                    [unverified.read, 'read'],
                    [unverified.write, 'comment on pull requests in'],
                    [unverified.hook, 'find the Kodus webhook on'],
                ] as const;
                for (const [repoNames, what] of unverifiedParts) {
                    if (!repoNames.length) {
                        continue;
                    }
                    results.push({
                        check: 'git.unverified',
                        status: 'unknown',
                        scope,
                        title: `Could not verify that the Git token can ${what} ${names(repoNames)}.`,
                        fix:
                            what === 'read'
                                ? `Check the token in ${platformLabel(team.platform)}.${providerSaid}`
                                : what === 'find the Kodus webhook on'
                                  ? `The token cannot list webhooks (needs admin). Check the repository's webhooks in ${platformLabel(team.platform)} for ${ctx.env[WEBHOOK_URL_ENV[team.platform!]] || 'your webhook URL'}.`
                                  : `${platformLabel(team.platform)} does not report this for this kind of token (fine-grained or app tokens). Make sure it has write access to pull requests.`,
                    });
                }
                if (team.repositories.length > repos.length) {
                    results.push({
                        check: 'git.truncated',
                        status: 'info',
                        scope,
                        title: `Checked the first ${repos.length} of ${team.repositories.length} selected repositories.`,
                    });
                }
                if (
                    !readDenied.length &&
                    !writeDenied.length &&
                    !hookMissing.length &&
                    !unverifiedParts.some(([repoNames]) => repoNames.length)
                ) {
                    results.push({
                        check: 'git.access',
                        status: 'ok',
                        scope,
                        title: `The Git token can read, comment and receive events on ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}.`,
                    });
                }
            }

            return results;
        },
    };
}

/** The webhook URL is configured and answers from here. */
export function webhookUrlCheck(deps: Pick<GitDeps, 'reach'>): DoctorCheck {
    return {
        id: 'git.webhook_url',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const platforms = new Set(
                reviewableTeams(ctx).map((t) => t.platform!),
            );

            for (const platformId of platforms) {
                const platform = platformLabel(platformId);
                const envVar = WEBHOOK_URL_ENV[platformId];
                const url = envVar ? ctx.env[envVar] : undefined;
                if (!envVar) {
                    continue;
                }
                if (!url) {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'fail',
                        title: `The ${platform} webhook address is not set.`,
                        impact: `${platform} has nowhere to send pull request events, so nothing is reviewed.`,
                        fix: `Set ${envVar} to https://<your API host>/<provider>/webhook and restart the api.`,
                    });
                    continue;
                }

                try {
                    const status = await deps.reach(url);
                    results.push({
                        check: 'git.webhook_url',
                        status: 'ok',
                        title: `The ${platform} webhook address answers (HTTP ${status}).`,
                    });
                } catch (error: any) {
                    const code = String(
                        error?.cause?.code ?? error?.code ?? '',
                    );
                    const definite = [
                        'ENOTFOUND',
                        'EAI_AGAIN',
                        'CERT_HAS_EXPIRED',
                        'DEPTH_ZERO_SELF_SIGNED_CERT',
                        'SELF_SIGNED_CERT_IN_CHAIN',
                        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
                        'ERR_TLS_CERT_ALTNAME_INVALID',
                    ].includes(code);
                    results.push({
                        check: 'git.webhook_url',
                        status: definite ? 'fail' : 'unknown',
                        title: definite
                            ? `The ${platform} webhook address does not resolve or has an invalid certificate (${code}).`
                            : `Could not reach the ${platform} webhook address from this server (${code || 'no answer'}).`,
                        impact: definite
                            ? `${platform} cannot deliver pull request events, so nothing is reviewed.`
                            : undefined,
                        fix: definite
                            ? `Fix DNS/TLS for ${url}, or correct ${envVar}.`
                            : `This can be normal behind NAT. Check "Recent deliveries" of the webhook in ${platform}: failed deliveries mean the address is wrong or blocked.`,
                    });
                }
            }

            return results;
        },
    };
}
