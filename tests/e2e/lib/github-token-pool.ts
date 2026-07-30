/**
 * GitHub e2e token pool.
 *
 * GitHub's rate limits — both the 5k/h primary budget and (worse for us) the
 * per-account *secondary* limits on content creation (branches/PRs/comments) —
 * are charged PER ACCOUNT. The matrix runs ~dozens of GitHub cells through a
 * single bot token, so one account's budget is the ceiling for the whole run;
 * when it trips we get `HTTP 403` / opaque `items is not iterable` failures.
 *
 * Spreading the cells across several bot accounts multiplies both budgets
 * linearly. This module just resolves the available tokens; the runner does
 * the round-robin assignment per GitHub cell.
 *
 * Sources, in priority order:
 *   1. `GH_TEST_TOKENS` — a single secret holding a comma/space/newline list
 *      (easiest to manage as one secret).
 *   2. `GH_TEST_TOKEN` + `GH_TEST_TOKEN_2..N` — the base token plus numbered
 *      siblings, one per extra bot account.
 *
 * Always backward compatible: with only `GH_TEST_TOKEN` set, the pool is a
 * single token and behaviour is identical to before.
 */

const MAX_NUMBERED = 9;

function dedupe(tokens: string[]): string[] {
    return [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
}

export function githubTokenPool(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const list = env.GH_TEST_TOKENS?.split(/[\s,]+/);
    if (list && dedupe(list).length > 0) {
        return dedupe(list);
    }

    const numbered: string[] = [];
    if (env.GH_TEST_TOKEN) numbered.push(env.GH_TEST_TOKEN);
    for (let i = 2; i <= MAX_NUMBERED; i++) {
        const v = env[`GH_TEST_TOKEN_${i}`];
        if (v) numbered.push(v);
    }
    return dedupe(numbered);
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

interface RateLimitInfo {
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
export async function preflightGithubRateLimits(
    log: { info: (m: string) => void; warn: (m: string) => void },
    env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitInfo[]> {
    const pool = githubTokenPool(env);
    if (!pool.length) return [];

    const infos = await Promise.all(
        pool.map(async (token, idx): Promise<RateLimitInfo> => {
            const slot = idx + 1;
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
                        note: 'token rejected (HTTP 401 — expired/revoked?)',
                    };
                }
                const body = (await resp.json()) as {
                    resources?: {
                        core?: {
                            remaining: number;
                            limit: number;
                            reset: number;
                        };
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
        }),
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
