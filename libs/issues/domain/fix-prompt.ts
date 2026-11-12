import { fenced } from '@libs/common/utils/markdown-fence';

import type { IIssue } from './interfaces/issues.interface';

/** The most issues one prompt carries: past that a coding agent loses the thread. */
export const FIX_PROMPT_MAX_ISSUES = 25;

export type FixPromptIssue = Pick<
    IIssue,
    | 'uuid'
    | 'title'
    | 'description'
    | 'filePath'
    | 'severity'
    | 'repository'
    | 'source'
    | 'cwe'
    | 'symbol'
    | 'startLine'
    | 'endLine'
    | 'evidence'
    | 'contributingSuggestions'
>;

const SEVERITY_RANK = new Map(
    ['critical', 'high', 'medium', 'low'].map((s, i) => [s, i] as const),
);

/**
 * A prompt a developer pastes into their own coding agent (Claude Code,
 * Cursor, Codex) to fix the issues they picked. It carries what the agent
 * cannot find out alone: where the bug is, how an attacker reaches it, the
 * fix Kody proposed and, for a security finding, the reproduction test, so
 * the agent can prove the fix instead of claiming it.
 */
export function buildFixPrompt(issues: FixPromptIssue[]): string {
    const ordered = [...issues].sort(
        (a, b) =>
            (SEVERITY_RANK.get(String(a.severity)) ?? -1) -
            (SEVERITY_RANK.get(String(b.severity)) ?? -1),
    );
    const many = ordered.length > 1;
    const anyTest = ordered.some((i) => i.evidence?.reproduction);

    const intro = [
        many
            ? `Fix these ${ordered.length} issues Kody found in this repository, one at a time, most severe first.`
            : 'Fix this issue Kody found in this repository.',
        'For each one: read the code at the location given and confirm the problem is there before changing anything. If it is not, say so and move on.',
        'Fix the cause, not the symptom: change the code the issue points at, keep the change as small as the fix needs, and do not refactor around it.',
        anyTest
            ? 'Where an issue comes with a reproduction test that reproduced it, add it to the repository, run it to see it pass on the current code (it proves the problem), apply the fix, and run it again: it must now fail, which proves the fix. Then turn it into a regression test that passes on the fixed code and keep it. A test marked as not reproduced is to be reviewed before running anything from it.'
            : 'Add or update a test that would have caught the problem, and run it.',
        'When you finish, list each issue with what you changed, or why you left it.',
    ].join('\n');

    return [
        intro,
        ...ordered.map((issue, i) => section(issue, many ? i + 1 : 0)),
    ].join('\n\n---\n\n');
}

function section(issue: FixPromptIssue, n: number): string {
    const lines =
        issue.startLine && issue.endLine && issue.endLine !== issue.startLine
            ? `:${issue.startLine}-${issue.endLine}`
            : issue.startLine
              ? `:${issue.startLine}`
              : '';
    const where = [
        `${issue.filePath}${lines}`,
        issue.symbol ? `in ${issue.symbol}` : '',
        issue.repository?.full_name || issue.repository?.name
            ? `(repository ${issue.repository.full_name || issue.repository.name})`
            : '',
    ]
        .filter(Boolean)
        .join(' ');
    const out = [
        `## ${n ? `${n}. ` : ''}${issue.title}`,
        [
            `Severity: ${issue.severity}`,
            issue.cwe ? issue.cwe : '',
            issue.uuid ? `Kody issue ${issue.uuid}` : '',
        ]
            .filter(Boolean)
            .join(' · '),
        `Location: ${where}`,
        issue.description?.trim(),
    ];

    const path = issue.evidence?.attackPath ?? [];
    if (path.length) {
        out.push(
            `How an attacker reaches it:\n${path
                .map((s, i) => `${i + 1}. ${s.file}:${s.line} ${s.note}`)
                .join('\n')}`,
        );
    }

    const test = issue.evidence?.reproduction;
    if (test?.content) {
        // The test and its command are model output written while reading
        // the repository. Only one that ran in the scan's sandbox and
        // reproduced the issue is handed over to run; any other is to be
        // read first, never run as given on the developer's machine.
        const proven = !!test.executed && !!test.reproduced;
        out.push(
            proven
                ? `Reproduction test (${test.path}). It ran in an isolated sandbox and reproduced the issue. Run it with:\n${fenced(test.command)}\n\n${fenced(test.content.trim())}`
                : `Reproduction test (${test.path}). It has not reproduced the issue: review it, and the command it was written for, before running anything.\n${fenced(test.command)}\n\n${fenced(test.content.trim())}`,
        );
    }

    const suggestion = (issue.contributingSuggestions ?? []).find(
        (s) => s.improvedCode,
    );
    if (suggestion) {
        out.push(
            `Change Kody suggested in a review:\n${fenced(suggestion.improvedCode.trim(), suggestion.language ?? '')}`,
        );
    }

    return out.filter(Boolean).join('\n\n');
}
