import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from './log.js';

const execFileAsync = promisify(execFile);
const log = logger('server-evidence');

/**
 * Whether the target API is reachable at all. Used by the runner to
 * distinguish "product regression" (target up, scenario failed) from
 * "infra/network problem" (target unreachable — INCONCLUSIVE, not FAIL).
 * A run lost to a local network blip used to be reported identically to
 * a real bug, eroding trust in red results.
 */
export async function isTargetReachable(apiBaseUrl: string): Promise<boolean> {
    try {
        const resp = await fetch(`${apiBaseUrl}/health`, {
            signal: AbortSignal.timeout(10_000),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

/**
 * Best-effort server-side evidence collection on scenario failure.
 * Requires TARGET_SSH_HOST + TARGET_SSH_KEY in the environment (vm.sh
 * exports them for self-hosted targets); silently no-ops otherwise.
 *
 * Why: every red scenario used to say only "X didn't happen within Ns" —
 * diagnosing meant manual SSH + container-by-container grepping. This
 * drops the filtered server logs next to the scenario's other artifacts.
 */
export async function collectServerEvidence(
    artifactDir: string,
    label: string,
): Promise<void> {
    const host = process.env.TARGET_SSH_HOST;
    const key = process.env.TARGET_SSH_KEY;
    if (!host || !key) return;

    const containers = [
        'kodus-api',
        'kodus-worker-prod',
        'kodus-webhooks-prod',
    ];
    // Covers both kody-rules scenarios and the code-review pipeline: the
    // review path (webhook received → automation → pipeline stages → comment
    // posting) is what a code-review-basic timeout needs to explain whether
    // the product ran at all and where it stopped. Bitbucket/webhook terms
    // surface a webhook that never arrived vs a pipeline that crashed.
    const grepFilter =
        'kody-rules-sync|kody-rules-eval|KodyRulesSync|CrossProcess|ERROR|error -|Failed|' +
        'CodeReview|ReviewOrchestrator|CommentManager|CodeReviewPipeline|CodeReviewAgent|' +
        'Webhook|webhook|Automation|automation|Bitbucket|bitbucket';

    for (const container of containers) {
        try {
            const { stdout } = await execFileAsync(
                'ssh',
                [
                    '-i',
                    key,
                    '-o',
                    'StrictHostKeyChecking=no',
                    '-o',
                    'ConnectTimeout=10',
                    `root@${host}`,
                    // Three sections: (1) grep-filtered highlights, (2) the
                    // FULL ungrepped window (a review that skips/aborts logs at
                    // a level the filter misses AND scrolls off a small tail —
                    // the only way to see the pipeline's actual decision), (3)
                    // the last 40 lines for the crash-at-exit case.
                    `docker logs --since 60m ${container} 2>&1 | grep -aE "${grepFilter}" | grep -av Mongoose | tail -200; echo '--- full (ungrepped, since 60m) ---'; docker logs --since 60m ${container} 2>&1 | grep -av Mongoose | tail -6000; echo '--- tail ---'; docker logs --tail 40 ${container} 2>&1 | grep -av Mongoose`,
                ],
                { timeout: 45_000, maxBuffer: 24 * 1024 * 1024 },
            );
            writeFileSync(
                join(artifactDir, `server-${container}-${label}.log`),
                stdout,
            );
        } catch (err) {
            log.warn(
                `server evidence collection failed for ${container}: ${String(err).slice(0, 120)}`,
            );
        }
    }
    log.info(`server evidence collected into ${artifactDir}`);
}
