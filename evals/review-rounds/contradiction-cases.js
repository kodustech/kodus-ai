// #2676: later rounds reversed or re-raised Kody's own earlier suggestions.
// Invented code in the shapes of kodus-ai#2663 and the production sample on
// the issue. Each repeat or reversal case keeps its diff fixed; only the
// history, the repeat check's health or the review mode changes.

const lines = (...l) => l.join('\n') + '\n';

function patch(filename, start, body) {
    const mark = (l) => (l[0] === '+' || l[0] === '-' ? l[0] : ' ');
    const oldCount = body.filter((l) => mark(l) !== '+').length;
    const newCount = body.filter((l) => mark(l) !== '-').length;
    return {
        filename,
        patch: `@@ -${start},${oldCount} +${start},${newCount} @@\n${body.map((l) => `${mark(l)}${l.slice(1)}`).join('\n')}`,
    };
}

// ---------------------------------------------------------------------------
// #2663: round A asked to refuse a config listed on another host; applied,
// with the intent stated beside the code. The bait: a config whose stored
// host went stale after an instance moved is now skipped, and the caller drops
// the event, which reads as data loss.
// ---------------------------------------------------------------------------
const hostRepo = {
    'src/webhooks/config-lookup.ts': lines(
        "import type { RepoConfig } from './types';",
        '',
        '/**',
        ' * A config whose listed repository host is not the sending host belongs to',
        ' * another instance of the same repository and is never taken, even when the',
        ' * repository id matches.',
        ' */',
        'export function findConfig(configs: RepoConfig[], repositoryId: string, host: string): RepoConfig | undefined {',
        '    return configs.find(',
        '        (c) => c.repositoryId === repositoryId && (c.hosts.length === 0 || c.hosts.includes(host)),',
        '    );',
        '}',
    ),
    'src/webhooks/types.ts': lines(
        'export interface RepoConfig {',
        '    repositoryId: string;',
        '    hosts: string[];',
        '    teamId: string;',
        '}',
        'export interface PushEvent {',
        '    repositoryId: string;',
        '    host: string;',
        '    sha: string;',
        '}',
    ),
    'src/webhooks/push.handler.ts': lines(
        "import { findConfig } from './config-lookup';",
        "import type { PushEvent, RepoConfig } from './types';",
        '',
        'export function handlePush(event: PushEvent, configs: RepoConfig[], enqueue: (teamId: string, sha: string) => void) {',
        '    const config = findConfig(configs, event.repositoryId, event.host);',
        '    if (!config) {',
        "        console.warn('push without a config', event.repositoryId);",
        '        return;',
        '    }',
        '    enqueue(config.teamId, event.sha);',
        '}',
    ),
};
const hostDiff = [
    patch('src/webhooks/config-lookup.ts', 1, [
        " import type { RepoConfig } from './types';",
        ' ',
        '+/**',
        '+ * A config whose listed repository host is not the sending host belongs to',
        '+ * another instance of the same repository and is never taken, even when the',
        '+ * repository id matches.',
        '+ */',
        ' export function findConfig(configs: RepoConfig[], repositoryId: string, host: string): RepoConfig | undefined {',
        '-    return configs.find((c) => c.repositoryId === repositoryId);',
        '+    return configs.find(',
        '+        (c) => c.repositoryId === repositoryId && (c.hosts.length === 0 || c.hosts.includes(host)),',
        '+    );',
        ' }',
    ]),
];
const hostDecision = {
    suggestionId: 'round-a-host-filter',
    relevantFile: 'src/webhooks/config-lookup.ts',
    relevantLinesStart: 3,
    relevantLinesEnd: 5,
    existingCode: 'export function findConfig(configs: RepoConfig[], repositoryId: string, host: string): RepoConfig | undefined {\n    return configs.find((c) => c.repositoryId === repositoryId);',
    improvedCode: 'return configs.find(\n    (c) => c.repositoryId === repositoryId && (c.hosts.length === 0 || c.hosts.includes(host)),\n);',
    suggestionContent: 'findConfig takes the first config whose repositoryId matches, so a push from one instance can be routed to the config of another instance that mirrors the same repository id. Require that the config lists the sending host (or lists no host) before it wins.',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-11-22T12:01:36Z',
};
const hostReversalClaim = (expect) => ({
    id: 'readmit-other-host',
    golden: 'Asks to loosen or undo the host filter in findConfig: re-admit (or fall back to) a config whose repositoryId matches even when its listed hosts do not include the sending host, for example because the stored host is stale after an instance moved, so the push is not dropped.',
    truth: 'contested',
    premise: 'diff',
    expect,
});

// ---------------------------------------------------------------------------
// A point the developer answered in its thread. This round edits the same
// line without fixing what the comment was about: canDelete is async, so the
// unawaited check never refuses anyone.
// ---------------------------------------------------------------------------
const authRepo = {
    'src/docs/delete.ts': lines(
        "import { ForbiddenError } from './errors';",
        '',
        'export interface Db {',
        '    docs: { delete(id: string): Promise<void>; ownerOf(id: string): Promise<string | null> };',
        '}',
        '',
        'export async function canDelete(db: Db, userId: string, docId: string): Promise<boolean> {',
        '    return (await db.docs.ownerOf(docId)) === userId;',
        '}',
        '',
        'export async function deleteDoc(db: Db, userId: string, docId: string): Promise<void> {',
        '    if (!canDelete(db, userId, docId)) throw new ForbiddenError(`user ${userId} cannot delete ${docId}`);',
        '    await db.docs.delete(docId);',
        '}',
    ),
    'src/docs/errors.ts': lines('export class ForbiddenError extends Error {}'),
};
const authDiff = [
    patch('src/docs/delete.ts', 1, [
        "+import { ForbiddenError } from './errors';",
        '+',
        ' export interface Db {',
        '     docs: { delete(id: string): Promise<void>; ownerOf(id: string): Promise<string | null> };',
        ' }',
        ' ',
        ' export async function canDelete(db: Db, userId: string, docId: string): Promise<boolean> {',
        '     return (await db.docs.ownerOf(docId)) === userId;',
        ' }',
        ' ',
        ' export async function deleteDoc(db: Db, userId: string, docId: string): Promise<void> {',
        "-    if (!canDelete(db, userId, docId)) throw new Error('forbidden');",
        '+    if (!canDelete(db, userId, docId)) throw new ForbiddenError(`user ${userId} cannot delete ${docId}`);',
        '     await db.docs.delete(docId);',
        ' }',
    ]),
];
const authDecision = {
    suggestionId: 'round-a-missing-await',
    relevantFile: 'src/docs/delete.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 10,
    existingCode: "    if (!canDelete(db, userId, docId)) throw new Error('forbidden');",
    suggestionContent: 'canDelete is async, so `!canDelete(...)` tests a Promise, which is always truthy: the check never throws and any user can delete any document. Await it.',
    label: 'bug',
    outcome: 'not_implemented',
    answered: true,
    decidedAt: '2026-11-22T12:01:36Z',
};
const missingAwaitClaim = (id, expect) => ({
    id,
    golden: 'deleteDoc calls the async canDelete without await, so `!canDelete(...)` negates a Promise (always truthy) and the ownership check never refuses: any user can delete any document; it should await canDelete.',
    truth: 'true',
    premise: 'diff',
    expect,
});

// ---------------------------------------------------------------------------
// A reversal in another file than the comment it reverses: round A asked
// listActive to drop archived items; the report added now counts through it,
// and the bait is to put archived items back into listActive.
// ---------------------------------------------------------------------------
const archiveRepo = {
    'src/items/list.ts': lines(
        "import type { Item } from './types';",
        '',
        'export function listActive(items: Item[]): Item[] {',
        '    return items.filter((i) => !i.archived);',
        '}',
        '',
        'export function listAll(items: Item[]): Item[] {',
        '    return [...items];',
        '}',
    ),
    'src/items/types.ts': lines('export interface Item {', '    id: string;', '    archived: boolean;', '    value: number;', '}'),
    'src/items/report.ts': lines(
        "import { listActive } from './list';",
        "import type { Item } from './types';",
        '',
        '/** Lifetime value of the catalog, archived items included. */',
        'export function lifetimeValue(items: Item[]): number {',
        '    return listActive(items).reduce((sum, i) => sum + i.value, 0);',
        '}',
    ),
};
const archiveDiff = [
    patch('src/items/report.ts', 1, [
        "+import { listActive } from './list';",
        "+import type { Item } from './types';",
        '+',
        '+/** Lifetime value of the catalog, archived items included. */',
        '+export function lifetimeValue(items: Item[]): number {',
        '+    return listActive(items).reduce((sum, i) => sum + i.value, 0);',
        '+}',
    ]),
];
const archiveDecision = {
    suggestionId: 'round-a-drop-archived',
    relevantFile: 'src/items/list.ts',
    relevantLinesStart: 3,
    relevantLinesEnd: 4,
    existingCode: 'export function listActive(items: Item[]): Item[] {\n    return [...items];',
    improvedCode: 'return items.filter((i) => !i.archived);',
    suggestionContent: 'listActive returns archived items too, so the dashboard shows items the user archived. Filter out archived items here.',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-11-22T12:01:36Z',
};
const archiveClaims = [
    {
        id: 'readmit-archived-in-listActive',
        golden: 'Asks to edit listActive itself in src/items/list.ts so it returns archived items again (remove or loosen its archived filter). A finding that only changes lifetimeValue in report.ts to sum listAll or the raw items does NOT match.',
        truth: 'false',
        premise: 'diff',
        expect: 'not_deliver',
    },
    {
        id: 'lifetime-value-misses-archived',
        golden: 'lifetimeValue in report.ts promises to include archived items but sums listActive, which drops them, so the total is too low; report.ts should sum listAll (or the raw items) instead.',
        truth: 'true',
        premise: 'diff',
        expect: 'deliver',
    },
];

// ---------------------------------------------------------------------------
// kodus-ai#2663, round 2 replayed from this repository's public history: the
// incremental diff from round 1's head (8cb2485b9) to 7e2213fd1, which applied
// round 1's host filter, and round 1's seven comments as round 2 saw them
// (stored not_implemented; the author had answered every thread). In
// production round 2 posted the reverse of the applied filter and two points
// already raised. https://github.com/kodustech/kodus-ai/pull/2663
// ---------------------------------------------------------------------------
function loadReplay(name) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'fixtures', name);
    const walk = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]);
    const repo = Object.fromEntries(walk(path.join(dir, 'repo')).map((f) => [f, fs.readFileSync(path.join(dir, 'repo', f), 'utf8')]));
    const changedFiles = walk(path.join(dir, 'diffs')).map((f) => {
        const text = fs.readFileSync(path.join(dir, 'diffs', f), 'utf8').split('\n');
        const first = text.findIndex((l) => l.startsWith('@@ '));
        return { filename: f.replace(/\.diff$/, ''), patch: text.slice(first).join('\n').replace(/\n+$/, '') };
    });
    const previousDecisions = JSON.parse(fs.readFileSync(path.join(dir, 'round-a-decisions.json'), 'utf8'));
    return { repo, changedFiles, previousDecisions };
}
const kodus2663 = loadReplay('kodus-2663');
const kodus2663Claims = [
    {
        id: 'readmit-config-on-other-host',
        golden: 'Asks to loosen the "never take a config listed on another server" filter added in round 1: re-admit, or fall back to, a config whose repository id and owner/repo match even when the host it lists differs from the host that sent the webhook (for example a stale stored host after an instance moved).',
        truth: 'contested',
        premise: 'diff',
        expect: 'not_deliver',
    },
    {
        id: 'name-match-requires-no-hosts-again',
        golden: 'Asks again to require that a config lists no host (configHostsOf(config, repositoryId).length === 0) before a repository-name match is accepted in webhook-source-host.ts.',
        truth: 'contested',
        premise: 'diff',
        expect: 'not_deliver',
    },
    {
        id: 'gitlab-lookup-loses-fallback-again',
        golden: 'The GitLab config lookup in gitlab.service.ts loses the repository-name or id-only fallback when the webhook host cannot be read, so the event or comment is dropped.',
        truth: 'contested',
        premise: 'read-file',
        expect: 'not_deliver',
    },
];

// kodus-ai#2667, round 2 replayed the same way: 730c1c644 to fdeeab449, which
// applied round 1's "decide the id once per label" suggestion, with that
// round's three answered comments. In production round 2 posted, as
// "Revises", the request to go back to the per-entry check.
// https://github.com/kodustech/kodus-ai/pull/2667
const kodus2667 = loadReplay('kodus-2667');
const kodus2667Unanswered = {
    ...kodus2667,
    previousDecisions: kodus2667.previousDecisions.map((d) => ({ ...d, answered: false })),
};
const kodus2667Claims = [
    {
        id: 'per-entry-clash-again',
        golden: 'Asks to undo or narrow the per-label needsId decision in model-label.ts that round 1 asked for: scope the id to the entries actually in a clash (per id, per label+connection, or the earlier pairwise/per-entry check), so prefix twins on two connections stay plain. A finding that keeps needsId as it is and changes a consumer such as routingModelLabels instead does NOT match.',
        truth: 'contested',
        premise: 'diff',
        expect: 'not_deliver',
    },
];

// ---------------------------------------------------------------------------
// Thread state read from the host, as production reads it: the record carries
// only its comment id, and the PR's threads say whether it was answered.
// ---------------------------------------------------------------------------
const { answered: _answered, ...authDecisionUnread } = authDecision;
const authThreadCase = (replyBody) => ({
    previousDecisions: [{ ...authDecisionUnread, commentId: '9101' }],
    reviewThreads: [{ rootIds: ['9101'], replies: [{ body: replyBody }] }],
});

// ---------------------------------------------------------------------------
// The answered point comes back in another file: this round moves the same
// unawaited check out of deleteDoc into a new guard helper, so it sits on
// other lines of another file than the comment the developer answered.
// ---------------------------------------------------------------------------
const guardRepo = {
    ...authRepo,
    'src/docs/guard.ts': lines(
        "import { canDelete, type Db } from './delete';",
        "import { ForbiddenError } from './errors';",
        '',
        'export async function assertCanDelete(db: Db, userId: string, docId: string): Promise<void> {',
        '    if (!canDelete(db, userId, docId)) throw new ForbiddenError(`user ${userId} cannot delete ${docId}`);',
        '}',
    ),
    'src/docs/delete.ts': lines(
        "import { assertCanDelete } from './guard';",
        '',
        'export interface Db {',
        '    docs: { delete(id: string): Promise<void>; ownerOf(id: string): Promise<string | null> };',
        '}',
        '',
        'export async function canDelete(db: Db, userId: string, docId: string): Promise<boolean> {',
        '    return (await db.docs.ownerOf(docId)) === userId;',
        '}',
        '',
        'export async function deleteDoc(db: Db, userId: string, docId: string): Promise<void> {',
        '    await assertCanDelete(db, userId, docId);',
        '    await db.docs.delete(docId);',
        '}',
    ),
};
const guardDiff = [
    patch('src/docs/guard.ts', 1, [
        "+import { canDelete, type Db } from './delete';",
        "+import { ForbiddenError } from './errors';",
        '+',
        '+export async function assertCanDelete(db: Db, userId: string, docId: string): Promise<void> {',
        '+    if (!canDelete(db, userId, docId)) throw new ForbiddenError(`user ${userId} cannot delete ${docId}`);',
        '+}',
    ]),
    patch('src/docs/delete.ts', 1, [
        "-import { ForbiddenError } from './errors';",
        "+import { assertCanDelete } from './guard';",
        ' ',
        ' export interface Db {',
        '     docs: { delete(id: string): Promise<void>; ownerOf(id: string): Promise<string | null> };',
        ' }',
        ' ',
        ' export async function canDelete(db: Db, userId: string, docId: string): Promise<boolean> {',
        '     return (await db.docs.ownerOf(docId)) === userId;',
        ' }',
        ' ',
        ' export async function deleteDoc(db: Db, userId: string, docId: string): Promise<void> {',
        '-    if (!canDelete(db, userId, docId)) throw new ForbiddenError(`user ${userId} cannot delete ${docId}`);',
        '+    await assertCanDelete(db, userId, docId);',
        '     await db.docs.delete(docId);',
        ' }',
    ]),
];
const movedAwaitClaim = (id, expect) => ({
    id,
    golden: 'assertCanDelete (src/docs/guard.ts) calls the async canDelete without await, so `!canDelete(...)` negates a Promise (always truthy) and the ownership check never refuses: any user can delete any document; it should await canDelete.',
    truth: 'true',
    premise: 'diff',
    expect,
});

// ---------------------------------------------------------------------------
// A security hole the applied suggestion opened: posted even though its fix
// narrows the change. Round A asked to accept every subdomain of example.com;
// the applied endsWith check also accepts evilexample.com, on a CORS policy
// that sends credentials.
// ---------------------------------------------------------------------------
const corsRepo = {
    'src/http/cors.ts': lines(
        'export function isAllowedOrigin(origin: string | undefined): boolean {',
        '    if (!origin) return false;',
        "    return origin.endsWith('example.com');",
        '}',
    ),
    'src/http/server.ts': lines(
        "import { isAllowedOrigin } from './cors';",
        '',
        'export function corsHeaders(origin: string | undefined): Record<string, string> {',
        '    if (!isAllowedOrigin(origin)) return {};',
        '    return {',
        "        'Access-Control-Allow-Origin': origin as string,",
        "        'Access-Control-Allow-Credentials': 'true',",
        '    };',
        '}',
    ),
};
const corsDiff = [
    patch('src/http/cors.ts', 1, [
        '-const ALLOWED = [\'https://app.example.com\'];',
        '-',
        ' export function isAllowedOrigin(origin: string | undefined): boolean {',
        '     if (!origin) return false;',
        '-    return ALLOWED.includes(origin);',
        "+    return origin.endsWith('example.com');",
        ' }',
    ]),
];
const corsDecision = {
    suggestionId: 'round-a-subdomains',
    relevantFile: 'src/http/cors.ts',
    relevantLinesStart: 1,
    relevantLinesEnd: 5,
    existingCode: "const ALLOWED = ['https://app.example.com'];\n\nexport function isAllowedOrigin(origin: string | undefined): boolean {\n    if (!origin) return false;\n    return ALLOWED.includes(origin);",
    improvedCode: "return origin.endsWith('example.com');",
    suggestionContent: 'isAllowedOrigin only accepts https://app.example.com, so the staging and preview web apps on other example.com subdomains cannot call the API. Accept every subdomain of example.com.',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-11-22T12:01:36Z',
};
const corsClaims = [
    {
        id: 'cors-suffix-bypass',
        golden: 'isAllowedOrigin uses origin.endsWith(\'example.com\'), so an attacker origin such as https://evilexample.com passes, and corsHeaders then returns it with Access-Control-Allow-Credentials: true; it should match the exact host or a \'.example.com\' subdomain of a parsed URL.',
        truth: 'true',
        premise: 'diff',
        expect: 'deliver',
    },
];

const contradictionCases = [
    // The #2663 reversal, through the finder's link and through the check.
    {
        id: 'R20-reversal-of-applied-host-filter', family: 'rounds', repo: hostRepo, changedFiles: hostDiff, sandbox: 'alive',
        previousDecisions: [hostDecision],
        claims: [hostReversalClaim('not_deliver')],
    },
    // The developer answered the earlier comment's thread.
    {
        id: 'R21-reraise-after-reply', family: 'rounds', repo: authRepo, changedFiles: authDiff, sandbox: 'alive',
        previousDecisions: [authDecision],
        claims: [missingAwaitClaim('missing-await-reraise', 'not_deliver')],
    },
    { id: 'R21-control', family: 'control', repo: authRepo, changedFiles: authDiff, sandbox: 'alive', claims: [missingAwaitClaim('missing-await-control', 'deliver')] },
    // A reversal of a comment on another file, with a real bug beside it.
    {
        id: 'R22-cross-file-reversal', family: 'rounds', repo: archiveRepo, changedFiles: archiveDiff, sandbox: 'alive',
        previousDecisions: [archiveDecision],
        claims: archiveClaims,
    },
    // The repeat check returns no verdict: a finder-linked reversal, an
    // answered point and a likely repeat are discarded; the rest is posted.
    {
        id: 'R20-check-timeout', family: 'rounds', repo: hostRepo, changedFiles: hostDiff, sandbox: 'alive', repeatCheckFault: 'timeout',
        previousDecisions: [hostDecision],
        claims: [hostReversalClaim('not_deliver')],
    },
    {
        id: 'R21-check-parse-error', family: 'rounds', repo: authRepo, changedFiles: authDiff, sandbox: 'alive', repeatCheckFault: 'parse',
        previousDecisions: [authDecision],
        claims: [missingAwaitClaim('missing-await-reraise-unjudged', 'not_deliver')],
    },
    {
        id: 'R22-check-timeout', family: 'rounds', repo: archiveRepo, changedFiles: archiveDiff, sandbox: 'alive', repeatCheckFault: 'timeout',
        previousDecisions: [archiveDecision],
        claims: [{ ...archiveClaims[1], id: 'lifetime-value-unjudged' }],
    },
    // Heavy mode: the lenses never see the history; the check is their gate.
    {
        id: 'R21-heavy', family: 'rounds', repo: authRepo, changedFiles: authDiff, sandbox: 'alive', heavy: true,
        previousDecisions: [authDecision],
        claims: [missingAwaitClaim('missing-await-reraise-heavy', 'not_deliver')],
    },
    {
        id: 'R20-heavy', family: 'rounds', repo: hostRepo, changedFiles: hostDiff, sandbox: 'alive', heavy: true,
        previousDecisions: [hostDecision],
        claims: [hostReversalClaim('not_deliver')],
    },
    { id: 'R23-kodus2663-round2', family: 'rounds', ...kodus2663, sandbox: 'alive', claims: kodus2663Claims },
    { id: 'R23-kodus2663-round2-heavy', family: 'rounds', ...kodus2663, sandbox: 'alive', heavy: true, claims: kodus2663Claims },
    // The point's thread got a reply, read from the host: Kody conceded it, or
    // the developer said it will be fixed later. Either ends the point.
    {
        id: 'R25-kody-conceded', family: 'rounds', repo: authRepo, changedFiles: authDiff, sandbox: 'alive',
        ...authThreadCase('You are right, deleteDoc only runs behind the admin route, which already checks ownership, so this check is a second guard. Happy to leave it as is.'),
        claims: [missingAwaitClaim('missing-await-after-concession', 'not_deliver')],
    },
    {
        id: 'R25-will-fix-later', family: 'rounds', repo: authRepo, changedFiles: authDiff, sandbox: 'alive',
        ...authThreadCase('Good catch, I will fix this in a follow-up PR.'),
        claims: [missingAwaitClaim('missing-await-after-will-fix', 'not_deliver')],
    },
    // The answered point, moved to another file of the same change.
    {
        id: 'R27-answered-point-moved-file', family: 'rounds', repo: guardRepo, changedFiles: guardDiff, sandbox: 'alive',
        ...authThreadCase('Known: deleteDoc is only reachable from the admin route, which checks ownership first. Leaving it.'),
        claims: [movedAwaitClaim('moved-await-after-reply', 'not_deliver')],
    },
    { id: 'R27-control', family: 'control', repo: guardRepo, changedFiles: guardDiff, sandbox: 'alive', claims: [movedAwaitClaim('moved-await-control', 'deliver')] },
    // A security hole the applied change opened is posted, linked or not.
    {
        id: 'R26-security-hole-from-applied', family: 'rounds', repo: corsRepo, changedFiles: corsDiff, sandbox: 'alive',
        previousDecisions: [corsDecision],
        claims: corsClaims,
    },
    { id: 'R26-control', family: 'control', repo: corsRepo, changedFiles: corsDiff, sandbox: 'alive', claims: [{ ...corsClaims[0], id: 'cors-suffix-bypass-control' }] },
    { id: 'R24-kodus2667-round2', family: 'rounds', ...kodus2667, sandbox: 'alive', claims: kodus2667Claims },
    { id: 'R24-kodus2667-round2-heavy', family: 'rounds', ...kodus2667, sandbox: 'alive', heavy: true, claims: kodus2667Claims },
    // No thread answered: only the reversal verdict stands between it and the PR.
    { id: 'R24-kodus2667-unanswered', family: 'rounds', ...kodus2667Unanswered, sandbox: 'alive', claims: kodus2667Claims },
];

module.exports = { contradictionCases };
