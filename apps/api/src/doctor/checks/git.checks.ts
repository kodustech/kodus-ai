import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { RepositoryAccessDiagnosis } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryAccessDiagnosis.type';

import { mapWithinBudget } from '../budget';
import {
    DoctorCheck,
    DoctorContext,
    DoctorResult,
    DoctorTeam,
    platformLabel,
    RECENT_DAYS,
    reviewableTeams,
    teamScope,
} from '../doctor.types';

/** Caps provider calls on installs with hundreds of selected repositories. */
export const MAX_REPOS_PER_TEAM = 25;
/** Repositories probed at once; each probe is a few provider calls. */
export const GIT_PROBE_CONCURRENCY = 3;
/** Stays under CHECK_TIMEOUT_MS so the repositories probed are still reported. */
export const GIT_BUDGET_MS = 60_000;
/**
 * A probe started before the deadline may run this far past it, no more:
 * each provider call has its own 60s timeout, so without a ceiling three
 * in-flight probes could outlive CHECK_TIMEOUT_MS and lose every result.
 */
export const GIT_PROBE_GRACE_MS = 15_000;

type ProbeResult = RepositoryAccessDiagnosis & { timedOut?: true };

function withCeiling<T>(
    work: Promise<T>,
    ms: number,
    onTimeout: T,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const ceiling = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), Math.max(0, ms));
    });
    return Promise.race([work, ceiling]).finally(() => clearTimeout(timer));
}

/** The env var holding each provider's webhook URL (see doctor.sh). */
export const WEBHOOK_URL_ENV: Record<string, string> = {
    [PlatformType.GITHUB]: 'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.GITLAB]: 'API_GITLAB_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.BITBUCKET]: 'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.AZURE_REPOS]: 'GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK',
    [PlatformType.FORGEJO]: 'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
};

/** Git events received in the window, from the jobs the webhooks service queued. */
export interface DeliveredEvents {
    /** Events of the team's platform, any repository. */
    platformEvents: number;
    /** Repositories (provider ids) those events named. */
    repositoryIds: Set<string>;
}

export interface GitDeps {
    now?: () => number;
    diagnose(
        team: DoctorTeam,
        repository: DoctorTeam['repositories'][number],
    ): Promise<RepositoryAccessDiagnosis>;
    /**
     * Proof the provider delivers: a hook the token cannot list (or an
     * organization/group hook) is still fine when events arrive for the repo.
     */
    deliveredEvents?(team: DoctorTeam): Promise<DeliveredEvents>;
    /**
     * Comments Kody posted on the repository in the window: proof the token
     * can write when the provider does not report its permission.
     */
    postedComments?(team: DoctorTeam, repositoryId: string): Promise<number>;
}

/** Enough to prove delivery; counting further would only scan more rows. */
export const WEBHOOK_EVENTS_CAP = 1000;

/** What the webhook address answered to the doctor's empty POST. */
export interface WebhookAnswer {
    status: number;
    /** Start of the response body. */
    body: string;
}

export interface WebhookDeps {
    /** Git events this install received from `platform` in the last RECENT_DAYS. */
    recentEvents(
        platform: string,
    ): Promise<{ count: number; last: Date | null }>;
    /**
     * POSTs `{}` with no event header: the webhooks service drops it unqueued
     * ("Webhook ignored"). Rejects with a network error.
     */
    probe(url: string, platform: string): Promise<WebhookAnswer>;
}

function names(repos: string[]): string {
    const shown = repos.slice(0, 5).join(', ');
    return repos.length > 5 ? `${shown} and ${repos.length - 5} more` : shown;
}

const NO_EVENTS: DeliveredEvents = {
    platformEvents: 0,
    repositoryIds: new Set(),
};

/** Token can read, can write, and a hook delivers events, per selected repo. */
export function gitAccessCheck(deps: GitDeps): DoctorCheck {
    return {
        id: 'git.access',
        blocking: true,
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const now = deps.now ?? Date.now;
            const deadline = now() + GIT_BUDGET_MS;

            for (const team of reviewableTeams(ctx)) {
                const scope = teamScope(team);
                const git = platformLabel(team.platform);
                const webhookUrl = ctx.env[WEBHOOK_URL_ENV[team.platform!]];
                const webhookUrlSet = !!webhookUrl;
                const candidates = team.repositories.slice(
                    0,
                    MAX_REPOS_PER_TEAM,
                );
                const [{ done, skipped }, delivered] = await Promise.all([
                    mapWithinBudget(
                        candidates,
                        { concurrency: GIT_PROBE_CONCURRENCY, deadline, now },
                        (repo) =>
                            withCeiling(
                                deps.diagnose(team, repo),
                                deadline + GIT_PROBE_GRACE_MS - now(),
                                // Marked, so it is reported as "not checked" and
                                // never as a diagnosis with token/webhook advice.
                                {
                                    read: 'unknown',
                                    write: 'unknown',
                                    hook: 'unknown',
                                    timedOut: true,
                                } as ProbeResult,
                            ),
                    ),
                    deps.deliveredEvents
                        ? deps.deliveredEvents(team).catch(() => NO_EVENTS)
                        : Promise.resolve(NO_EVENTS),
                ]);
                const cut = done
                    .filter(({ result }) => (result as ProbeResult).timedOut)
                    .map(({ item }) => item.name);
                const answered = done.filter(
                    ({ result }) => !(result as ProbeResult).timedOut,
                );
                const repos = answered.map(({ item }) => item);
                const readDenied: string[] = [];
                const writeDenied: string[] = [];
                const hookMissing: string[] = [];
                const hookStale: string[] = [];
                /** Repo hook absent, but other repositories deliver: maybe an org/group hook. */
                const hookUncovered: string[] = [];
                /** GitHub App install that delivered nothing in the window. */
                const appSilent: string[] = [];
                const unverified = {
                    read: [] as string[],
                    write: [] as string[],
                    hook: [] as string[],
                };
                const errors = new Set<string>();

                for (const { item: repo, result: d } of answered) {
                    if (d.error) {
                        errors.add(d.error);
                    }
                    if (d.read === 'denied') {
                        readDenied.push(repo.name);
                        continue;
                    }
                    if (d.read === 'unknown') {
                        unverified.read.push(repo.name);
                    }
                    if (d.write === 'denied') {
                        writeDenied.push(repo.name);
                    } else if (d.write === 'unknown') {
                        const posted = deps.postedComments
                            ? await deps
                                  .postedComments(team, repo.id)
                                  .catch(() => 0)
                            : 0;
                        if (!posted) {
                            unverified.write.push(repo.name);
                        }
                    }

                    // Without a webhook URL there is nothing to look for;
                    // webhookUrlCheck already reports the missing URL.
                    if (!webhookUrlSet) {
                        continue;
                    }
                    const deliveredHere = delivered.repositoryIds.has(repo.id);
                    if (d.hook === 'stale') {
                        hookStale.push(repo.name);
                    } else if (d.hook === 'missing' && !deliveredHere) {
                        (delivered.platformEvents
                            ? hookUncovered
                            : hookMissing
                        ).push(repo.name);
                    } else if (d.hook === 'app-level') {
                        if (!delivered.platformEvents) {
                            appSilent.push(repo.name);
                        }
                    } else if (d.hook === 'unknown' && !deliveredHere) {
                        unverified.hook.push(repo.name);
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
                        fix: `Reconnect ${git} in Settings > Git with a token that has access to these repositories, or remove them from the selection.${providerSaid}`,
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
                        title: `No Kodus webhook on ${names(hookMissing)}, and no ${git} event reached Kodus in the last ${RECENT_DAYS} days.`,
                        impact: 'Kodus is never told about new pull requests there, so they are not reviewed.',
                        fix: `Deselect and reselect these repositories in Settings > Git with a token that can manage webhooks (GitLab: Maintainer), or add the hook by hand pointing to ${webhookUrl} (pull request and comment events).`,
                    });
                }
                if (hookStale.length) {
                    results.push({
                        check: 'git.webhook',
                        status: 'fail',
                        scope,
                        title: `The Kodus webhook on ${names(hookStale)} carries a token this install no longer accepts.`,
                        impact: `${git} delivers every event, and Kodus rejects it (HTTP 403), so these pull requests are not reviewed.`,
                        fix: 'CODE_MANAGEMENT_SECRET or CODE_MANAGEMENT_WEBHOOK_TOKEN changed after the hook was created. Deselect and reselect these repositories in Settings > Git to recreate it, or restore the previous values.',
                    });
                }
                if (hookUncovered.length) {
                    results.push({
                        check: 'git.webhook',
                        status: 'unknown',
                        scope,
                        title: `No repository webhook on ${names(hookUncovered)}, and no event came from ${hookUncovered.length === 1 ? 'it' : 'them'} in the last ${RECENT_DAYS} days (other ${git} repositories do deliver).`,
                        fix: `Fine if an organization or group webhook covers ${hookUncovered.length === 1 ? 'it' : 'them'}: open a pull request there to confirm. Otherwise deselect and reselect ${hookUncovered.length === 1 ? 'it' : 'them'} in Settings > Git.`,
                        blocking: true,
                    });
                }
                if (appSilent.length) {
                    results.push({
                        check: 'git.webhook',
                        status: 'unknown',
                        scope,
                        title: `The GitHub App delivered no event to Kodus in the last ${RECENT_DAYS} days.`,
                        fix: `Fine if no pull request was opened. Otherwise check the app's webhook URL (${webhookUrl}) and its "Recent deliveries" in GitHub > Settings > Developer settings > GitHub Apps.`,
                        blocking: true,
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
                                ? `Check the token in ${git}.${providerSaid}`
                                : what === 'find the Kodus webhook on'
                                  ? `The token cannot list webhooks (needs admin), and no event came from ${repoNames.length === 1 ? 'it' : 'them'} in the last ${RECENT_DAYS} days. Check the repository's webhooks in ${git} for ${webhookUrl}.`
                                  : `${git} does not report this for this kind of token (fine-grained or app tokens), and Kody posted nothing there in the last ${RECENT_DAYS} days. Make sure it has write access to pull requests.`,
                        blocking: true,
                    });
                }
                if (cut.length) {
                    results.push({
                        check: 'git.timed_out',
                        status: 'unknown',
                        scope,
                        title: `Did not finish checking ${names(cut)}: ${git} did not answer in time.`,
                        fix: `Run the doctor again; if it repeats, check ${git}'s status or its rate limits.`,
                        blocking: true,
                    });
                }
                if (team.repositories.length > repos.length + cut.length) {
                    results.push({
                        check: 'git.truncated',
                        status: 'info',
                        scope,
                        title: `Checked ${repos.length} of ${team.repositories.length} selected repositories${skipped.length ? ' (time budget reached)' : ''}.`,
                        fix: skipped.length
                            ? 'Run the doctor again to check the rest; a slow Git provider makes each check take longer.'
                            : undefined,
                    });
                }
                const verified = (...lists: string[][]) =>
                    repos.length - lists.reduce((n, l) => n + l.length, 0);
                const okLine = (check: string, count: number, what: string) =>
                    count > 0 &&
                    results.push({
                        check,
                        status: 'ok',
                        scope,
                        title: `${what} ${count} ${count === 1 ? 'repository' : 'repositories'}.`,
                    });
                okLine(
                    'git.read',
                    verified(readDenied, unverified.read),
                    'The Git token can read',
                );
                okLine(
                    'git.write',
                    verified(readDenied, writeDenied, unverified.write),
                    'The Git token can comment on pull requests in',
                );
                if (webhookUrlSet) {
                    okLine(
                        'git.webhook',
                        verified(
                            readDenied,
                            hookMissing,
                            hookStale,
                            hookUncovered,
                            appSilent,
                            unverified.hook,
                        ),
                        'Kodus receives pull request events from',
                    );
                }
            }

            return results;
        },
    };
}

/**
 * How the webhook address answered the doctor's empty POST. Only the webhooks
 * service drops it with "Webhook ignored"; Azure Repos checks the URL token
 * first, so its probe carries a fresh one and expects the empty-payload 400.
 */
export function judgeWebhookAnswer(
    platform: string,
    answer: WebhookAnswer,
):
    | 'kodus'
    | 'token-rejected'
    | 'not-a-webhook-route'
    | 'upstream-down'
    | 'other' {
    const body = answer.body ?? '';
    if (platform === PlatformType.AZURE_REPOS) {
        if (answer.status === 400 && body.includes('Unrecognized event')) {
            return 'kodus';
        }
        if (answer.status === 403 && body.includes('Unauthorized')) {
            return 'token-rejected';
        }
    } else if (answer.status === 200 && body.startsWith('Webhook ignored')) {
        return 'kodus';
    }
    // NestJS' default 404: a Kodus service, but no webhook route at that path.
    if (answer.status === 404 && body.includes('Cannot POST')) {
        return 'not-a-webhook-route';
    }
    if (answer.status >= 500) {
        return 'upstream-down';
    }
    return 'other';
}

const DNS_OR_TLS = [
    'ENOTFOUND',
    'EAI_AGAIN',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
];

/**
 * The webhook URL is configured and Git events reach it. A recent event is the
 * proof. Without one, the doctor POSTs an empty payload to the address: only
 * the Kodus webhooks service answers it the expected way. What this container
 * cannot resolve or trust is not judged a failure, because its resolver and CA
 * store are not the ones the Git host uses.
 */
export function webhookUrlCheck(deps: WebhookDeps): DoctorCheck {
    return {
        id: 'git.webhook_url',
        blocking: true,
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const platforms = new Set(
                reviewableTeams(ctx).map((t) => t.platform!),
            );
            const port = ctx.env.API_WEBHOOKS_PORT || '3332';

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

                const events = await deps.recentEvents(platformId);
                if (events.count > 0) {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'ok',
                        title: `Kodus received ${events.count >= WEBHOOK_EVENTS_CAP ? `${WEBHOOK_EVENTS_CAP}+` : events.count} ${platform} event(s) in the last ${RECENT_DAYS} days (latest ${events.last ? events.last.toISOString() : 'unknown'}).`,
                    });
                    continue;
                }

                const route = `the webhooks service (port ${port}) at the path /<provider>/webhook`;
                let answer: WebhookAnswer;
                try {
                    answer = await deps.probe(url, platformId);
                } catch (error: any) {
                    const code = String(
                        error?.cause?.code ?? error?.code ?? '',
                    );
                    const dnsOrTls = DNS_OR_TLS.includes(code);
                    results.push({
                        check: 'git.webhook_url',
                        status: 'unknown',
                        title: dnsOrTls
                            ? `The ${platform} webhook address does not resolve or has a certificate this server does not trust (${code}), and no ${platform} event arrived in the last ${RECENT_DAYS} days.`
                            : `Could not reach the ${platform} webhook address from this server (${code || 'no answer'}), and no ${platform} event arrived in the last ${RECENT_DAYS} days.`,
                        fix: dnsOrTls
                            ? `If ${platform} cannot resolve or trust ${url} either, fix its DNS or certificate, or correct ${envVar}. Its "Recent deliveries" in ${platform} tell which.`
                            : `This can be normal behind NAT. Check "Recent deliveries" of the webhook in ${platform}: failed deliveries mean the address is wrong or blocked.`,
                        blocking: true,
                    });
                    continue;
                }

                const verdict = judgeWebhookAnswer(platformId, answer);
                const answered = `HTTP ${answer.status}${answer.body ? `: ${answer.body.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
                if (verdict === 'kodus') {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'ok',
                        title: `The ${platform} webhook address reaches the Kodus webhooks service (no ${platform} event in the last ${RECENT_DAYS} days yet).`,
                    });
                } else if (verdict === 'token-rejected') {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'fail',
                        title: `The webhooks service rejects the ${platform} webhook token this API creates (${answered}).`,
                        impact: `Every ${platform} event is refused with HTTP 403, so nothing is reviewed.`,
                        fix: 'Give api and webhooks the same CODE_MANAGEMENT_SECRET and CODE_MANAGEMENT_WEBHOOK_TOKEN, restart both, then deselect and reselect the repositories in Settings > Git.',
                    });
                } else if (verdict === 'not-a-webhook-route') {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'fail',
                        title: `The ${platform} webhook address reaches a Kodus service that has no webhook route there (${answered}).`,
                        impact: `${platform} gets the same 404 for every event, so nothing is reviewed.`,
                        fix: `Point ${envVar} (or the reverse proxy behind it) to ${route}, not to the API or the web app.`,
                    });
                } else if (verdict === 'upstream-down') {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'fail',
                        title: `The ${platform} webhook address answers with a server error (${answered}).`,
                        impact: `${platform} deliveries fail the same way, so nothing is reviewed.`,
                        fix: `Check that the webhooks service is running and that the proxy in front of ${url} forwards to ${route}.`,
                    });
                } else {
                    results.push({
                        check: 'git.webhook_url',
                        status: 'unknown',
                        title: `The ${platform} webhook address answers, but not like the Kodus webhooks service (${answered}).`,
                        fix: `Check that ${url} reaches ${route}: a login page, WAF or other app in front of it would refuse ${platform} deliveries too. "Recent deliveries" in ${platform} tell for sure.`,
                        blocking: true,
                    });
                }
            }

            return results;
        },
    };
}
