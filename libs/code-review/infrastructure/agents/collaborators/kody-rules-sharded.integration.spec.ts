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
    inlineLoadedReferences,
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

/**
 * Regression: a rule that cites repo files via `@file:` markers in its BODY is
 * stored "context-os-only" — only a `contextReferenceId` on the rule, resolved
 * through the Context OS (loader -> ContextPack -> file content). The code-review
 * path reads rules raw (no UI enrichment), so `externalReferences` is NOT on the
 * rule and `sourcePath` is null. The sharded path only inlined `sourcePath`, so
 * the referenced file never reached the shard and the model saw the bare
 * "@file:X" marker — the root cause of the recall miss (capim rule 4902…, and
 * proven in runtime with a `@file:CLAUDE.md` rule).
 *
 * `inlineLoadedReferences` takes the loader's resolved map (uuid -> refs WITH
 * content) and appends that content to the rule text.
 */
describe('sharded kody-rules — Context OS references inline into the shard', () => {
    const rule = () => ({
        uuid: 'r-ctx',
        title: 'Validate data against the project conventions',
        rule: 'Siga exatamente essas regras para validar os dados: @file:CLAUDE.md',
        sourcePath: null,
        contextReferenceId: 'ctx-abc',
    });

    it('inlines the resolved reference content (contextReferenceId path)', () => {
        const map = new Map([
            [
                'r-ctx',
                [
                    {
                        filePath: 'CLAUDE.md',
                        content: '# Conventions\nAlways validate input before persisting.',
                    },
                ],
            ],
        ]);

        const out = inlineLoadedReferences([rule() as any], map);

        // The judge must see the ACTUAL file content, not the "@file:" marker.
        expect(out[0].rule).toContain('Always validate input before persisting');
        expect(out[0].rule).toContain('CLAUDE.md');
        // Original rule text is preserved.
        expect(out[0].rule).toContain('validar os dados');
    });

    it('inlines multiple resolved references for one rule', () => {
        const map = new Map([
            [
                'r-ctx',
                [
                    { filePath: 'DESIGN.md', content: 'design conventions here' },
                    { filePath: 'src/resolver.js', content: 'resolver logic here' },
                ],
            ],
        ]);
        const out = inlineLoadedReferences([rule() as any], map);
        expect(out[0].rule).toContain('design conventions here');
        expect(out[0].rule).toContain('resolver logic here');
    });

    it('leaves the rule untouched when the map has no entry for its uuid', () => {
        const out = inlineLoadedReferences(
            [rule() as any],
            new Map([['other-uuid', [{ filePath: 'x', content: 'y' }]]]),
        );
        expect(out[0].rule).toBe(rule().rule);
    });

    it('degrades to the rule text when the resolved content is empty', () => {
        const out = inlineLoadedReferences(
            [rule() as any],
            new Map([['r-ctx', [{ filePath: 'CLAUDE.md', content: '' }]]]),
        );
        expect(out[0].rule).toBe(rule().rule);
    });

    it('returns rules unchanged when the references map is empty or absent', () => {
        expect(inlineLoadedReferences([rule() as any], new Map())[0].rule).toBe(
            rule().rule,
        );
        expect(inlineLoadedReferences([rule() as any], undefined)[0].rule).toBe(
            rule().rule,
        );
    });

    // The augmented rule is re-embedded into every file shard, so the budget
    // must cap the TOTAL appended text per rule — not each ref independently —
    // or a multi-ref / large-ref rule balloons the input by the file count.
    it('caps the TOTAL inlined content per rule at maxRefChars across refs', () => {
        const base = { uuid: 'r1', title: 't', rule: 'base rule text' };
        const map = new Map([
            [
                'r1',
                [
                    { filePath: 'a.md', content: 'X'.repeat(100) },
                    { filePath: 'b.md', content: 'Y'.repeat(100) },
                ],
            ],
        ]);
        const out = inlineLoadedReferences([base as any], map, undefined, 50);
        const contentChars = (out[0].rule!.match(/[XY]/g) || []).length;
        expect(contentChars).toBeLessThanOrEqual(50);
        expect(contentChars).toBeGreaterThan(0);
    });

    it('truncates a single oversized reference to the budget', () => {
        const base = { uuid: 'r1', title: 't', rule: 'base' };
        const out = inlineLoadedReferences(
            [base as any],
            new Map([['r1', [{ filePath: 'big.md', content: 'Z'.repeat(10000) }]]]),
            undefined,
            100,
        );
        const z = (out[0].rule!.match(/Z/g) || []).length;
        expect(z).toBeLessThanOrEqual(100);
        expect(z).toBeGreaterThan(0);
    });
});
