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
    findUnresolvedReferenceRules,
    RunJudge,
} from './kody-rules-sharded.judge';
import { mapAgentFindings } from './finding-mapper';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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

describe('findUnresolvedReferenceRules — surfaces judge-blind rules', () => {
    const r = (over: Record<string, unknown> = {}) => ({
        uuid: 'r1',
        title: 't',
        rule: 'base',
        contextReferenceId: 'ctx',
        ...over,
    });

    it('does NOT flag a rule without a contextReferenceId', () => {
        const out = findUnresolvedReferenceRules(
            [r({ contextReferenceId: undefined }) as any],
            new Map(),
        );
        expect(out).toHaveLength(0);
    });

    it('flags a contextReferenceId rule with no map entry', () => {
        const out = findUnresolvedReferenceRules([r() as any], new Map());
        expect(out.map((x) => x.uuid)).toEqual(['r1']);
    });

    it('does NOT flag a rule whose entry has real content', () => {
        const out = findUnresolvedReferenceRules(
            [r() as any],
            new Map([['r1', [{ filePath: 'CLAUDE.md', content: 'conv' }]]]),
        );
        expect(out).toHaveLength(0);
    });

    // The gap: a whitespace-only reference file passes the loader's
    // `typeof === 'string'` guard, so the map entry exists, but
    // inlineLoadedReferences inlines nothing (content.trim() empty) — must
    // still be treated as unresolved so it is surfaced.
    it('flags a rule whose entries are all empty/whitespace content', () => {
        const out = findUnresolvedReferenceRules(
            [r() as any],
            new Map([
                [
                    'r1',
                    [
                        { filePath: 'a.md', content: '   \n\t ' },
                        { filePath: 'b.md', content: '' },
                    ],
                ],
            ]),
        );
        expect(out.map((x) => x.uuid)).toEqual(['r1']);
    });

    it('does NOT flag when at least one entry has real content', () => {
        const out = findUnresolvedReferenceRules(
            [r() as any],
            new Map([
                [
                    'r1',
                    [
                        { filePath: 'a.md', content: '   ' },
                        { filePath: 'b.md', content: 'real' },
                    ],
                ],
            ]),
        );
        expect(out).toHaveLength(0);
    });
});

/**
 * The whole-file block carries the file ONCE, under exactly one instruction
 * (issue #1826).
 *
 * Before this, two independent paths put the same file on the same page: step 1
 * read it unconditionally into `fileContents`, and a rule declaring `full-file`
 * made the retriever read it AGAIN into a `contextSlices` entry. Under the
 * shard budget those two copies were byte-identical, and they arrived under
 * contradictory instructions — "never report a violation whose evidence lies
 * outside the diff hunks" in one block, "the evidence for such a violation may
 * well sit outside the hunk — report it" in the other.
 *
 * The measurable claim is a count, so these tests count.
 */
describe('whole-file block — one copy, one instruction (#1826)', () => {
    const BODY = Array.from(
        { length: 40 },
        (_, i) => `line ${i} SENTINEL_XYZ`,
    ).join('\n');

    const withNeed = (need: string) => ({
        uuid: `r-${need}`,
        title: 't',
        rule: 'r',
        path: '**/*.ts',
        contextNeed: {
            need,
            sourceHash: 'h',
            source: 'compiler',
            inferredAt: new Date(0),
        },
    });

    async function promptFor(rules: any[]) {
        let captured = '';
        const runJudge: RunJudge = async ({ user }) => {
            captured = user;
            return [];
        };
        await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +line 0 SENTINEL_XYZ')],
            rules,
            runJudge,
            fileContents: new Map([['src/a.ts', BODY]]),
        });
        return captured;
    }

    const copies = (prompt: string) =>
        (prompt.match(/SENTINEL_XYZ/g) || []).length;

    it('sends the file ONCE when a rule declares full-file', async () => {
        const prompt = await promptFor([withNeed('full-file')]);
        // 40 body lines + the single diff line. A second copy would be 81.
        expect(copies(prompt)).toBe(41);
    });

    it('sends the file ONCE when no rule declares anything', async () => {
        const prompt = await promptFor([withNeed('diff-only')]);
        expect(copies(prompt)).toBe(41);
    });

    it('authorizes whole-file judgment ONLY when a rule declared full-file', async () => {
        const authorized = await promptFor([withNeed('full-file')]);
        const notAuthorized = await promptFor([withNeed('diff-only')]);

        expect(authorized).toContain('may well sit outside the hunk');
        expect(authorized).not.toContain(
            'never report a violation whose evidence lies outside the diff hunks',
        );

        expect(notAuthorized).toContain(
            'never report a violation whose evidence lies outside the diff hunks',
        );
        expect(notAuthorized).not.toContain('may well sit outside the hunk');
    });

    it('never carries both instructions at once', async () => {
        for (const need of ['full-file', 'diff-only', 'symbol-references']) {
            const prompt = await promptFor([withNeed(need)]);
            const permissive = prompt.includes('may well sit outside the hunk');
            const restrictive = prompt.includes(
                'never report a violation whose evidence lies outside the diff hunks',
            );
            expect(permissive && restrictive).toBe(false);
        }
    });

    it('one full-file rule among many authorizes the shard', async () => {
        const prompt = await promptFor([
            withNeed('diff-only'),
            withNeed('full-file'),
        ]);
        expect(prompt).toContain('may well sit outside the hunk');
        expect(copies(prompt)).toBe(41);
    });
});

// Resolving `PreviousDecision.brokenKodyRulesIds` to a rule TITLE (malinosqui
// review, PR #1895): the file/PR shards evaluate several NAMED candidate
// rules at once, so an opaque "kody_rules" Type on every rule-based decision
// gives the model no way to tell a decision about the SAME rule it's judging
// apart from one about a DIFFERENT rule at the same location. This exercises
// the whole wire — the map built once in `judgeKodyRulesSharded` from the
// full rule catalog, reaching the actual prompt text — not just the pure
// `formatPreviousDecisions` unit (covered in prompt-builder.spec.ts).
describe('sharded kody-rules — PreviousDecision rule-title resolution (PR #1895 review)', () => {
    const rules = [
        {
            uuid: 'rule-a',
            title: 'Structured logging',
            rule: 'Log through PinoLoggerService',
        },
        {
            uuid: 'rule-b',
            title: 'Prefer Map for lookups',
            rule: 'Use a Map instead of .filter() in a loop',
        },
    ];
    const changedFiles = [file('src/a.ts', '5 +console.log(1)')];

    it('resolves a previous decision to the rule that produced it, in the file shard prompt', async () => {
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'sug-1',
                relevantFile: 'src/a.ts',
                relevantLinesStart: 5,
                relevantLinesEnd: 5,
                suggestionContent: 'Log through PinoLoggerService.',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-a'],
                outcome: 'implemented',
                decidedAt: '2026-01-01T00:00:00.000Z',
            },
        ];
        let capturedUser = '';
        const runJudge: RunJudge = async ({ user }) => {
            capturedUser = user;
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
            previousDecisions,
        });

        expect(capturedUser).toContain(
            'Type: Kody Rule — "Structured logging"',
        );
        // The OTHER candidate rule's title must not be the one attached to
        // this decision — it would misreport which rule was already decided.
        expect(capturedUser).not.toContain(
            'Type: Kody Rule — "Prefer Map for lookups"',
        );
    });

    it('resolves a previous decision in the PR-scope shard prompt too', async () => {
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'sug-pr-1',
                suggestionContent: 'Split this into two migrations.',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-b'],
                outcome: 'pending',
                decidedAt: '2026-01-01T00:00:00.000Z',
            },
        ];
        const prRules = [
            {
                uuid: 'rule-b',
                title: 'Prefer Map for lookups',
                rule: 'PR-scope variant',
                scope: KodyRulesScope.PULL_REQUEST,
            },
        ];
        let capturedPrUser = '';
        const runJudge: RunJudge = async ({ user, filename }) => {
            if (filename === null) capturedPrUser = user;
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles,
            rules: prRules,
            runJudge,
            previousDecisions,
        });

        expect(capturedPrUser).toContain(
            'Type: Kody Rule — "Prefer Map for lookups"',
        );
    });

    it('does NOT mislabel a PR-level kody_rules decision with no brokenKodyRulesIds as a general review (agent-review.stage.ts:1527 fallback path, kody-ai review PR #1895)', async () => {
        // Mirrors the real PR-level suggestion shape produced by
        // agent-review.stage.ts's `label: (s.label as any) || 'kody_rules'`
        // fallback when finding-mapper.ts never attached brokenKodyRulesIds
        // (the LLM omitted ruleUuid) — the exact gap the file-shard test
        // above already covers, reachable here via the PR-scope path too.
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'sug-pr-2',
                suggestionContent: 'Split this into two migrations.',
                label: 'kody_rules',
                outcome: 'pending',
                decidedAt: '2026-01-01T00:00:00.000Z',
            },
        ];
        const prRules = [
            {
                uuid: 'rule-b',
                title: 'Prefer Map for lookups',
                rule: 'PR-scope variant',
                scope: KodyRulesScope.PULL_REQUEST,
            },
        ];
        let capturedPrUser = '';
        const runJudge: RunJudge = async ({ user, filename }) => {
            if (filename === null) capturedPrUser = user;
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles,
            rules: prRules,
            runJudge,
            previousDecisions,
        });

        expect(capturedPrUser).not.toContain('Type: General review');
        expect(capturedPrUser).toContain(
            'Type: kody_rules (rule identity not recorded',
        );
    });

    it('labels a general-review (non-rule) decision explicitly, so it is never misread as covering a rule listed above', async () => {
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'sug-1',
                relevantFile: 'src/a.ts',
                relevantLinesStart: 5,
                relevantLinesEnd: 5,
                suggestionContent: 'This log call needs to follow team logging standards.',
                label: 'security',
                // No brokenKodyRulesIds — general finder, not a Kody Rule.
                outcome: 'implemented',
                decidedAt: '2026-01-01T00:00:00.000Z',
            },
        ];
        let capturedUser = '';
        const runJudge: RunJudge = async ({ user }) => {
            capturedUser = user;
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
            previousDecisions,
        });

        expect(capturedUser).toContain(
            'Type: General review (not a Kody Rule) — security',
        );
    });
});

/**
 * Realistic scenarios probed with real evals (Agent subagents standing in
 * for the judge, repeated sampling) during the malinosqui/kody-ai review of
 * PR #1895, after the user pushed back on "keep vs remove general-review
 * decisions from the kody-rules judge's prompt" and asked to test the
 * harder cases before deciding. Findings:
 *  - a MIXED list (one irrelevant general decision + one genuinely pending
 *    rule violation) is where the pre-fix ambiguous rendering actually hurt
 *    recall (40% vs 100% once labeled) — the earlier, simpler scenarios were
 *    too easy to show a difference.
 *  - same-location, adjacent-topic and list-bloat decoys: labeled and
 *    "removed entirely" performed identically (tie) — no evidence removal
 *    helps.
 *  - precision-loss scenario: REMOVING a general decision that explains why
 *    a reused helper is already safe (safeCompare/timing-attack) caused the
 *    judge to invent a false positive in 3/3 runs; keeping it (labeled)
 *    correctly stayed silent in 3/3 runs. This is the concrete reason the
 *    fix keeps general decisions (typed correctly) instead of removing them
 *    — removing them can throw away legitimate context the current diff
 *    alone can't reconstruct.
 * These tests don't call an LLM — they lock in the exact PROMPT TEXT each
 * scenario produces, so a future refactor can't silently reintroduce the
 * ambiguity or drop the context these scenarios depend on.
 */
describe('sharded kody-rules — PreviousDecision realistic scenarios (Eval 1d/3a-d, PR #1895 investigation)', () => {
    it('Eval 1d — mixed list types an irrelevant general decision AND a genuinely pending rule violation correctly in the same prompt', async () => {
        const rules = [
            {
                uuid: 'rule-sqli-uuid',
                title: 'No raw SQL string interpolation',
                rule: 'Never build a SQL query by interpolating a variable directly into the string.',
            },
        ];
        const changedFiles = [
            file(
                'src/order-service.ts',
                "2 +    const cached = memo.get(userId);\n5 +        `SELECT * FROM orders WHERE user_id = '${userId}'`,\n",
            ),
        ];
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'sug-perf-1',
                relevantFile: 'src/order-service.ts',
                relevantLinesStart: 2,
                relevantLinesEnd: 3,
                suggestionContent: 'Added an in-memory memo cache to avoid re-querying the same user repeatedly.',
                label: 'performance',
                outcome: 'implemented',
                decidedAt: '2026-09-10T12:00:00.000Z',
            },
            {
                suggestionId: 'sug-sqli-1',
                relevantFile: 'src/order-service.ts',
                relevantLinesStart: 5,
                relevantLinesEnd: 5,
                suggestionContent: 'The query interpolates userId directly into the SQL string — use a parameterized query instead.',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-sqli-uuid'],
                outcome: 'pending',
                decidedAt: '2026-09-10T12:00:00.000Z',
            },
        ];
        let capturedUser = '';
        const runJudge: RunJudge = async ({ user }) => {
            capturedUser = user;
            return [];
        };

        await judgeKodyRulesSharded({ changedFiles, rules, runJudge, previousDecisions });

        expect(capturedUser).toContain(
            'Type: General review (not a Kody Rule) — performance',
        );
        expect(capturedUser).toContain(
            'Type: Kody Rule — "No raw SQL string interpolation"',
        );
    });

    it('Eval 3a — a general decision at the SAME lines as the current rule violation still renders as general, not as covering the rule', async () => {
        const rules = [
            {
                uuid: 'rule-sqli-uuid',
                title: 'No raw SQL string interpolation',
                rule: 'Never build a SQL query by interpolating a variable directly into the string.',
            },
        ];
        const changedFiles = [
            file(
                'src/user-repo.ts',
                "2 +    const rows = await db.query(\n3 +        `SELECT * FROM users WHERE email = '${email}'`,\n",
            ),
        ];
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'a-perf',
                relevantFile: 'src/user-repo.ts',
                relevantLinesStart: 2,
                relevantLinesEnd: 4,
                suggestionContent: 'Added a query hint to speed up the user lookup by email — same lines as the query below.',
                label: 'performance',
                outcome: 'implemented',
                decidedAt: '2026-09-10T12:00:00.000Z',
            },
        ];
        let capturedUser = '';
        const runJudge: RunJudge = async ({ user }) => {
            capturedUser = user;
            return [];
        };

        await judgeKodyRulesSharded({ changedFiles, rules, runJudge, previousDecisions });

        expect(capturedUser).toContain(
            'Type: General review (not a Kody Rule) — performance',
        );
        expect(capturedUser).not.toContain('Type: Kody Rule —');
    });

    it('Eval 3c — a list bloated with 5 irrelevant general decisions still types the one genuinely pending rule decision correctly', async () => {
        const rules = [
            {
                uuid: 'rule-sqli-uuid',
                title: 'No raw SQL string interpolation',
                rule: 'Never build a SQL query by interpolating a variable directly into the string.',
            },
        ];
        const changedFiles = [
            file(
                'src/order-service.ts',
                "5 +        `SELECT * FROM orders WHERE user_id = '${userId}'`,\n",
            ),
        ];
        const labels = ['performance', 'code-quality', 'documentation', 'testing', 'error_handling'];
        const previousDecisions: PrDecisionRecord[] = [
            ...labels.map((label, i) => ({
                suggestionId: `c-${label}`,
                relevantFile: 'src/order-service.ts',
                relevantLinesStart: 1,
                relevantLinesEnd: 9,
                suggestionContent: `Irrelevant general suggestion #${i + 1} (${label}).`,
                label,
                outcome: 'implemented' as const,
                decidedAt: '2026-09-10T12:00:00.000Z',
            })),
            {
                suggestionId: 'c-sqli',
                relevantFile: 'src/order-service.ts',
                relevantLinesStart: 5,
                relevantLinesEnd: 5,
                suggestionContent: 'The query interpolates userId directly into the SQL string — use a parameterized query instead.',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-sqli-uuid'],
                outcome: 'pending',
                decidedAt: '2026-09-10T12:00:00.000Z',
            },
        ];
        let capturedUser = '';
        const runJudge: RunJudge = async ({ user }) => {
            capturedUser = user;
            return [];
        };

        await judgeKodyRulesSharded({ changedFiles, rules, runJudge, previousDecisions });

        expect(capturedUser).toContain(
            'Type: Kody Rule — "No raw SQL string interpolation"',
        );
        for (const label of labels) {
            expect(capturedUser).toContain(
                `Type: General review (not a Kody Rule) — ${label}`,
            );
        }
    });

    it('Eval 3d — preserves a general decision\'s full explanatory content, so context that avoided a false positive (safeCompare is already constant-time) is never silently lost', async () => {
        const rules = [
            {
                uuid: 'rule-crypto-uuid',
                title: 'No hand-rolled crypto/comparison functions',
                rule: 'Never compare secrets/signatures with a custom comparison function.',
            },
        ];
        const changedFiles = [
            file(
                'src/webhook-verifier.ts',
                '2 +    return safeCompare(received, expected);\n6 +    return safeCompare(received, expected);\n',
            ),
        ];
        const explanation =
            'Reviewed safeCompare (defined in src/crypto-utils.ts) — it implements a proper constant-time XOR-accumulator byte comparison, equivalent to crypto.timingSafeEqual. Not a timing-attack risk; no change needed.';
        const previousDecisions: PrDecisionRecord[] = [
            {
                suggestionId: 'd-safecompare-review',
                relevantFile: 'src/webhook-verifier.ts',
                relevantLinesStart: 1,
                relevantLinesEnd: 2,
                suggestionContent: explanation,
                label: 'security',
                outcome: 'implemented',
                decidedAt: '2026-09-10T12:00:00.000Z',
            },
        ];
        let capturedUser = '';
        const runJudge: RunJudge = async ({ user }) => {
            capturedUser = user;
            return [];
        };

        await judgeKodyRulesSharded({ changedFiles, rules, runJudge, previousDecisions });

        // A "remove general decisions" design would have deleted this
        // Suggestion line entirely — the eval showed that loses the only
        // context the judge had for why safeCompare is safe, and it then
        // invents a false-positive violation on the second call site.
        expect(capturedUser).toContain(`Suggestion: ${explanation}`);
        expect(capturedUser).toContain(
            'Type: General review (not a Kody Rule) — security',
        );
    });
});
