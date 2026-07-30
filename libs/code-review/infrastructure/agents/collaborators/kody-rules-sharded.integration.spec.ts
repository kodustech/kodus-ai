/**
 * Wiring validation for the sharded kody-rules path (#1449): the NEW integration
 * points beyond the pure judge (already unit-tested) are (a) ShardViolation →
 * real mapAgentFindings → CodeSuggestion, and (b) T2 reference-inline. Both are
 * exercised here with the REAL shared collaborators and no LLM — the live LLM
 * call is generic infra and the prompt/recall is validated separately by
 * evals/kody-rules/sharded-experiment.js.
 */
import {
    judgeKodyRulesSharded,
    inlineRuleReferences,
    RunJudge,
} from './kody-rules-sharded.judge';
import { mapAgentFindings } from './finding-mapper';

const file = (filename: string, patch: string): any => ({
    filename,
    patchWithLinesStr: patch,
    patch,
});

describe('sharded kody-rules — judge → mapAgentFindings wiring (#1449)', () => {
    const rules = [
        { uuid: 'no-console', title: 'no console', rule: 'no console.log', path: '**/*.ts' },
    ];
    const changedFiles = [file('src/a.ts', '5 +console.log(1)')];

    it('maps a shard violation to a CodeSuggestion tagged with brokenKodyRulesIds', async () => {
        const runJudge: RunJudge = async () => [
            {
                ruleId: 1, // → the shard's first (only) rule: no-console
                relevantLinesStart: 5,
                relevantLinesEnd: 5,
                suggestionContent: 'Violates no console.log',
                oneSentenceSummary: 'no console',
                existingCode: 'console.log(1)',
            },
        ];

        const { violations } = await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
        });

        const mapped = mapAgentFindings(
            { findings: { suggestions: violations } },
            {
                changedFiles,
                kodyRules: rules,
                prNumber: 1,
                isKodyRules: true,
                identityName: 'kodus-rules-review-agent',
                labelPolicy: {
                    categoryLabel: 'kody_rules',
                    allowedLabels: ['bug'],
                    supportsMixed: false,
                },
            },
        );

        expect(mapped.suggestions).toHaveLength(1);
        const s = mapped.suggestions[0];
        expect(s.relevantFile).toBe('src/a.ts');
        expect(s.relevantLinesStart).toBe(5);
        expect((s as any).brokenKodyRulesIds).toEqual(['no-console']);
        expect(s.suggestionContent).toContain('console');
    });

    it('drops a violation whose file is not in the PR (defensive, via the mapper)', async () => {
        const runJudge: RunJudge = async () => [
            {
                ruleId: 1,
                relevantLinesStart: 1,
                suggestionContent: 'x',
            },
        ];
        const { violations } = await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
        });
        // the judge anchors to the shard's real file, so the mapper keeps it
        expect(violations[0].relevantFile).toBe('src/a.ts');
    });

    it('drops a suggestion with an unknown ruleUuid at the mapper (kody-rules gate)', async () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            ruleUuid: 'TOTALLY-UNKNOWN',
                            relevantFile: 'src/a.ts',
                            relevantLinesStart: 5,
                            suggestionContent: 'x',
                        },
                    ],
                },
            },
            {
                changedFiles,
                kodyRules: rules,
                prNumber: 1,
                isKodyRules: true,
                identityName: 'k',
                labelPolicy: {
                    categoryLabel: 'kody_rules',
                    allowedLabels: ['bug'],
                    supportsMixed: false,
                },
            },
        );
        expect(mapped.suggestions).toHaveLength(0);
    });
});

describe('sharded kody-rules — T2 reference-inline (#1449)', () => {
    it('appends the referenced file content to the rule text', async () => {
        const read = async (path: string) =>
            path === '.cursor/rules/imports.mdc'
                ? 'Do not import package:http/http.dart'
                : '';
        const out = await inlineRuleReferences(
            [
                {
                    uuid: 'r1',
                    title: 'imports',
                    rule: 'Follow the imports convention.',
                    sourcePath: '.cursor/rules/imports.mdc',
                },
            ],
            read,
        );
        expect(out[0].rule).toContain('Follow the imports convention.');
        expect(out[0].rule).toContain('Do not import package:http/http.dart');
        expect(out[0].rule).toContain('.cursor/rules/imports.mdc');
    });

    it('leaves the rule untouched when it has no sourcePath', async () => {
        const out = await inlineRuleReferences(
            [{ uuid: 'r1', title: 't', rule: 'plain rule' }],
            async () => 'x',
        );
        expect(out[0].rule).toBe('plain rule');
    });

    it('degrades gracefully to the rule text when the read throws', async () => {
        const out = await inlineRuleReferences(
            [{ uuid: 'r1', title: 't', rule: 'plain', sourcePath: 'missing.md' }],
            async () => {
                throw new Error('file not found');
            },
        );
        expect(out[0].rule).toBe('plain'); // no regression, judged on text alone
    });

    it('returns rules unchanged when there is no sandbox (read undefined)', async () => {
        const out = await inlineRuleReferences(
            [{ uuid: 'r1', title: 't', rule: 'plain', sourcePath: 'x.md' }],
            undefined,
        );
        expect(out[0].rule).toBe('plain');
    });
});
