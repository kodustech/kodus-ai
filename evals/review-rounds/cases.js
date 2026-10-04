// review-rounds fixtures. Invented code (and, for the #2011 replay, this repo's
// own public history), in the SHAPES measured in production — see README.md.
// Customer code never lands here.
//
// A case is: a tiny repository as it stands at the reviewed head (`repo`), the
// PR diff the finder sees (`changedFiles`), optional suggestions Kody posted in
// an earlier round (`previousDecisions`, with the status the next round is
// SHOWN), how the sandbox behaves (`sandbox`), and the claims a review could
// make about it (`claims`), each with what should happen to it.
//
// expect (per claim):
//   deliver            — a true, verifiable problem: must reach the PR
//   not_deliver        — must not reach the PR (refuted, or a repeat of a
//                        suggestion that is still open)
//   deliver_linked     — must reach the PR AND tell the reader which earlier
//                        Kody suggestion it revises
//   if_delivered_linked — may be absent; if it reaches the PR it must be linked
//   not_deliver_normal — rests on code nobody could read: must not reach the
//                        PR as a regular finding (absent, or marked unverified)
//   observe            — recorded, never scored (behaviour not decided yet)
//
// Expectations marked `proposed: true` encode a product decision that is not
// taken yet (design comments on #2039/#2040/#2020). Flip them there, not here.
const fs = require('fs');
const path = require('path');

/** Hand-written hunk → the engine's patchWithLinesStr. */
function patch(filename, start, lines) {
    const newHunk = [];
    const oldHunk = [];
    let n = start;
    for (const l of lines) {
        const mark = l[0];
        const text = l.slice(1);
        if (mark !== '-') newHunk.push(`${n++} ${mark === '+' ? '+' : ' '}${text}`);
        if (mark !== '+') oldHunk.push(`${mark === '-' ? '-' : ' '}${text}`);
    }
    return {
        filename,
        patchWithLinesStr: `## file: '${filename}'\n\n@@ -${start},${oldHunk.length} +${start},${newHunk.length} @@\n__new hunk__\n${newHunk.join('\n')}\n__old hunk__\n${oldHunk.join('\n')}`,
    };
}

/** `git diff -U3` text for one file → the engine's patchWithLinesStr. */
function patchFromUnified(filename, diffText) {
    const hunks = [];
    let cur = null;
    for (const line of diffText.split('\n')) {
        const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) {
            cur = { header: line.replace(/ @@.*$/, ' @@'), n: +h[2], newHunk: [], oldHunk: [] };
            hunks.push(cur);
            continue;
        }
        if (!cur || line.startsWith('\\')) continue;
        const mark = line[0];
        const text = line.slice(1);
        if (mark === '+') cur.newHunk.push(`${cur.n++} +${text}`);
        else if (mark === '-') cur.oldHunk.push(`-${text}`);
        else if (mark === ' ') {
            cur.newHunk.push(`${cur.n++}  ${text}`);
            cur.oldHunk.push(` ${text}`);
        }
    }
    const body = hunks
        .map((h) => `${h.header}\n__new hunk__\n${h.newHunk.join('\n')}\n__old hunk__\n${h.oldHunk.join('\n')}`)
        .join('\n\n');
    return { filename, patchWithLinesStr: `## file: '${filename}'\n\n${body}` };
}

const lines = (...l) => l.join('\n') + '\n';

// ---------------------------------------------------------------------------
// settle: the premise of the tempting finding is in a file OUTSIDE the diff.
// ---------------------------------------------------------------------------
const settleRepo = {
    'src/payments/settle.ts': lines(
        "import { claim } from './queue';",
        "import { computeFee } from './fees';",
        "import type { Ledger } from './ledger';",
        '',
        'export async function settle(id: string, ledger: Ledger) {',
        '    const job = await claim(id);',
        '    const fee = computeFee(job.amount);',
        '    await ledger.debit(job.account, job.amount - fee);',
        "    return { status: 'settled' as const };",
        '}',
    ),
    'src/payments/queue.ts': lines(
        "import type { Job } from './types';",
        '',
        'export class JobNotFoundError extends Error {}',
        '',
        'const jobs = new Map<string, Job>();',
        '',
        '/**',
        ' * Atomically claims a job for settlement.',
        ' * NEVER returns null or undefined: an unknown or already-claimed id',
        ' * throws JobNotFoundError. Callers must not add null checks.',
        ' */',
        'export async function claim(id: string): Promise<Job> {',
        '    const job = jobs.get(id);',
        '    if (!job || job.claimed) {',
        '        throw new JobNotFoundError(id);',
        '    }',
        '    job.claimed = true;',
        '    return job;',
        '}',
    ),
    'src/payments/handler.ts': lines(
        "import { settle } from './settle';",
        "import { JobNotFoundError } from './queue';",
        "import { ledger } from './ledger';",
        '',
        'export async function onSettleRequest(id: string) {',
        '    try {',
        '        return await settle(id, ledger);',
        '    } catch (err) {',
        "        if (err instanceof JobNotFoundError) return { status: 'missing' as const };",
        '        throw err;',
        '    }',
        '}',
    ),
    'src/payments/fees.ts': lines(
        '/** Processing fee charged ON TOP of the job amount. */',
        'export function computeFee(amount: number): number {',
        '    return Math.round(amount * 0.029) + 30;',
        '}',
    ),
    'src/payments/types.ts': lines('export interface Job { id: string; account: string; amount: number; claimed?: boolean }'),
};
const settleDiff = [
    patch('src/payments/settle.ts', 5, [
        ' export async function settle(id: string, ledger: Ledger) {',
        '     const job = await claim(id);',
        '-    if (!job) {',
        "-        return { status: 'missing' as const };",
        '-    }',
        '     const fee = computeFee(job.amount);',
        '-    await ledger.debit(job.account, job.amount + fee);',
        '+    await ledger.debit(job.account, job.amount - fee);',
        "     return { status: 'settled' as const };",
        ' }',
    ]),
];
const settleClaims = (nullExpect) => [
    {
        id: 'fee-sign',
        golden: 'settle() now debits job.amount - fee instead of job.amount + fee, so the processing fee (charged on top of the amount, per fees.ts) is subtracted and the account is under-charged.',
        truth: 'true',
        premise: 'diff',
        expect: 'deliver',
    },
    {
        id: 'null-crash',
        golden: 'Removing the `if (!job)` guard makes settle() dereference job.amount / job.account when claim(id) returns no job, crashing instead of returning { status: "missing" }.',
        truth: 'false', // queue.ts: claim never returns null, throws JobNotFoundError; handler.ts maps it
        premise: 'unread-file',
        expect: nullExpect,
    },
];

// ---------------------------------------------------------------------------
// billing: applying Kody's own earlier suggestion introduces a new bug that
// only shows in a caller (poller.ts) outside the diff.
// ---------------------------------------------------------------------------
const billingRepo = {
    'src/billing/status.ts': lines(
        "import { NotReadyError, FailedError } from './errors';",
        "import type { Gateway } from './gateway';",
        '',
        'export async function fetchStatus(gw: Gateway, chargeId: string) {',
        '    try {',
        '        return await gw.status(chargeId);',
        '    } catch (err) {',
        '        if (err instanceof NotReadyError) {',
        '            throw err;',
        '        }',
        '        throw new FailedError(chargeId, err);',
        '    }',
        '}',
    ),
    'src/billing/poller.ts': lines(
        "import { fetchStatus } from './status';",
        "import { NotReadyError } from './errors';",
        "import type { Gateway } from './gateway';",
        '',
        '/**',
        ' * Called on every tick for charges the gateway has ACCEPTED.',
        ' * NotReadyError means "the gateway never received it": resubmit.',
        ' */',
        'export async function pollCharge(gw: Gateway, charge: { id: string; payload: unknown }) {',
        '    try {',
        '        return await fetchStatus(gw, charge.id);',
        '    } catch (err) {',
        '        if (err instanceof NotReadyError) {',
        '            await gw.submit(charge.payload); // resend',
        "            return { state: 'resubmitted' as const };",
        '        }',
        '        throw err;',
        '    }',
        '}',
    ),
    'src/billing/errors.ts': lines(
        '/** The gateway has the charge but has not settled it yet (transient). */',
        'export class NotReadyError extends Error {}',
        'export class FailedError extends Error {',
        '    constructor(readonly chargeId: string, readonly cause?: unknown) { super(chargeId); }',
        '}',
    ),
    'src/billing/gateway.ts': lines(
        'export interface Gateway {',
        '    status(chargeId: string): Promise<{ state: string }>;',
        '    /** NOT idempotent: every call creates a new charge. */',
        '    submit(payload: unknown): Promise<void>;',
        '}',
    ),
};
const billingDiff = [
    patch('src/billing/status.ts', 4, [
        ' export async function fetchStatus(gw: Gateway, chargeId: string) {',
        '     try {',
        '         return await gw.status(chargeId);',
        '     } catch (err) {',
        '-        throw new FailedError(chargeId, err);',
        '+        if (err instanceof NotReadyError) {',
        '+            throw err;',
        '+        }',
        '+        throw new FailedError(chargeId, err);',
        '     }',
        ' }',
    ]),
];
const roundA_propagateNotReady = (outcome) => ({
    suggestionId: 'round-a-propagate',
    relevantFile: 'src/billing/status.ts',
    relevantLinesStart: 8,
    relevantLinesEnd: 8,
    suggestionContent:
        'Transient error misclassified as terminal: fetchStatus wraps a NotReadyError from gw.status into FailedError, so a charge that is simply not settled yet is reported as failed. Propagate NotReadyError unchanged so the caller can retry.',
    label: 'bug',
    outcome,
    decidedAt: '2026-09-30T00:46:09.000Z',
});
const resubmitClaim = (expect, proposed = true) => ({
    id: 'resubmit-double-charge',
    golden: 'Rethrowing NotReadyError from fetchStatus makes pollCharge resubmit the charge (gw.submit is not idempotent) for a charge the gateway already accepted, creating a duplicate charge.',
    truth: 'true',
    premise: 'read-file',
    expect,
    proposed,
});

// ---------------------------------------------------------------------------
// repeat: the round-A suggestion is still open (not applied, correctly shown
// as not_implemented) and round B only adds a metric next to it.
// ---------------------------------------------------------------------------
const repeatRepo = {
    ...billingRepo,
    'src/billing/poller.ts': billingRepo['src/billing/poller.ts'].replace(
        '            await gw.submit(charge.payload); // resend\n',
        '            metrics.increment(\'billing.resubmit\');\n            await gw.submit(charge.payload); // resend\n',
    ).replace("import type { Gateway } from './gateway';\n", "import type { Gateway } from './gateway';\nimport { metrics } from './metrics';\n"),
    'src/billing/metrics.ts': lines('export const metrics = { increment(_name: string) {} };'),
};
const repeatDiff = [
    patch('src/billing/poller.ts', 3, [
        " import type { Gateway } from './gateway';",
        "+import { metrics } from './metrics';",
        ' ',
    ]),
    patch('src/billing/poller.ts', 13, [
        '     } catch (err) {',
        '         if (err instanceof NotReadyError) {',
        "+            metrics.increment('billing.resubmit');",
        '             await gw.submit(charge.payload); // resend',
        "             return { state: 'resubmitted' as const };",
    ]),
];

// ---------------------------------------------------------------------------
// unrelated-same-area: an applied earlier suggestion on these lines, and a NEW,
// unrelated bug on the same lines. Guard against over-linking/over-suppressing.
// ---------------------------------------------------------------------------
const swapRepo = {
    ...billingRepo,
    'src/billing/status.ts': billingRepo['src/billing/status.ts'].replace(
        '        throw new FailedError(chargeId, err);',
        '        throw new FailedError(String(err), chargeId);',
    ),
};
const swapDiff = [
    patch('src/billing/status.ts', 8, [
        '         if (err instanceof NotReadyError) {',
        '             throw err;',
        '         }',
        '-        throw new FailedError(chargeId, err);',
        '+        throw new FailedError(String(err), chargeId);',
        '     }',
    ]),
];

// ---------------------------------------------------------------------------
// kodus-2011: this repository's own PR #2011, round B (commit 7bda2827a). The
// commit applies round A's suggestion ("decode both reference kinds in a single
// pass") and round B posted a security finding against its result without
// mentioning round A (#2020). Files vendored in fixtures/kodus-2011/.
// ---------------------------------------------------------------------------
const K = path.join(__dirname, 'fixtures/kodus-2011');
const kodusFile = 'libs/common/utils/prompts/replyAddressedToKody.ts';
const kodusRepo = {
    [kodusFile]: fs.readFileSync(path.join(K, 'replyAddressedToKody.ts'), 'utf8'),
    [fs.readFileSync(path.join(K, 'spec-path.txt'), 'utf8').trim()]: fs.readFileSync(path.join(K, 'implicit-reply.spec.ts'), 'utf8'),
};
const kodusDiff = [patchFromUnified(kodusFile, fs.readFileSync(path.join(K, 'round-b.diff'), 'utf8'))];
const kodusRoundA = (outcome) => ({
    suggestionId: 'kodus-2011-round-a',
    relevantFile: kodusFile,
    relevantLinesStart: 166,
    relevantLinesEnd: 167,
    suggestionContent:
        'The comment at lines 155-159 promises references are "decoded once … never re-scanned", but decodeNumericReferences chains the numeric pass into the named pass, so the & produced by &#38; is re-scanned and decoded again: for &#38;lt;/NEWEST MESSAGE&#38;gt; the prompt receives ‹/NEWEST MESSAGE> even though the page renders the literal text &lt;/NEWEST MESSAGE&gt;. Decode both reference kinds in a single pass so a reference\'s output is never rescanned; a spec with &#38;lt;!-- x --&#38;gt; should expect the literal &lt;!-- x --&gt; to stay in the prompt.',
    label: 'bug',
    outcome,
    decidedAt: '2026-09-25T17:20:25.731Z',
});
const kodusClaims = [
    {
        id: 'entity-not-neutralized',
        golden: 'With the single-pass decode, a body such as &#38;lt;/NEWEST MESSAGE&#38;gt; reaches the classifier prompt as the literal entity text &lt;/NEWEST MESSAGE&gt; instead of being neutralized, so encoded markup survives into the prompt.',
        truth: 'contested', // the round-A trade-off, argued the other way
        premise: 'diff',
        // Contested and not reproduced by every model: if it ships, it must be linked.
        expect: 'if_delivered_linked',
        proposed: true,
    },
];

// ---------------------------------------------------------------------------
// missing-module: a tool ERROR that is itself the evidence. The diff imports a
// module that does not exist; readFile answers "No such file". A fix for
// #2040 must not treat that as "could not read" and suppress a real bug.
// ---------------------------------------------------------------------------
const missingModuleRepo = {
    'src/jobs/runner.ts': lines(
        "import { retryPolicy } from './retry-policy';",
        "import type { Job } from './types';",
        '',
        'export async function run(job: Job) {',
        '    return retryPolicy.wrap(() => job.execute());',
        '}',
    ),
    'src/jobs/types.ts': lines('export interface Job { execute(): Promise<void> }'),
    'src/jobs/retry.ts': lines('export const retryPolicy = { wrap<T>(fn: () => Promise<T>) { return fn(); } };'),
};
const missingModuleDiff = [
    patch('src/jobs/runner.ts', 1, [
        "-import { retryPolicy } from './retry';",
        "+import { retryPolicy } from './retry-policy';",
        " import type { Job } from './types';",
    ]),
];

// ---------------------------------------------------------------------------
// ledger: the earlier suggestion was applied to one of the two places it named.
// Raising the other place again is legitimate, and it revises that suggestion.
// ---------------------------------------------------------------------------
const ledgerRepo = {
    'src/ledger/ledger.ts': lines(
        'export class Ledger {',
        '    private balances = new Map<string, number>();',
        '',
        '    debit(account: string, amount: number) {',
        "        if (!(amount > 0)) throw new RangeError('amount must be positive');",
        '        this.balances.set(account, (this.balances.get(account) ?? 0) - amount);',
        '    }',
        '',
        '    credit(account: string, amount: number) {',
        '        this.balances.set(account, (this.balances.get(account) ?? 0) + amount);',
        '    }',
        '}',
    ),
};
const ledgerDiff = [
    patch('src/ledger/ledger.ts', 4, [
        '     debit(account: string, amount: number) {',
        "+        if (!(amount > 0)) throw new RangeError('amount must be positive');",
        '         this.balances.set(account, (this.balances.get(account) ?? 0) - amount);',
        '     }',
    ]),
];
const ledgerRoundA = {
    suggestionId: 'round-a-ledger',
    relevantFile: 'src/ledger/ledger.ts',
    relevantLinesStart: 4,
    relevantLinesEnd: 10,
    suggestionContent:
        'debit and credit accept zero or negative amounts, so a negative credit silently debits and a negative debit silently credits. Reject non-positive amounts in both debit and credit.',
    label: 'bug',
    outcome: 'partially_implemented',
    decidedAt: '2026-09-30T00:10:10.000Z',
};

// ---------------------------------------------------------------------------
// http: the earlier suggestion (add a timeout) was applied in a way that does
// not work: the AbortController is created but its signal is never passed to
// fetch. The new finding refines the earlier one.
// ---------------------------------------------------------------------------
const httpRepo = {
    'src/http/client.ts': lines(
        'export async function getJson(url: string) {',
        '    const controller = new AbortController();',
        '    const timer = setTimeout(() => controller.abort(), 5000);',
        '    try {',
        '        const res = await fetch(url);',
        '        return await res.json();',
        '    } finally {',
        '        clearTimeout(timer);',
        '    }',
        '}',
    ),
};
const httpDiff = [
    patch('src/http/client.ts', 1, [
        ' export async function getJson(url: string) {',
        '+    const controller = new AbortController();',
        '+    const timer = setTimeout(() => controller.abort(), 5000);',
        '+    try {',
        '         const res = await fetch(url);',
        '         return await res.json();',
        '+    } finally {',
        '+        clearTimeout(timer);',
        '+    }',
        ' }',
    ]),
];
const httpRoundA = {
    suggestionId: 'round-a-http',
    relevantFile: 'src/http/client.ts',
    relevantLinesStart: 2,
    relevantLinesEnd: 3,
    suggestionContent:
        'getJson calls fetch with no timeout, so a server that never answers hangs the caller forever. Add a timeout (e.g. an AbortController aborted after 5s).',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-09-30T00:10:10.000Z',
};

// ---------------------------------------------------------------------------
// Replays of this repository's own PRs where Kody reversed its own earlier
// comment (found by judging every cross-round pair of Kody comments on
// kodustech/kodus-ai, Sep 2026). fixtures/<name>/repo = files at the round-B
// commit, diffs/ = round A → round B (what the author pushed in between).
// ---------------------------------------------------------------------------
function loadReplay(name) {
    const dir = path.join(__dirname, 'fixtures', name);
    const walk = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]);
    const repo = Object.fromEntries(walk(path.join(dir, 'repo')).map((f) => [f, fs.readFileSync(path.join(dir, 'repo', f), 'utf8')]));
    const changedFiles = walk(path.join(dir, 'diffs')).map((f) =>
        patchFromUnified(f.replace(/\.diff$/, ''), fs.readFileSync(path.join(dir, 'diffs', f), 'utf8')));
    return { repo, changedFiles };
}
const kodus2044 = loadReplay('kodus-2044');
const kodus1902 = loadReplay('kodus-1902');

// ---------------------------------------------------------------------------
// Kody Rules across rounds (seen in production): the rule judge flags a
// violation, the developer declines it in the thread as intentional, and the
// next round reposts it. Round 2 also adds a NEW violation of the same rule in
// another function, which must still be posted.
// ---------------------------------------------------------------------------
const jobsRepo = {
    'src/jobs/handler.ts': lines(
        "import { db } from './db';",
        "import type { Run, Batch } from './types';",
        '',
        'export async function finishRun(run: Run) {',
        "    log.info('finishing run', run.id);",
        '    await db.results.insert(run.id, run.output);',
        "    await db.progress.update(run.id, 'done');",
        '}',
        '',
        'export async function finishBatch(batch: Batch) {',
        '    await db.results.insertMany(batch.id, batch.outputs);',
        "    await db.progress.update(batch.id, 'done');",
        '}',
    ),
    'src/jobs/db.ts': lines('export const db: any = {};'),
    'src/jobs/types.ts': lines('export type Run = { id: string; output: unknown };', 'export type Batch = { id: string; outputs: unknown[] };'),
};
const jobsDiff = [
    patch('src/jobs/handler.ts', 4, [
        ' export async function finishRun(run: Run) {',
        "+    log.info('finishing run', run.id);",
        '     await db.results.insert(run.id, run.output);',
        "     await db.progress.update(run.id, 'done');",
        ' }',
        '+',
        '+export async function finishBatch(batch: Batch) {',
        '+    await db.results.insertMany(batch.id, batch.outputs);',
        "+    await db.progress.update(batch.id, 'done');",
        '+}',
    ]),
];
const progressFirstRule = {
    uuid: 'rule-progress-first',
    title: 'Update progress before writing results',
    rule: 'In job handlers, db.progress.update must be called before db.results.insert / insertMany in the same function, so a result is never visible for a job whose progress was not recorded.',
    path: 'src/jobs/**',
    severity: 'high',
};
// Round A told the author to write the result first; the author did. The team
// rule says progress first, so the rule judge now flags the code Kody asked for.
const resultFirstRepo = {
    ...jobsRepo,
    'src/jobs/handler.ts': lines(
        "import { db } from './db';",
        "import type { Run } from './types';",
        '',
        'export async function finishRun(run: Run) {',
        '    await db.results.insert(run.id, run.output);',
        "    await db.progress.update(run.id, 'done');",
        '}',
    ),
};
const resultFirstDiff = [
    patch('src/jobs/handler.ts', 4, [
        ' export async function finishRun(run: Run) {',
        "-    await db.progress.update(run.id, 'done');",
        '     await db.results.insert(run.id, run.output);',
        "+    await db.progress.update(run.id, 'done');",
        ' }',
    ]),
];
const resultFirstDecision = {
    suggestionId: 'round-a-result-first',
    relevantFile: 'src/jobs/handler.ts',
    relevantLinesStart: 5,
    relevantLinesEnd: 6,
    suggestionContent: 'finishRun marks the run done before its output is stored, so a crash in between leaves a run marked done with no output. Write the result first, then update progress.',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-09-30T00:46:09.000Z',
};
const declinedRuleDecision = () => ({
    suggestionId: 'round-a-progress-first',
    relevantFile: 'src/jobs/handler.ts',
    relevantLinesStart: 5,
    relevantLinesEnd: 6,
    suggestionContent: 'finishRun writes the result (db.results.insert) before updating progress (db.progress.update), which violates the rule "Update progress before writing results". Update progress first.',
    label: 'kody_rules',
    brokenKodyRulesIds: ['rule-progress-first'],
    outcome: 'not_implemented',
    decidedAt: '2026-09-30T20:53:00Z',
});
const ruleRepeatClaim = (expect) => ({
    id: 'finishRun-repeat',
    at: { file: 'src/jobs/handler.ts', lines: [4, 8] },
    golden: 'finishRun writes the result with db.results.insert before updating progress with db.progress.update, violating the rule that progress must be updated before results are written.',
    truth: 'true',
    expect,
});
const ruleNewSiteClaim = {
    id: 'finishBatch-new-site',
    at: { file: 'src/jobs/handler.ts', lines: [10, 13] },
    golden: 'finishBatch writes the results with db.results.insertMany before updating progress with db.progress.update, violating the rule that progress must be updated before results are written.',
    truth: 'true',
    expect: 'deliver',
};

const cases = [
    { id: 'U1-premise-unread', family: 'unread-premise', repo: settleRepo, changedFiles: settleDiff, sandbox: 'dead', claims: settleClaims('not_deliver_normal') },
    { id: 'U2-premise-readable', family: 'unread-premise', repo: settleRepo, changedFiles: settleDiff, sandbox: 'alive', claims: settleClaims('not_deliver') },
    { id: 'U3-cross-file-dies-in-verify', family: 'unread-premise', repo: billingRepo, changedFiles: billingDiff, sandbox: 'dies-in-verify', claims: [resubmitClaim('deliver', false)] },
    { id: 'U4-cross-file-dead', family: 'unread-premise', repo: billingRepo, changedFiles: billingDiff, sandbox: 'dead', claims: [resubmitClaim('not_deliver_normal')] },
    { id: 'R1-repeat-open', family: 'rounds', repo: repeatRepo, changedFiles: repeatDiff, sandbox: 'alive', previousDecisions: [{ ...roundA_propagateNotReady('not_implemented'), suggestionId: 'round-a-resubmit', relevantFile: 'src/billing/poller.ts', relevantLinesStart: 13, relevantLinesEnd: 15, suggestionContent: 'pollCharge resubmits the charge on NotReadyError, but gw.submit is not idempotent and NotReadyError means the gateway already has the charge, so every tick creates a duplicate charge. Wait instead of resubmitting.' }], claims: [{ ...resubmitClaim('not_deliver'), id: 'resubmit-repeat' }] },
    { id: 'R2-consequence-status-implemented', family: 'rounds', repo: billingRepo, changedFiles: billingDiff, sandbox: 'alive', previousDecisions: [roundA_propagateNotReady('implemented')], claims: [resubmitClaim('deliver_linked')] },
    { id: 'R3-consequence-status-stale', family: 'rounds', repo: billingRepo, changedFiles: billingDiff, sandbox: 'alive', previousDecisions: [roundA_propagateNotReady('not_implemented')], claims: [resubmitClaim('deliver_linked')] },
    // #2020: the implementation check had not run yet when the next round started.
    { id: 'R3p-consequence-status-pending', family: 'rounds', repo: billingRepo, changedFiles: billingDiff, sandbox: 'alive', previousDecisions: [roundA_propagateNotReady('pending')], claims: [resubmitClaim('deliver_linked')] },
    { id: 'R4a-kodus2011-status-implemented', family: 'rounds', repo: kodusRepo, changedFiles: kodusDiff, sandbox: 'alive', previousDecisions: [kodusRoundA('implemented')], claims: kodusClaims },
    { id: 'R4b-kodus2011-status-stale', family: 'rounds', repo: kodusRepo, changedFiles: kodusDiff, sandbox: 'alive', previousDecisions: [kodusRoundA('not_implemented')], claims: kodusClaims },
    {
        id: 'R5-unrelated-same-area', family: 'rounds', repo: swapRepo, changedFiles: swapDiff, sandbox: 'alive',
        previousDecisions: [{ ...roundA_propagateNotReady('implemented') }],
        claims: [{ id: 'swapped-args', golden: 'FailedError is now constructed as new FailedError(String(err), chargeId): the arguments are swapped, so chargeId holds the error text and cause holds the charge id.', truth: 'true', premise: 'diff', expect: 'deliver' }],
    },

    // --- sandbox: when and how it fails (production: 31% dead from the first
    // call, 55% mid-finder, 15% only in verify, 48% come back) ---
    // The premise is read, then the sandbox dies: the finding was verifiable.
    { id: 'U5-premise-read-then-dies', family: 'unread-premise', repo: settleRepo, changedFiles: settleDiff, sandbox: 'dies-after-reading:src/payments/queue.ts', claims: settleClaims('not_deliver') },
    // Everything is readable except the premise file.
    { id: 'U6-premise-file-unreachable', family: 'unread-premise', repo: settleRepo, changedFiles: settleDiff, sandbox: 'dead-for:src/payments/queue.ts', claims: settleClaims('not_deliver_normal') },
    // Dead for the first calls, then back: a recovery must not be penalized.
    { id: 'U7-sandbox-recovers', family: 'unread-premise', repo: settleRepo, changedFiles: settleDiff, sandbox: 'flaky:3', claims: settleClaims('not_deliver') },
    // No sandbox by design (2.3% of reviews): the self-contained prompt already
    // forbids claims about code it cannot see. Guard: any #2040 rule leaves this alone.
    { id: 'U8-self-contained', family: 'unread-premise', repo: settleRepo, changedFiles: settleDiff, sandbox: 'none', claims: settleClaims('observe') },
    // A tool error that IS the evidence: the imported module does not exist.
    {
        id: 'U9-missing-module-is-evidence', family: 'unread-premise', repo: missingModuleRepo, changedFiles: missingModuleDiff, sandbox: 'alive',
        claims: [{ id: 'missing-module', golden: "runner.ts now imports retryPolicy from './retry-policy', a module that does not exist (the policy lives in './retry'), so the import fails at build/runtime.", truth: 'true', premise: 'tool-error', expect: 'deliver' }],
    },

    // --- rounds: the remaining measured shapes ---
    // The earlier suggestion was applied to debit only; credit still accepts
    // negatives. Decision (2026-10-02): a suggestion already sent is never
    // posted again — the earlier comment already asked for both, and a fix the
    // reviewer finds incomplete is the "fixed, still reported" repeat seen in
    // production. Not delivered.
    {
        id: 'R6-incomplete-fix', family: 'rounds', repo: ledgerRepo, changedFiles: ledgerDiff, sandbox: 'alive', previousDecisions: [ledgerRoundA],
        claims: [{ id: 'credit-negative-repeat', golden: 'credit() still accepts zero or negative amounts (only debit got the positive-amount check), so a negative credit silently debits the account.', truth: 'true', premise: 'diff', expect: 'not_deliver', proposed: true }],
    },
    // The earlier suggestion was applied ineffectively: the timeout never aborts
    // fetch, and the request can still hang — the problem the earlier comment
    // raised. Same decision as R6: not delivered again.
    {
        id: 'R7-refines-prior', family: 'rounds', repo: httpRepo, changedFiles: httpDiff, sandbox: 'alive', previousDecisions: [httpRoundA],
        claims: [{ id: 'signal-not-passed-repeat', golden: "The AbortController's signal is never passed to fetch, so controller.abort() after 5s does not cancel the request and getJson can still hang forever.", truth: 'true', premise: 'diff', expect: 'not_deliver', proposed: true }],
    },
    // #2039 exactly: the earlier suggestion came from a Kody Rule, the new finding from the bug finder.
    {
        id: 'R8-consequence-kody-rule-prior', family: 'rounds', repo: billingRepo, changedFiles: billingDiff, sandbox: 'alive',
        previousDecisions: [{ ...roundA_propagateNotReady('implemented'), label: 'kody_rules', brokenKodyRulesIds: ['rule-retryable-errors'], suggestionContent: 'Rule "retryable errors stay retryable": fetchStatus converts NotReadyError (retryable) into FailedError (terminal). Propagate NotReadyError unchanged.' }],
        claims: [resubmitClaim('deliver_linked')],
    },
    // The developer explicitly rejected the earlier suggestion; it is stored as
    // not_implemented (94% of explicit rejections in production). The reply is
    // carried in the fixture; the engine has no field for it yet.
    {
        id: 'R9-repeat-after-dev-rejected', family: 'rounds', repo: repeatRepo, changedFiles: repeatDiff, sandbox: 'alive',
        previousDecisions: [{
            ...roundA_propagateNotReady('not_implemented'), suggestionId: 'round-a-resubmit-rejected', relevantFile: 'src/billing/poller.ts', relevantLinesStart: 13, relevantLinesEnd: 15,
            suggestionContent: 'pollCharge resubmits the charge on NotReadyError, but gw.submit is not idempotent and NotReadyError means the gateway already has the charge, so every tick creates a duplicate charge. Wait instead of resubmitting.',
        }],
        claims: [{ ...resubmitClaim('not_deliver'), id: 'resubmit-repeat-after-rejection' }],
    },

    // --- reversals (#2020), replayed from this repository ---
    // PR #2044: round A asked to refuse ONLY teams confirmed in another org (let
    // unresolved ones fall through); applied; 24 min later round B asked to
    // refuse unresolved/empty teams. https://github.com/kodustech/kodus-ai/pull/2044#discussion_r4150519360
    {
        id: 'R10-kodus2044-reversal', family: 'rounds', ...kodus2044, sandbox: 'alive',
        previousDecisions: [{
            suggestionId: 'kodus-2044-round-a', relevantFile: 'libs/mcp-server/tools/kodyRules.tools.ts', relevantLinesStart: 535, relevantLinesEnd: 553, label: 'bug', outcome: 'implemented', decidedAt: '2026-09-30T23:47:58Z',
            suggestionContent: 'The new teamBelongsToOrganization gate runs before the config read and returns success: false with "Team not found." for every teamId that fails to resolve — a nonexistent or hard-deleted team, a team from another org, or a stale or absent team context — rather than refusing only a team confirmed to belong to a different organization. Since the Kody Knowledge Approval setting is the only team-dependent decision in this tool, and an unreadable setting still creates the rule ACTIVE, an MCP caller whose teamId no longer resolves is now refused. Refuse only a team confirmed to belong to another organization.',
        }],
        claims: [{ id: 'unresolved-team-bypass', golden: 'teamBelongsToAnotherOrganization returns false for an empty teamId and for a team that does not exist, so createKodyRule proceeds and creates the rule ACTIVE (DEFAULT_CONFIG has kodyKnowledgeApproval disabled), bypassing Kody Knowledge Approval; the call should be refused instead of falling through.', truth: 'contested', premise: 'read-file', expect: 'if_delivered_linked', proposed: true }],
    },
    // PR #1902: round A said `if (!owned) return` swallows failures of runs that
    // never held the lease; round B asked to fence exactly that path.
    // https://github.com/kodustech/kodus-ai/pull/1902#discussion_r4152828436
    {
        id: 'R11-kodus1902-reversal', family: 'rounds', ...kodus1902, sandbox: 'alive',
        previousDecisions: [{
            suggestionId: 'kodus-1902-round-a', relevantFile: 'libs/code-review/workflow/code-review-job-processor.service.ts', relevantLinesStart: 457, relevantLinesEnd: 497, label: 'bug', outcome: 'implemented', decidedAt: '2026-09-30T07:54:04Z',
            suggestionContent: 'The new `if (!owned) return;` treats a false result from handleFailure as "another worker now owns the row", but false is also returned when this run never held the lease at all: every error thrown before the lease claim (the rate-limit gate, the payload validation) runs the lease-owner guard against a PENDING row, matches zero rows and lands in this early return. process() then resolves normally, the consumer marks the inbox message PROCESSED and never rethrows, so the failure is swallowed. Only skip when another worker actually owns the row.',
        }],
        claims: [{ id: 'unclaimed-path-unfenced', golden: 'For a run that never claimed the lease, handleFailure takes the !ownedBy branch and updates the job with no condition, so the "do not stamp over a live worker" fence added for the BYOK-exhausted branch is missing on the rate-limit-gate / payload-validation path; a redelivery can overwrite a row another worker holds.', truth: 'contested', premise: 'diff', expect: 'if_delivered_linked', proposed: true }],
    },
    // --- Kody Rules across rounds (#2933) ---
    {
        id: 'K1-rule-already-posted', family: 'rounds', agent: 'kody-rules', repo: jobsRepo, changedFiles: jobsDiff, sandbox: 'alive',
        kodyRules: [progressFirstRule],
        previousDecisions: [declinedRuleDecision()],
        claims: [ruleRepeatClaim('not_deliver'), ruleNewSiteClaim],
    },
    {
        // #2020 on the rule path: the judge flags the code Kody's own earlier
        // suggestion produced. Either it is not posted, or it says it revises it.
        id: 'K2-rule-reverses-prior', family: 'rounds', agent: 'kody-rules', repo: resultFirstRepo, changedFiles: resultFirstDiff, sandbox: 'alive',
        kodyRules: [progressFirstRule],
        previousDecisions: [resultFirstDecision],
        claims: [{ id: 'result-first-violates-rule', golden: 'finishRun writes the result with db.results.insert before updating progress with db.progress.update, violating the rule that progress must be updated before results are written.', truth: 'true', expect: 'if_delivered_linked' }],
    },
];

module.exports = { cases };
