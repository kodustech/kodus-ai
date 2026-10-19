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
    ruleCitation,
    preferCustomAgentKeep,
    stripCustomAgentFixes,
    languageNamedInWriting,
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
    // A finding that applies the team rule the agent was asked for.
    const convention = (agentId: string) =>
        finding(agentId, {
            kind: 'convention',
            source: { file: 'docs/ledger.md', quote: 'Debits equal credits.' },
        });

    it('promotes the custom agent convention finding to represent the group', () => {
        const suggestions = [
            finding(undefined, { label: 'bug' }),
            convention('a'),
        ];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 1, duplicates: [0] }]);
    });

    it("leaves the generalist's finding as representative over an off-lane bug", () => {
        const suggestions = [
            finding(undefined, { label: 'bug' }),
            finding('a', { kind: 'bug' }),
            finding('b'),
        ];
        expect(
            preferCustomAgentKeep(
                [{ keep: 0, duplicates: [1, 2] }],
                suggestions,
            ),
        ).toEqual([{ keep: 0, duplicates: [1, 2] }]);
    });

    it('does not credit a convention finding that quotes no rule', () => {
        const suggestions = [
            finding(undefined, { label: 'bug' }),
            finding('a', {
                kind: 'convention',
                source: { file: 'docs/ledger.md', quote: '  ' },
            }),
        ];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('hands an off-lane representative back to the generalist', () => {
        const suggestions = [
            finding('a', { kind: 'bug' }),
            finding(undefined, { label: 'bug' }),
        ];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 1, duplicates: [0] }]);
    });

    it('prefers the convention finding over an off-lane representative', () => {
        const suggestions = [
            finding('a', { kind: 'bug' }),
            finding(undefined, { label: 'bug' }),
            convention('b'),
        ];
        expect(
            preferCustomAgentKeep(
                [{ keep: 0, duplicates: [1, 2] }],
                suggestions,
            ),
        ).toEqual([{ keep: 2, duplicates: [0, 1] }]);
    });

    it('leaves a group of custom agent findings alone', () => {
        const suggestions = [finding('a', { kind: 'bug' }), finding('b')];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('leaves a group of native findings alone', () => {
        const suggestions = [
            finding(undefined, { label: 'bug' }),
            finding(undefined, { label: 'security' }),
        ];
        expect(
            preferCustomAgentKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
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

    it("keeps one agent's findings apart under a native representative too", () => {
        // An off-lane agent does not take the group (preferCustomAgentKeep),
        // so the native finding stays its representative: it can absorb the
        // agent's finding on its own code, never the agent's other ones.
        const suggestions = [
            finding(undefined, {
                relevantFile: 'reporting/team.ts',
                relevantLinesStart: 5,
                relevantLinesEnd: 8,
                label: 'bug',
            }),
            at('api/update.ts', 1, 37),
            at('reporting/team.ts', 1, 42),
            at('reporting/weekly.ts', 1, 28),
        ];
        expect(
            keepOwnFindingsApart(
                [{ keep: 0, duplicates: [1, 2, 3] }],
                suggestions,
            ),
        ).toEqual([{ keep: 0, duplicates: [2] }]);
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

describe('ruleCitation', () => {
    it('names the guide and quotes the rule a convention finding applies', () => {
        expect(
            ruleCitation({
                kind: 'convention',
                source: {
                    file: '.claude/skills/ledger/references/errors.md',
                    section: 'Errors',
                    quote: 'Raise LedgerError with a code.',
                },
            } as any),
        ).toBe(
            '\n\n**Rule** (`.claude/skills/ledger/references/errors.md`):\n> Raise LedgerError with a code.',
        );
    });

    it("names the agent's instructions for a rule written there", () => {
        expect(
            ruleCitation({
                kind: 'convention',
                source: {
                    file: 'TeamInstructions',
                    section: '',
                    quote: 'Log the zone id.',
                },
            } as any),
        ).toContain("**Rule** (agent's instructions)");
    });

    it('names a repository file called TeamInstructions.md as a file', () => {
        expect(
            ruleCitation({
                kind: 'convention',
                source: {
                    file: 'TeamInstructions.md',
                    section: '',
                    quote: 'Log the zone id.',
                },
            } as any),
        ).toContain('**Rule** (`TeamInstructions.md`)');
    });

    it('quotes every line of a multi-line rule', () => {
        expect(
            ruleCitation({
                kind: 'convention',
                source: { file: 'docs/a.md', section: '', quote: 'one\ntwo' },
            } as any),
        ).toContain('> one\n> two');
    });

    it('adds nothing to a finding without a quoted rule', () => {
        expect(ruleCitation({ kind: 'bug' } as any)).toBe('');
        expect(
            ruleCitation({
                kind: 'convention',
                source: { file: 'a.md', quote: ' ' },
            } as any),
        ).toBe('');
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

    it('adds no English of its own around an agent that writes in another language', () => {
        // The findings already come in the agent's voice (the formatter
        // rewrote their title and body); the comment's own words must not
        // switch the reader back to English.
        const agents = indexCustomAgents([
            agent('pt', {
                format: 'single-comment',
                writing: 'Escreva em português do Brasil.',
            }),
        ]);
        const out = collectSingleComments(
            [
                finding('pt', {
                    severity: 'high',
                    oneSentenceSummary: 'Lançamento sem contrapartida',
                    suggestionContent: 'O débito fica sem crédito.',
                }),
                finding('pt', {
                    severity: 'low',
                    oneSentenceSummary: '',
                    suggestionContent: 'Nome fora do padrão.',
                    relevantLinesStart: 12,
                }),
            ],
            agents,
        );

        const [comment] = out.prLevel;
        expect(comment.oneSentenceSummary).toBe('Agent pt (2)');
        expect(comment.suggestionContent).not.toMatch(
            /finding|pull request|\((high|low)\)/i,
        );
        expect(comment.suggestionContent).toContain(
            '1. **Lançamento sem contrapartida** — `src/ledger/post.ts:10`',
        );
        expect(comment.suggestionContent).toContain(
            '2. `src/ledger/post.ts:12`',
        );
    });
});

describe('custom agents summary', () => {
    it('renders one row per agent that ran and one line for those that did not', () => {
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
        expect(markdown).not.toContain('| Docs |');
        expect(markdown).toContain('Not run: Docs (no matching files)');
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
            '| Agent | Status | Posted | Dropped by checks |',
        );
        expect(markdown).not.toMatch(/shadow|mode/i);
    });
});

describe('languageNamedInWriting', () => {
    it.each([
        ['Escribe todos los comentarios en español.', 'es'],
        ['Write every comment in Spanish.', 'es'],
        ['Escreva em português, curto.', 'pt'],
        ['Reply in English only.', 'en'],
        ['Écris en français.', 'fr'],
        ['Schreibe auf Deutsch.', 'de'],
        ['Be blunt. One sentence.', undefined],
        ['Mention the English name of each currency.', undefined],
    ])('%s -> %s', (writing, code) => {
        expect(languageNamedInWriting(writing)).toBe(code);
    });
});
