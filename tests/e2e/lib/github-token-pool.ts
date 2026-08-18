/**
 * GitHub e2e harness credential.
 *
 * GitHub's rate limits — both the 5k/h primary budget and (worse for us) the
 * per-account *secondary* limits on content creation (branches/PRs/comments) —
 * are charged PER ACCOUNT. The matrix runs ~dozens of GitHub cells through a
 * single bot token, so one account's budget is the ceiling for the whole run;
 * when it trips we get `HTTP 403` / opaque `items is not iterable` failures.
 *
 * High-volume traffic now uses the GitHub App installation token. A single
 * human PAT remains solely for PR/comment authorship because Kodus ignores
 * bot-authored review triggers. Keeping this resolver's array shape avoids a
 * broad runner rewrite while deliberately rejecting token pools.
 */

export function githubTokenPool(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return env.GH_TEST_TOKEN ? [env.GH_TEST_TOKEN.trim()].filter(Boolean) : [];
}

export interface GithubTokenAssignment {
    /** The token to use, or undefined when no pool is configured (caller
     *  falls back to the provider's own requireEnv("GH_TEST_TOKEN")). */
    token: string | undefined;
    /** 1-based slot for logging (0 when the pool is empty). */
    slot: number;
    /** Pool size — `size > 1` is the only case worth logging. */
    size: number;
}

/**
 * Round-robin picker over the pool. Returns the next assignment (token + slot)
 * each call, so the runner can both use the token and log WHICH account it
 * rotated to (the slot, never the secret).
 */
export function makeGithubTokenPicker(
    env: NodeJS.ProcessEnv = process.env,
): () => GithubTokenAssignment {
    const pool = githubTokenPool(env);
    let i = 0;
    return () => {
        if (!pool.length) return { token: undefined, slot: 0, size: 0 };
        const slot = i++ % pool.length;
        return { token: pool[slot], slot: slot + 1, size: pool.length };
    };
}

// Below this fraction of the primary budget a bot account can't carry a full
// github cell (~200-270 requests/scenario × several scenarios), so the run is
// likely to trip mid-cell and cascade into rate-limit SKIPs.
const LOW_QUOTA_FRACTION = 0.1;

export interface RateLimitInfo {
    slot: number;
    remaining: number;
    limit: number;
    resetIso: string;
    ok: boolean;
    note?: string;
}

/**
 * Preflight the GitHub bot-account pool: report each account's remaining
 * primary REST budget BEFORE the cells run, so an already-drained account
 * (a prior run in the same hour, or one bad/expired token) is visible up
 * front instead of surfacing as an opaque mid-run 403 cascade.
 *
 * GET /rate_limit does NOT itself count against the budget, so this is free.
 * Best-effort: a network/parse error on one token never poisons the run —
 * the per-scenario paths still throw their own specific errors.
 */
/**
 * The credential the PRODUCT stores as its GitHub integration, mirroring
 * providers/github.ts:authToken(). It is deliberately NOT the driver pool and
 * NOT the App token: /code-management/auth-integration makes the backend
 * validate it against GitHub, and the stored credential has to outlive the
 * run, so an installation token (~1h) is rejected there.
 *
 * There is deliberately no fallback. The harness author and the credential
 * stored by the product have different permission and lifetime contracts;
 * conflating them caused opaque onboarding HTTP 400 failures.
 */
export function integrationTokenInfo(env: NodeJS.ProcessEnv = process.env): {
    token?: string;
    source: 'GH_INTEGRATION_TOKEN' | 'none';
    sharedWithDriverPool: boolean;
} {
    if (env.GH_INTEGRATION_TOKEN) {
        return {
            token: env.GH_INTEGRATION_TOKEN,
            source: 'GH_INTEGRATION_TOKEN',
            sharedWithDriverPool: githubTokenPool(env).includes(
                env.GH_INTEGRATION_TOKEN,
            ),
        };
    }
    return { source: 'none', sharedWithDriverPool: false };
}

async function probeQuota(
    token: string,
    slot: number,
): Promise<RateLimitInfo> {
    try {
        const resp = await fetch('https://api.github.com/rate_limit', {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (resp.status === 401) {
            return {
                slot,
                remaining: 0,
                limit: 0,
                resetIso: '',
                ok: false,
                note: 'token rejected (HTTP 401 - expired/revoked?)',
            };
        }
        const body = (await resp.json()) as {
            resources?: {
                core?: { remaining: number; limit: number; reset: number };
            };
        };
        const core = body.resources?.core;
        if (!core) {
            return {
                slot,
                remaining: 0,
                limit: 0,
                resetIso: '',
                ok: false,
                note: `unexpected /rate_limit shape (HTTP ${resp.status})`,
            };
        }
        return {
            slot,
            remaining: core.remaining,
            limit: core.limit,
            resetIso: new Date(core.reset * 1000).toISOString(),
            ok: true,
        };
    } catch (err) {
        return {
            slot,
            remaining: 0,
            limit: 0,
            resetIso: '',
            ok: false,
            note: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Preflight the credential the PRODUCT uses. The driver-pool preflight below
 * never looked at it, so a run started blind about the exact account that
 * dies inside /code-management/auth-integration.
 */
export async function preflightIntegrationToken(
    log: { info: (m: string) => void; warn: (m: string) => void },
    env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitInfo | undefined> {
    const info = integrationTokenInfo(env);
    if (!info.token) {
        log.warn(
            '[preflight] GH_INTEGRATION_TOKEN is missing - provider=github cannot register its integration',
        );
        return undefined;
    }
    if (info.sharedWithDriverPool) {
        log.warn(
            '[preflight] GH_INTEGRATION_TOKEN is ALSO in the driver pool - the product and the harness share one budget. ' +
                'Use a dedicated account for the integration credential.',
        );
    }

    const quota = await probeQuota(info.token, 0);
    if (!quota.ok) {
        log.warn(`[preflight] integration credential (${info.source}): ${quota.note}`);
        return quota;
    }
    const line =
        `[preflight] integration credential (${info.source}): ` +
        `${quota.remaining}/${quota.limit} core requests remaining (resets ${quota.resetIso})`;
    if (quota.remaining < quota.limit * LOW_QUOTA_FRACTION) {
        log.warn(
            `${line} - LOW. This is the account /code-management/auth-integration validates; ` +
                'when it is dry, onboarding 400s and the cell breaker skips every scenario.',
        );
    } else {
        log.info(line);
    }
    return quota;
}

/**
 * Sample the integration account's quota mid-run, so a drain can be ATTRIBUTED
 * instead of guessed at.
 *
 * Run 31443426784 is why this exists: the preflight read 5000/5000, and five
 * minutes later the same account answered `used: 5000` and killed three
 * scenarios. Nothing in the evidence could say whether the product burned an
 * hour of quota reviewing a 12-line diff, or whether some other consumer of
 * that account (it is a personal PAT, not a dedicated one) drained it while we
 * watched. Those two have opposite fixes, and a whole run is the wrong unit to
 * discover which one you have.
 *
 * Sampling per scenario separates them: spend inside a scenario is ours, spend
 * between scenarios is somebody else's. /rate_limit does not count against the
 * quota it reports, so this measurement is free.
 */
export async function integrationQuota(
    env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitInfo | undefined> {
    const info = integrationTokenInfo(env);
    if (!info.token) return undefined;
    const quota = await probeQuota(info.token, 0);
    return quota.ok ? quota : undefined;
}

export async function preflightGithubRateLimits(
    log: { info: (m: string) => void; warn: (m: string) => void },
    env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitInfo[]> {
    const pool = githubTokenPool(env);
    if (!pool.length) return [];

    const infos = await Promise.all(
        pool.map((token, idx) => probeQuota(token, idx + 1)),
    );

    for (const info of infos) {
        if (!info.ok) {
            log.warn(
                `[preflight] github token slot ${info.slot}/${pool.length}: ${info.note}`,
            );
            continue;
        }
        const line =
            `[preflight] github token slot ${info.slot}/${pool.length}: ` +
            `${info.remaining}/${info.limit} core requests remaining ` +
            `(resets ${info.resetIso})`;
        if (info.remaining < info.limit * LOW_QUOTA_FRACTION) {
            log.warn(`${line} — LOW, cell may trip the rate limit`);
        } else {
            log.info(line);
        }
    }

    if (infos.every((i) => !i.ok || i.remaining < i.limit * LOW_QUOTA_FRACTION)) {
        log.warn(
            `[preflight] every github bot account is exhausted or unusable — ` +
                `github cells will almost certainly SKIP on rate limits this run`,
        );
    }

    return infos;
}
