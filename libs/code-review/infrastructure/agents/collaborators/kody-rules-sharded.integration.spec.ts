/**
 * Wiring validation for the sharded kody-rules path (#1449): the NEW integration
 * points beyond the pure judge (already unit-tested) are (a) ShardViolation →
 * real mapAgentFindings → CodeSuggestion, and (b) which rules count as judged
 * without their referenced files. Both are exercised here with the REAL shared
 * collaborators and no LLM — the live LLM call is generic infra and the
 * prompt/recall is validated separately by evals/kody-rules/sharded-experiment.js.
 */
import {
    judgeKodyRulesSharded,
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
        {
            uuid: 'no-console',
            title: 'no console',
            rule: 'no console.log',
            path: '**/*.ts',
        },
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

    // A rule written with no @file mention still gets a context reference,
    // with no file to load: nothing was lost, so it is not judged blind.
    it('does NOT flag a rule whose reference names no file', () => {
        const out = findUnresolvedReferenceRules(
            [r() as any, r({ uuid: 'r2' }) as any],
            new Map(),
            new Set(['r1']),
        );
        expect(out.map((x) => x.uuid)).toEqual(['r2']);
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
    // collectLoadedReferences keeps nothing (content.trim() empty) — must
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
                suggestionContent:
                    'This log call needs to follow team logging standards.',
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

    // Eval-backed (PR #1895 investigation): dropping a general decision that
    // explained why a helper is already safe made the judge invent a false
    // positive in 3/3 runs; keeping it, labeled, stayed silent in 3/3.
    it("preserves a general decision's full explanatory content, so context that avoided a false positive (safeCompare is already constant-time) is never silently lost", async () => {
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

        await judgeKodyRulesSharded({
            changedFiles,
            rules,
            runJudge,
            previousDecisions,
        });

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
