import type { KodusSession, RunContext } from './types.js';
import { http, ensureOk } from './http.js';
import { pollUntil, settle } from '../providers/base.js';

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
/**
 * Wait until the PR's in-flight automation has SETTLED, so a follow-up
 * trigger is not refused as a duplicate.
 *
 * Opening a PR starts an automation that takes a per-PR distributed lock
 * (`CODE_REVIEW:<org>:<repo>:<pr>`, 60s TTL) before the pipeline decides
 * anything -- including before it decides to skip. Anything arriving while
 * that lock is held is answered with "Code review already being processed"
 * and dropped, with no retry.
 *
 * Best effort by design: if no automation row ever appears, there is nothing
 * holding the lock and the caller should proceed. This waits for a fact
 * instead of sleeping a fixed interval, which is what made the same scenario
 * pass on fast providers and fail on bitbucket (#1699).
 */
export async function waitForAutomationToSettle(
    ctx: RunContext,
    session: KodusSession,
    prNumber: number,
    opts: { timeoutSec?: number } = {},
): Promise<string | null> {
    const settled = await pollUntil<string>(
        async () => {
            const resp = await http<any>(
                `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${prNumber}&teamId=${encodeURIComponent(session.teamId)}&limit=5`,
                {
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 30_000,
                },
            );
            if (resp.status < 200 || resp.status >= 300) return null;
            // null here means "nothing terminal yet" -- either no row at all
            // or one still running. Both mean: keep waiting.
            return findExecutionStatus(resp.body, prNumber);
        },
        { intervalSec: 5, timeoutSec: opts.timeoutSec ?? 120 },
    );

    // The execution row is written just BEFORE the lock is released (the
    // release lives in the finally that runs after completion), so settling
    // is not quite the same instant as the lock being free.
    if (settled) await settle(3_000);
    return settled;
}

export async function assertHealthyExecution(
    ctx: RunContext,
    session: KodusSession,
    prNumber: number,
): Promise<string> {
    // The execution row settles shortly after the completion comment is
    // delivered; poll briefly rather than racing it.
    //
    // A non-success terminal status must NOT end the poll early: a PR can
    // grow execution rows one at a time, and the row the scenario cares
    // about can land AFTER an incidental one. Observed live (2026-07-29,
    // cloud command-review PR#672): the auto-review row — `skipped` BY
    // DESIGN, the scenario disables auto-review to test the command — was
    // visible 3s before the command's `success` row landed, and the old
    // first-terminal-wins read failed the cell against a perfectly healthy
    // review. Keep polling on non-success; only the timeout turns the
    // last-seen status into the verdict.
    let lastSeen: string | null = null;
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
            if (found !== 'success') {
                lastSeen = found;
                return null;
            }
            return found;
        },
        { intervalSec: 5, timeoutSec: 90 },
    );

    const finalStatus = status ?? lastSeen;
    ctx.assert(
        finalStatus !== null,
        `No settled automation execution found for PR #${prNumber} within 90s — cannot verify review health`,
    );
    // The explanation has to match the status we actually saw. It used to
    // describe partial_error unconditionally, so a run that observed
    // "skipped" was handed a paragraph about crashed agents and sent whoever
    // read it looking for a stage failure that never happened.
    const STATUS_MEANING: Record<string, string> = {
        partial_error:
            'an agent or auxiliary stage crashed and its work was silently dropped — ' +
            'the review may still have posted findings from the surviving agents',
        skipped:
            'the product declined to review this PR — most often a review was ' +
            'ALREADY in flight for it (duplicate trigger), or no active ' +
            'code-review automation matched',
        error: 'the pipeline failed outright',
    };
    const meaning = STATUS_MEANING[finalStatus as string];
    ctx.assert(
        finalStatus === 'success',
        `Review of PR #${prNumber} completed UNHEALTHY: execution status stayed "${finalStatus}" ` +
            `through the full 90s window with no success row` +
            (meaning ? ` (${finalStatus} = ${meaning})` : '') +
            `. Check the worker logs for the failing stage/agent.`,
    );
    return finalStatus!;
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
export function findExecutionStatus(
    node: unknown,
    prNumber: number,
): string | null {
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

    // A single PR can carry MULTIPLE execution rows: a duplicate delivery adds
    // a `skipped` row next to the real review (seen on the QA gitlab tenant,
    // and on every bitbucket run — bitbucket delivers the @kody comment
    // webhook twice and the product correctly dedupes the second).
    //
    // Success anywhere wins: the review happened, and an incidental skip
    // alongside it is not a health problem.
    if (hits.includes('success')) return 'success';

    // Nothing succeeded YET, but something is still running -- so the answer
    // is "not yet", not "skipped". This ordering is the bug that failed
    // command-review on bitbucket twice (#1699): the preference list below
    // used to be consulted first, so a duplicate's `skipped` row outranked
    // the real review still in flight, and the poll verdicted `skipped` at
    // 90s while the review it was waiting for was still running.
    if (hits.some((h) => h === 'pending' || h === 'in_progress')) return null;

    // Nothing running and nothing succeeded: report the worst terminal row,
    // preferring real failures over incidental skips.
    for (const preferred of ['partial_error', 'error', 'skipped']) {
        if (hits.includes(preferred)) return preferred;
    }
    return hits[0];
}
