/**
 * finding-mapper unit tests — pure, zero LLM/IO (logger is a spy).
 * Locks path validation, kody-rule UUID gating/recovery, and label/severity.
 */
import {
    mapAgentFindings,
    resolveSuggestionLabel,
    type LabelPolicy,
} from '@libs/code-review/infrastructure/agents/collaborators/finding-mapper';

const file = (filename: string): any => ({ filename });
const noLog = { warn: () => undefined };

const bugPolicy: LabelPolicy = {
    categoryLabel: 'bug',
    allowedLabels: ['bug'],
    supportsMixed: false,
};
const mixedPolicy: LabelPolicy = {
    categoryLabel: 'generalist',
    allowedLabels: ['bug', 'security', 'performance'],
    supportsMixed: true,
};

describe('resolveSuggestionLabel', () => {
    it('single-category agent always returns its category', () => {
        expect(resolveSuggestionLabel({ label: 'security' }, bugPolicy)).toBe(
            'bug',
        );
    });
    it('mixed agent honors an allowed LLM label', () => {
        expect(resolveSuggestionLabel({ label: 'Security' }, mixedPolicy)).toBe(
            'security',
        );
    });
    it('mixed agent falls back to first allowed for an invalid label', () => {
        expect(resolveSuggestionLabel({ label: 'style' }, mixedPolicy)).toBe(
            'bug',
        );
    });
});

describe('mapAgentFindings', () => {
    const ctx = (
        over: Partial<Parameters<typeof mapAgentFindings>[1]> = {},
    ) => ({
        changedFiles: [file('src/a.ts')],
        prNumber: 1,
        isKodyRules: false,
        identityName: 'bug-agent',
        labelPolicy: bugPolicy,
        logger: noLog,
        ...over,
    });

    it('drops suggestions with no content', () => {
        const r = mapAgentFindings(
            {
                findings: {
                    suggestions: [{ relevantFile: 'src/a.ts' } as any],
                },
            },
            ctx(),
        );
        expect(r.suggestions).toHaveLength(0);
    });

    it('drops suggestions whose file is not in the PR', () => {
        const r = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { suggestionContent: 'x', relevantFile: 'other.ts' },
                    ],
                },
            },
            ctx(),
        );
        expect(r.suggestions).toHaveLength(0);
    });

    it('keeps + canonicalizes a matching finding (normalized path)', () => {
        const r = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { suggestionContent: 'bug', relevantFile: '/src/a.ts' },
                    ],
                },
            },
            ctx(),
        );
        expect(r.suggestions).toHaveLength(1);
        expect(r.suggestions[0].relevantFile).toBe('src/a.ts'); // provider's original
        expect(r.suggestions[0].label).toBe('bug');
        expect(r.suggestions[0].severity).toBe('medium');
    });

    it('kody-rules: attributes a uuid-less suggestion to the SINGLE selected rule', () => {
        // Observed live (PR #598 on the validation env): the model found the
        // violations but omitted the uuid echo, and the hard drop meant the
        // customer saw "rule never fires" even with path matching fixed.
        const r = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { suggestionContent: 'x', relevantFile: 'src/a.ts' },
                    ],
                },
            },
            ctx({ isKodyRules: true, kodyRules: [{ uuid: 'rule-1' } as any] }),
        );
        expect(r.suggestions).toHaveLength(1);
        expect(r.suggestions[0].brokenKodyRulesIds).toEqual(['rule-1']);
    });

    it('kody-rules: still drops a uuid-less suggestion when multiple rules are candidates (ambiguous)', () => {
        const r = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { suggestionContent: 'x', relevantFile: 'src/a.ts' },
                    ],
                },
            },
            ctx({
                isKodyRules: true,
                kodyRules: [
                    { uuid: 'rule-1' } as any,
                    { uuid: 'rule-2' } as any,
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(0);
    });

    it('kody-rules: recovers a near-miss ruleUuid (edit distance ≤ 2)', () => {
        const uuid = '123e4567-e89b-12d3-a456-426614174000';
        const corrupted = uuid.replace('0', 'x'); // 1 char off
        const r = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/a.ts',
                            ruleUuid: corrupted,
                        },
                    ],
                },
            },
            ctx({ isKodyRules: true, kodyRules: [{ uuid } as any] }),
        );
        expect(r.suggestions).toHaveLength(1);
        expect(r.suggestions[0].brokenKodyRulesIds).toEqual([uuid]);
    });

    it('maps discardedBySeverity and discardedByVerify', () => {
        const r = mapAgentFindings(
            {
                findings: { suggestions: [] },
                discardedBySeverity: [
                    { suggestionContent: 'a', relevantFile: 'src/a.ts' },
                ],
                droppedByVerify: [
                    { suggestionContent: 'b', relevantFile: 'src/a.ts' },
                ],
            },
            ctx(),
        );
        expect(r.discardedBySeverity).toHaveLength(1);
        expect(r.discardedByVerify).toHaveLength(1);
        expect(r.discardedByVerify[0].label).toBe('bug');
    });
});
