import type { KodusSession, RunContext } from './types.js';
import { http, ensureOk } from './http.js';
import { pollUntil } from '../providers/base.js';

/**
 * Execution HEALTH assertion: the review's automation execution must end
 * in `success` — not `partial_error` ("completed with warnings", i.e. an
 * agent or auxiliary stage crashed) and not `error`.
 *
 * Why this exists: a review can still post findings while an entire agent
 * died (observed live: the finder crashing on malformed model output, 9
 * hits/hour on a customer instance, every scenario still green). Output
 * asserts don't see that; only the execution status does.
 */
export async function assertHealthyExecution(
    ctx: RunContext,
    session: KodusSession,
    prNumber: number,
): Promise<string> {
    // The execution row settles shortly after the completion comment is
    // delivered; poll briefly rather than racing it.
    const status = await pollUntil<string>(
        async () => {
            const resp = await http<any>(
                // Param name must match EnrichedPullRequestsQueryDto — the
                // API's global ValidationPipe has forbidNonWhitelisted, so an
                // unknown param (`prNumber`) is a deterministic HTTP 400.
                // That exact typo failed all four license-paid cells of the
                // 2026-07-11 release matrix.
                //
                // `teamId` is required in practice even though the DTO marks
                // it optional: the repository query binds `team.uuid =
                // :teamId` unconditionally, so an absent teamId becomes
                // `team.uuid = NULL` and the listing returns [] for every
                // org (verified live against QA: empty data even with no
                // filters). Without it this assert can never pass.
                `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${prNumber}&teamId=${encodeURIComponent(session.teamId)}&limit=5`,
                {
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 30_000,
                },
            );
            ensureOk(resp, 'executions:list');
            const found = findExecutionStatus(resp.body, prNumber);
            // Keep polling while the execution is still settling.
            if (!found || found === 'pending' || found === 'in_progress') {
                return null;
            }
            return found;
        },
        { intervalSec: 5, timeoutSec: 90 },
    );

    ctx.assert(
        status !== null,
        `No settled automation execution found for PR #${prNumber} within 90s — cannot verify review health`,
    );
    ctx.assert(
        status === 'success',
        `Review of PR #${prNumber} completed UNHEALTHY: execution status is "${status}" ` +
            `(partial_error = an agent or auxiliary stage crashed and its work was silently dropped — ` +
            `the review may still have posted findings from the surviving agents). ` +
            `Check the worker logs for the failing stage/agent.`,
    );
    return status!;
}

/**
 * PERSISTENCE assertion: after a review that produced findings, at least one
 * suggestion must be PERSISTED (readable back from the enriched executions
 * listing's `suggestionsCount.sent`, which is derived from the stored PR
 * record — not the provider comments).
 *
 * Why this exists on top of the output + health asserts: the Immer
 * frozen-object regression (#1522/#1523) posted the review comments on the
 * provider while the mutation that preceded the Mongo write threw and was
 * swallowed — so EVERY review for ~2 days completed "successfully", comments
 * visible, yet nothing was ever persisted. Neither the findings-count assert
 * (reads provider comments) nor the health assert (reads execution status)
 * sees that; only reading persisted suggestions back does. Use on scenarios
 * whose fixture guarantees ≥1 finding (a legit 0-finding review would 0 here).
 */
export async function assertPersistedSuggestions(
    ctx: RunContext,
    session: KodusSession,
    prNumber: number,
): Promise<number> {
    const sent = await pollUntil<number>(
        async () => {
            const resp = await http<any>(
                `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${prNumber}&teamId=${encodeURIComponent(session.teamId)}&limit=5`,
                {
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 30_000,
                },
            );
            ensureOk(resp, 'executions:list');
            const count = findSuggestionsSent(resp.body, prNumber);
            // suggestionsCount is written alongside the execution row; it can
            // lag the completion comment briefly, so keep polling while it is
            // still absent rather than reading a premature 0.
            return count === null ? null : count;
        },
        { intervalSec: 5, timeoutSec: 120 },
    );

    ctx.assert(
        sent !== null,
        `No suggestionsCount surfaced for PR #${prNumber} within 120s — cannot verify persistence`,
    );
    ctx.assert(
        (sent ?? 0) >= 1,
        `Review of PR #${prNumber} posted findings but PERSISTED 0 suggestions ` +
            `(suggestionsCount.sent=${sent}). The comments exist on the provider but ` +
            `nothing reached the store — the Immer frozen-object persistence class ` +
            `(#1522/#1523), where the Mongo write threw after comments were posted ` +
            `and the error was swallowed. Check the create-file-comments stage.`,
    );
    return sent ?? 0;
}

/** Defensive walk: find `suggestionsCount.sent` for the PR number. */
function findSuggestionsSent(node: unknown, prNumber: number): number | null {
    const hits: number[] = [];
    const walk = (n: unknown): void => {
        if (Array.isArray(n)) {
            for (const item of n) walk(item);
            return;
        }
        if (n && typeof n === 'object') {
            const obj = n as Record<string, unknown>;
            const num = obj.prNumber ?? obj.pullRequestNumber ?? obj.number;
            if (Number(num) === prNumber) {
                const sc = obj.suggestionsCount as
                    | Record<string, unknown>
                    | undefined;
                if (sc && typeof sc.sent === 'number') {
                    hits.push(sc.sent);
                }
            }
            for (const v of Object.values(obj)) walk(v);
        }
    };
    walk(node);
    if (!hits.length) return null;
    // Prefer the highest sent across any duplicate execution rows for the PR.
    return Math.max(...hits);
}

/**
 * AutomationStatus values an execution row can carry. The enriched listing's
 * top-level item ALSO has a `status` field — but that one is the PULL
 * REQUEST state ("open"/"merged"/"closed"), with the execution status nested
 * under `automationExecution.status`. Matching any `status` string on the
 * number-matched object returned "open" and flagged every healthy review as
 * UNHEALTHY (found live once the teamId fix made the listing return data).
 */
const EXECUTION_STATUSES = new Set([
    'success',
    'error',
    'partial_error',
    'skipped',
    'pending',
    'in_progress',
]);

/** Defensive walk: find the newest execution status for the PR number. */
function findExecutionStatus(node: unknown, prNumber: number): string | null {
    const hits: string[] = [];
    const walk = (n: unknown): void => {
        if (Array.isArray(n)) {
            for (const item of n) walk(item);
            return;
        }
        if (n && typeof n === 'object') {
            const obj = n as Record<string, unknown>;
            const num = obj.prNumber ?? obj.pullRequestNumber ?? obj.number;
            if (Number(num) === prNumber) {
                const exec = obj.automationExecution as
                    | Record<string, unknown>
                    | undefined;
                if (exec && typeof exec.status === 'string' && exec.status) {
                    hits.push(exec.status);
                } else if (
                    typeof obj.status === 'string' &&
                    EXECUTION_STATUSES.has(obj.status)
                ) {
                    // Fallback for shapes where the execution status is
                    // flat on the matched object — but never PR states
                    // like "open"/"merged".
                    hits.push(obj.status);
                }
            }
            for (const v of Object.values(obj)) walk(v);
        }
    };
    walk(node);
    if (!hits.length) return null;
    // A single PR can carry MULTIPLE execution rows (verified live on the
    // QA gitlab tenant: a duplicate/synchronize event adds a newer `skipped`
    // row next to the real review's `success`). Health is about the review
    // execution, so prefer a success anywhere over incidental skips, then
    // real failures, then skips; still-running rows keep the poll alive
    // only when nothing terminal exists.
    for (const preferred of ['success', 'partial_error', 'error', 'skipped']) {
        if (hits.includes(preferred)) return preferred;
    }
    return hits.every((h) => h === 'pending' || h === 'in_progress')
        ? null
        : hits[0];
}
