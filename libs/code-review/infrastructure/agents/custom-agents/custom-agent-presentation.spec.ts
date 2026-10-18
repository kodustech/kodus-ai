import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import type {
    CodeSuggestion,
    CustomAgentConfig,
    CustomAgentPresentation,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

import {
    capCustomAgentComments,
    collectSingleComments,
    customAgentSeverityVerdict,
    customAgentWriting,
    indexCustomAgents,
    keepOwnFindingsApart,
    preferCustomAgentKeep,
    stripCustomAgentFixes,
} from './custom-agent-presentation';
import {
    formatCustomAgentsSummary,
    summarizeCustomAgentRuns,
} from './custom-agent-summary';

const agent = (
    id: string,
    presentation: Partial<CustomAgentPresentation> = {},
): CustomAgentConfig => ({
    id,
    name: `Agent ${id}`,
    enabled: true,
    instructions: '',
    scope: {},
    tools: {},
    presentation: {
        tag: { color: '7B1FA2' },
        format: 'inline',
        suggestedFix: 'when-confident',
        ...presentation,
    },
});

const finding = (
    agentId: string | undefined,
    over: Partial<CodeSuggestion> = {},
): Partial<CodeSuggestion> => ({
    relevantFile: 'src/ledger/post.ts',
    relevantLinesStart: 10,
    suggestionContent: 'body',
    oneSentenceSummary: 'title',
    severity: 'medium',
    ...(agentId && { customAgent: { id: agentId, name: `Agent ${agentId}` } }),
    ...over,
});

describe('customAgentSeverityVerdict', () => {
    const agents = indexCustomAgents([
        agent('floor', { minSeverity: SeverityLevel.HIGH }),
        agent('none'),
    ]);

    it("applies the agent's own floor", () => {
        expect(
            customAgentSeverityVerdict(
                finding('floor', { severity: 'critical' }),
                agents,
            ),
        ).toBe(true);
        expect(
            customAgentSeverityVerdict(
                finding('floor', { severity: 'medium' }),
                agents,
            ),
        ).toBe(false);
    });

    it('leaves the decision to the global filter otherwise', () => {
        expect(
            customAgentSeverityVerdict(finding('none'), agents),
        ).toBeUndefined();
        expect(
            customAgentSeverityVerdict(finding(undefined), agents),
        ).toBeUndefined();
    });
});

describe('capCustomAgentComments', () => {
    it("keeps the agent's most severe findings and marks the rest", () => {
        const agents = indexCustomAgents([agent('a', { maxComments: 2 })]);
        const low = finding('a', {
            severity: 'low',
            oneSentenceSummary: 'low',
        });
        const crit = finding('a', {
            severity: 'critical',
            oneSentenceSummary: 'crit',
        });
        const high = finding('a', {
            severity: 'high',
            oneSentenceSummary: 'high',
        });
        const native = finding(undefined, { severity: 'low' });

        const { kept, overflow } = capCustomAgentComments(
            [low, native, crit, high],
            agents,
        );

        expect(kept).toEqual([native, crit, high]);
        expect(overflow).toEqual([
            expect.objectContaining({
                oneSentenceSummary: 'low',
                priorityStatus: PriorityStatus.DISCARDED_BY_QUANTITY,
                deliveryStatus: DeliveryStatus.NOT_SENT,
                notSentReason: 'custom-agent-max-comments',
            }),
        ]);
    });
});

describe('stripCustomAgentFixes', () => {
    it("drops the code of an agent whose fixes are 'never'", () => {
        const agents = indexCustomAgents([
            agent('never', { suggestedFix: 'never' }),
            agent('ok'),
        ]);
        const a = finding('never', { improvedCode: 'fixed()' });
        const b = finding('ok', { improvedCode: 'fixed()' });
        const c = finding(undefined, { improvedCode: 'fixed()' });

        expect(stripCustomAgentFixes([a, b, c], agents)).toBe(1);
        expect([a.improvedCode, b.improvedCode, c.improvedCode]).toEqual([
            '',
            'fixed()',
            'fixed()',
        ]);
    });
});

describe('customAgentWriting', () => {
    it("returns the agent's writing instructions for its findings only", () => {
        const agents = indexCustomAgents([
            agent('w', { writing: ' Be terse. ' }),
        ]);
        expect(customAgentWriting(finding('w'), agents)).toBe('Be terse.');
        expect(customAgentWriting(finding(undefined), agents)).toBeUndefined();
    });
});

describe('preferCustomAgentKeep', () => {
    it('promotes the custom agent finding to represent the group', () => {
        const suggestions = [
            finding(undefined, { label: 'bug' }),
            finding('a'),
        ];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 1, duplicates: [0] }]);
    });

    it('keeps a scanner finding as the representative', () => {
        const suggestions = [
            finding(undefined, {
                evidence: { source: ANALYZER_SOURCE, ruleId: 'r' },
            }),
            finding('a'),
        ];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });
});

describe('keepOwnFindingsApart', () => {
    const at = (file: string, start: number, end: number, agentId = 'dup') =>
        finding(agentId, {
            relevantFile: file,
            relevantLinesStart: start,
            relevantLinesEnd: end,
        });

    it("splits one agent's findings on different code out of a group", () => {
        // Five different clone pairs one duplicate-code agent reported,
        // grouped by the dedup model as "the same pattern".
        const suggestions = [
            at('api/update.ts', 1, 37),
            at('reporting/manager.ts', 1, 26),
            at('reporting/team.ts', 1, 42),
            at('reporting/weekly.ts', 1, 28),
            at('reporting/monthly.ts', 3, 9),
        ];
        expect(
            keepOwnFindingsApart(
                [{ keep: 3, duplicates: [0, 1, 2, 4] }],
                suggestions,
            ),
        ).toEqual([]);
    });

    it("still merges one agent's findings on overlapping lines", () => {
        const suggestions = [at('a.ts', 1, 10), at('a.ts', 5, 12)];
        expect(
            keepOwnFindingsApart([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('still merges findings of different agents, or a native one', () => {
        const suggestions = [
            at('a.ts', 1, 10, 'one'),
            at('b.ts', 1, 10, 'two'),
            finding(undefined, { relevantFile: 'c.ts', label: 'bug' }),
        ];
        expect(
            keepOwnFindingsApart(
                [{ keep: 0, duplicates: [1, 2] }],
                suggestions,
            ),
        ).toEqual([{ keep: 0, duplicates: [1, 2] }]);
    });
});

describe('collectSingleComments', () => {
    it("gathers a single-comment agent's findings into one PR-level comment", () => {
        const agents = indexCustomAgents([
            agent('one', { format: 'single-comment', tag: { color: 'teal' } }),
            agent('inline'),
        ]);
        const inline = finding('inline');
        const a = finding('one', {
            severity: 'low',
            oneSentenceSummary: 'minor',
        });
        const b = finding('one', {
            severity: 'high',
            oneSentenceSummary: 'major',
            relevantFile: 'src/ledger/close.ts',
            relevantLinesStart: 3,
        });

        const out = collectSingleComments([inline, a, b], agents);

        expect(out.inline).toEqual([inline]);
        expect(out.grouped).toEqual([a, b]);
        expect(out.prLevel).toHaveLength(1);
        const [comment] = out.prLevel;
        expect(comment.customAgent).toEqual({
            id: 'one',
            name: 'Agent one',
            color: 'teal',
        });
        expect(comment.label).toBe('custom_agent');
        expect(comment.severity).toBe('high');
        expect(comment.oneSentenceSummary).toBe(
            'Agent one: 2 findings in this pull request',
        );
        // Most severe first, each with where it is.
        expect(comment.suggestionContent.indexOf('major')).toBeLessThan(
            comment.suggestionContent.indexOf('minor'),
        );
        expect(comment.suggestionContent).toContain('`src/ledger/close.ts:3`');
    });
});

describe('custom agents summary', () => {
    it('renders one row per agent with what reached the PR', () => {
        const summary = summarizeCustomAgentRuns(
            [
                {
                    id: 'p',
                    name: 'Ledger | Rules',
                    slug: 'ledger-rules',
                    status: 'ran',
                    droppedByVerify: 1,
                },
                {
                    id: 's',
                    name: 'Docs',
                    slug: 'docs',
                    status: 'no-matching-files',
                    droppedByVerify: 0,
                },
            ],
            [finding('p'), finding('p')],
        );

        const markdown = formatCustomAgentsSummary(summary);

        expect(markdown).toContain('| Ledger \\| Rules | ran | 2 | 1 |');
        expect(markdown).toContain(
            '| Docs | not run: no matching files | 0 | 0 |',
        );
    });

    it('escapes a trailing backslash so it cannot unescape the pipe', () => {
        const markdown = formatCustomAgentsSummary([
            {
                id: 'p',
                name: 'Ledger\\| Rules',
                slug: 'ledger-rules',
                status: 'ran',
                droppedByVerify: 0,
                posted: 0,
            },
        ]);

        expect(markdown).toContain('| Ledger\\\\\\| Rules | ran | 0 | 0 |');
    });

    it('renders nothing when no agent was configured', () => {
        expect(formatCustomAgentsSummary([])).toBe('');
    });

    it('has no mode or shadow column', () => {
        const markdown = formatCustomAgentsSummary(
            summarizeCustomAgentRuns(
                [
                    {
                        id: 'p',
                        name: 'Docs',
                        slug: 'docs',
                        status: 'ran',
                        droppedByVerify: 0,
                    },
                ],
                [],
            ),
        );
        expect(markdown).toContain(
            '| Agent | Status | Posted | Dropped by verification |',
        );
        expect(markdown).not.toMatch(/shadow|mode/i);
    });
});
