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
// A point the developer answered in its thread. The diff touches the same
// function without changing what the comment was about.
// ---------------------------------------------------------------------------
const labelRepo = {
    'src/users/label.ts': lines(
        "import type { User } from './types';",
        '',
        'export function authorLabel(users: Map<string, User>, id: string): string {',
        '    const user = users.get(id);',
        '    const name = user?.displayName.trim();',
        '    return `${name} (${id})`;',
        '}',
    ),
    'src/users/types.ts': lines('export interface User {', '    id: string;', '    displayName: string;', '}'),
};
const labelDiff = [
    patch('src/users/label.ts', 3, [
        ' export function authorLabel(users: Map<string, User>, id: string): string {',
        '     const user = users.get(id);',
        '-    return `${user?.displayName} (${id})`;',
        '+    const name = user?.displayName.trim();',
        '+    return `${name} (${id})`;',
        ' }',
    ]),
];
const labelDecision = {
    suggestionId: 'round-a-missing-user',
    relevantFile: 'src/users/label.ts',
    relevantLinesStart: 4,
    relevantLinesEnd: 5,
    existingCode: '    const user = users.get(id);\n    return `${user?.displayName} (${id})`;',
    suggestionContent: 'authorLabel renders "undefined (id)" when the id is not in the map (a deleted user). Fall back to the id alone, or to a placeholder name, when the user is missing.',
    label: 'bug',
    outcome: 'not_implemented',
    answered: true,
    decidedAt: '2026-11-22T12:01:36Z',
};
const missingUserClaim = (id, expect) => ({
    id,
    golden: 'When the id is not in the users map, authorLabel produces "undefined (id)" (or throws on displayName of undefined): a missing or deleted user is not handled.',
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
        golden: 'Asks to change listActive so it returns archived items again (remove or loosen its archived filter).',
        truth: 'false',
        premise: 'diff',
        expect: 'not_deliver',
    },
    {
        id: 'lifetime-value-misses-archived',
        golden: 'lifetimeValue promises to include archived items but sums listActive, which drops them; it should sum listAll (or the raw items) instead.',
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
        id: 'R21-reraise-after-reply', family: 'rounds', repo: labelRepo, changedFiles: labelDiff, sandbox: 'alive',
        previousDecisions: [labelDecision],
        claims: [missingUserClaim('missing-user-reraise', 'not_deliver')],
    },
    { id: 'R21-control', family: 'control', repo: labelRepo, changedFiles: labelDiff, sandbox: 'alive', claims: [missingUserClaim('missing-user-control', 'deliver')] },
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
        id: 'R21-check-parse-error', family: 'rounds', repo: labelRepo, changedFiles: labelDiff, sandbox: 'alive', repeatCheckFault: 'parse',
        previousDecisions: [labelDecision],
        claims: [missingUserClaim('missing-user-reraise-unjudged', 'not_deliver')],
    },
    {
        id: 'R22-check-timeout', family: 'rounds', repo: archiveRepo, changedFiles: archiveDiff, sandbox: 'alive', repeatCheckFault: 'timeout',
        previousDecisions: [archiveDecision],
        claims: [{ ...archiveClaims[1], id: 'lifetime-value-unjudged' }],
    },
    // Heavy mode: the lenses never see the history; the check is their gate.
    {
        id: 'R21-heavy', family: 'rounds', repo: labelRepo, changedFiles: labelDiff, sandbox: 'alive', heavy: true,
        previousDecisions: [labelDecision],
        claims: [missingUserClaim('missing-user-reraise-heavy', 'not_deliver')],
    },
    {
        id: 'R20-heavy', family: 'rounds', repo: hostRepo, changedFiles: hostDiff, sandbox: 'alive', heavy: true,
        previousDecisions: [hostDecision],
        claims: [hostReversalClaim('not_deliver')],
    },
];

module.exports = { contradictionCases };
