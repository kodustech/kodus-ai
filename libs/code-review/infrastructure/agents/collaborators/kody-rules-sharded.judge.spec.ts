import {
    judgeKodyRulesSharded,
    shardViolationsSchema,
    shardViolationsWireSchema,
    RunJudge,
    RawShardViolation,
} from './kody-rules-sharded.judge';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    openRouterHonorsJsonSchema,
    isNeverDowngradeModel,
} from '@libs/llm/structured-output-gate';

// The one genuinely-new runtime risk in the wired provider is the ZOD schema
// (passed to PromptRunnerService.builder().setParser(ParserType.ZOD, ...))
// parsing the model's JSON. The builder/run chain itself is generic infra used
// by every agent. These pin the schema contract against realistic responses.
//
// Rules are presented to the model with 1-based indices ([1], [2], …) and the
// model echoes that index in `ruleId`, NOT the 36-char UUID it used to copy —
// indices are the class of token LLMs corrupt (see #1170), so we removed them
// from the round-trip entirely and resolve index→uuid in code.
describe('shardViolationsSchema — model JSON parsing', () => {
    it('parses a well-formed file-level response with a numeric ruleId', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                {
                    ruleId: 1,
                    relevantLinesStart: 42,
                    relevantLinesEnd: 42,
                    existingCode: 'console.log(x)',
                    suggestionContent: 'WHAT/WHY/HOW',
                    oneSentenceSummary: 'no console',
                },
            ],
        });
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].ruleId).toBe(1);
    });

    it('coerces a stringified index ("2") to a number', () => {
        const r = shardViolationsSchema.parse({
            violations: [{ ruleId: '2', suggestionContent: 'x' }],
        });
        expect(r.violations[0].ruleId).toBe(2);
    });

    it('tolerates a UUID string in ruleId (fallback echo path)', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                { ruleId: 'a-b-c-uuid', suggestionContent: 'needs a test' },
            ],
        });
        expect(r.violations[0].ruleId).toBe('a-b-c-uuid');
    });

    it('defaults to an empty array when the model returns {} or empty', () => {
        expect(shardViolationsSchema.parse({}).violations).toEqual([]);
        expect(
            shardViolationsSchema.parse({ violations: [] }).violations,
        ).toEqual([]);
    });

    it('rejects a violation missing the required ruleId/suggestionContent', () => {
        expect(() =>
            shardViolationsSchema.parse({
                violations: [{ relevantLinesStart: 1 }],
            }),
        ).toThrow();
    });

    // OpenAI structured outputs (strict json_schema) reject any schema whose
    // `required` array doesn't list EVERY key in `properties` — every shard
    // silently errored for BYOK-OpenAI orgs (found live in QA). This pins the
    // ACTUAL wire schema the provider sends (shardViolationsWireSchema), not
    // a local re-derivation: the first fix attempt passed the zod object and
    // the AI SDK's input-side conversion silently re-dropped the preprocess
    // fields from `required`, recreating the 400 in production.
    it('wire schema is OpenAI-strict compatible: every property is required', () => {
        const wire = (shardViolationsWireSchema as any).jsonSchema;
        const items = wire.properties.violations.items;
        expect([...(items.required ?? [])].sort()).toEqual(
            Object.keys(items.properties).sort(),
        );
        // and the array itself is required at the top level
        expect(wire.required).toContain('violations');
    });

    it('wire schema validate() applies the lenient zod parse (missing keys → null)', () => {
        const result = (shardViolationsWireSchema as any).validate({
            violations: [{ ruleId: 1, suggestionContent: 'x' }],
        });
        expect(result.success).toBe(true);
        expect(result.value.violations[0].relevantLinesStart).toBeNull();
    });

    it('accepts strict-provider output where inapplicable keys are null', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                {
                    ruleId: 1,
                    relevantLinesStart: null,
                    relevantLinesEnd: null,
                    language: null,
                    existingCode: null,
                    improvedCode: null,
                    suggestionContent: 'x',
                    oneSentenceSummary: null,
                },
            ],
        });
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].relevantLinesStart).toBeNull();
    });

    it('still tolerates lenient providers that omit the nullable keys entirely', () => {
        const r = shardViolationsSchema.parse({
            violations: [{ ruleId: 2, suggestionContent: 'x' }],
        });
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].relevantLinesStart).toBeNull();
    });

    it('coerces a numeric-string line number instead of failing the shard', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                {
                    ruleId: 1,
                    relevantLinesStart: '42',
                    relevantLinesEnd: ' 43 ',
                    suggestionContent: 'x',
                },
            ],
        });
        expect(r.violations[0].relevantLinesStart).toBe(42);
        expect(r.violations[0].relevantLinesEnd).toBe(43);
    });

    it('line coercion does NOT turn null/empty-string into 0', () => {
        // z.coerce.number() would coerce both to 0 — the null this wire
        // format deliberately produces must survive as null.
        const r = shardViolationsSchema.parse({
            violations: [
                { ruleId: 1, relevantLinesStart: null, suggestionContent: 'x' },
            ],
        });
        expect(r.violations[0].relevantLinesStart).toBeNull();
        expect(() =>
            shardViolationsSchema.parse({
                violations: [
                    {
                        ruleId: 1,
                        relevantLinesStart: '',
                        suggestionContent: 'x',
                    },
                ],
            }),
        ).toThrow();
    });

    it('rejects a WRONG-typed nullable field instead of silently nulling it', () => {
        // missing → null is a wire-format concession; a type mismatch is
        // model garbage and must fail parse (visible via the shard-error
        // log), not degrade to a violation with its line silently dropped.
        expect(() =>
            shardViolationsSchema.parse({
                violations: [
                    {
                        ruleId: 1,
                        relevantLinesStart: 'abc',
                        suggestionContent: 'x',
                    },
                ],
            }),
        ).toThrow();
    });
});

const file = (filename: string, patch: string): any => ({
    filename,
    patchWithLinesStr: patch,
    patch,
});

// A fake runJudge that returns canned raw violations (as the model would emit
// them — a `ruleId` index, or a UUID string on the fallback path) for a given
// (file, ruleId) pair. Lets us assert the deterministic orchestration —
// including index→uuid resolution — without a live model.
function fakeJudge(
    hits: Record<string, Array<{ ruleId: number | string; line?: number }>>,
): {
    run: RunJudge;
    calls: Array<{ filename: string | null; ruleUuids: string[] }>;
} {
    const calls: Array<{ filename: string | null; ruleUuids: string[] }> = [];
    const run: RunJudge = async ({ filename, ruleUuids }) => {
        calls.push({ filename, ruleUuids });
        const key = filename ?? '__PR__';
        return (hits[key] || []).map(
            (h): RawShardViolation => ({
                ruleId: h.ruleId,
                relevantLinesStart: h.line ?? 1,
                suggestionContent: 'x',
                oneSentenceSummary: 's',
            }),
        );
    };
    return { run, calls };
}

describe('judgeKodyRulesSharded — deterministic file×rule sweep (#1449)', () => {
    it('issues one shard per changed file that has applicable rules', async () => {
        const { run, calls } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [
                file('src/a.ts', '1 +const x: any = 1;'),
                file('src/b.ts', '1 +ok();'),
            ],
            rules: [
                { uuid: 'r1', title: 'no any', rule: 'no any', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        // both files match **/*.ts → 2 shards, no PR shard
        expect(res.shardsRun).toBe(2);
        expect(calls.map((c) => c.filename).sort()).toEqual([
            'src/a.ts',
            'src/b.ts',
        ]);
    });

    it('applies the path filter: a file that matches no rule path is not sharded', async () => {
        const { run, calls } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [
                file('src/a.ts', '1 +x'),
                file('docs/readme.md', '1 +hi'),
            ],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsRun).toBe(1);
        expect(calls[0].filename).toBe('src/a.ts');
    });

    it('resolves the ruleId index to the real uuid and anchors the violation to its file', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: 1, line: 5 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '5 +bad')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].relevantFile).toBe('src/a.ts');
        expect(res.violations[0].ruleUuid).toBe('r1');
        expect(res.violations[0].relevantLinesStart).toBe(5);
    });

    it('maps each index to the corresponding rule when a shard has several rules', async () => {
        const { run } = fakeJudge({
            'src/a.ts': [{ ruleId: 2 }, { ruleId: 1 }],
        });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [
                { uuid: 'first', title: 't', rule: 'r', path: '**/*.ts' },
                { uuid: 'second', title: 't', rule: 'r', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        expect(res.violations.map((v) => v.ruleUuid).sort()).toEqual([
            'first',
            'second',
        ]);
    });

    it('drops a violation whose ruleId is out of range (hallucinated index)', async () => {
        const { run } = fakeJudge({
            'src/a.ts': [{ ruleId: 1 }, { ruleId: 5 }, { ruleId: 0 }],
        });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations.map((v) => v.ruleUuid)).toEqual(['r1']);
    });

    // #1170 fallback: if the model reverts to echoing the UUID instead of the
    // index, we still accept an exact match and recover a lightly-corrupted one
    // (edit distance ≤ 2 to exactly one shard rule) rather than dropping it.
    it('accepts a UUID echoed in ruleId, recovering a one-char corruption', async () => {
        const realUuid = '43063446-b519-4acc-9c4d-cc9eb8773a92';
        const corrupted = '43063446-b519-4acc-9c4d-cceb8773a92'; // '9' dropped
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: corrupted }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: realUuid, title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe(realUuid);
    });

    it('drops an echoed UUID that is ambiguous between two rules', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: 'id-x' }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [
                { uuid: 'id-a', title: 't', rule: 'r', path: '**/*.ts' },
                { uuid: 'id-b', title: 't', rule: 'r', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(0);
    });

    // A malformed entry (model omitted ruleId, or echoed the old `ruleUuid`
    // key) must be skipped on its own — not throw and take the whole shard's
    // real violations down with it via the per-shard try/catch.
    it('drops a malformed violation (missing ruleId) without discarding the rest of the shard', async () => {
        const run: RunJudge = async () => [
            { suggestionContent: 'no ruleId here' } as any,
            { ruleUuid: 'r1', suggestionContent: 'old key echoed' } as any,
            { ruleId: 1, relevantLinesStart: 3, suggestionContent: 'valid' },
        ];
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '3 +bad')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsErrored).toBe(0);
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe('r1');
    });

    it('runs PR-scope rules in a single whole-PR shard (no relevantFile)', async () => {
        const { run, calls } = fakeJudge({ __PR__: [{ ruleId: 1 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/b.ts', '1 +y')],
            rules: [
                {
                    uuid: 'pr1',
                    title: 'must have tests',
                    rule: 'every PR needs a test',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ],
            runJudge: run,
        });
        // only the PR shard runs (no file-scope rules)
        expect(res.shardsRun).toBe(1);
        expect(calls[0].filename).toBeNull();
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe('pr1');
        expect(res.violations[0].relevantFile).toBeUndefined();
    });

    it('sends the FULL diff of every changed file to the PR-scope shard', async () => {
        // Regression guard: the sharded refactor originally sent only file
        // NAMES to the PR shard, blinding content-dependent PR-scope rules
        // (the migration-safety rule missed 100% across every model — it
        // could not see `add_index` vs `create_table`). The old agentic path
        // saw the patches; the PR shard must too.
        let prUser = '';
        const run: RunJudge = async ({ filename, user }) => {
            if (filename === null) prUser = user;
            return [];
        };
        await judgeKodyRulesSharded({
            changedFiles: [
                file(
                    'db/migrate/add_index.rb',
                    "6 +    add_index :cases, %i[provider_id last_digested_at]",
                ),
                file('app/models/case.rb', '3 +  belongs_to :provider'),
            ],
            rules: [
                {
                    uuid: 'pr1',
                    title: 'migration safety',
                    rule: 'index changes on existing tables need concurrently',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ],
            runJudge: run,
        });
        expect(prUser).toContain('add_index :cases');
        expect(prUser).toContain('belongs_to :provider');
    });

    it('degrades an over-budget file to a name-only marker in the PR shard (never silently)', async () => {
        let prUser = '';
        const run: RunJudge = async ({ filename, user }) => {
            if (filename === null) prUser = user;
            return [];
        };
        await judgeKodyRulesSharded({
            changedFiles: [
                file('src/huge.ts', '1 +' + 'x'.repeat(200_000)),
                file('src/small.ts', '1 +const a = 1;'),
            ],
            rules: [
                {
                    uuid: 'pr1',
                    title: 't',
                    rule: 'r',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ],
            runJudge: run,
        });
        expect(prUser).toContain(
            "## file: 'src/huge.ts' (diff omitted — PR diff budget exceeded)",
        );
        expect(prUser).toContain('const a = 1;');
    });

    it('counts a shard error without aborting the sweep', async () => {
        let n = 0;
        const run: RunJudge = async ({ filename }) => {
            n++;
            if (filename === 'src/a.ts') throw new Error('llm blew up');
            return [
                { ruleId: 1, suggestionContent: 'x' } as RawShardViolation,
            ];
        };
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/b.ts', '1 +y')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
            concurrency: 1,
        });
        expect(res.shardsRun).toBe(2);
        expect(res.shardsErrored).toBe(1);
        expect(res.violations).toHaveLength(1); // only src/b.ts survived
    });

    it('logs WHY a shard failed instead of swallowing the error', async () => {
        const warn = jest.fn();
        const run: RunJudge = async () => {
            throw new Error(
                "Invalid schema for response_format 'response': Missing 'relevantLinesStart'.",
            );
        };
        await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
            logger: { warn },
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0].message).toContain(
            'Invalid schema for response_format',
        );
        expect(warn.mock.calls[0][0].message).toContain('src/a.ts');
        // SimpleLogger.shouldSkipLog silently drops entries whose context is
        // undefined — without this the warning never reaches production logs.
        expect(warn.mock.calls[0][0].context).toBe('kody-rules-sharded');
    });

    // ── language templating (Starian GitLab MR !16111) ───────────────────────
    // Neither shard prompt had any language templating: a PR-scope kody-rules
    // finding's suggestionContent shipped in raw English regardless of the
    // org's configured Kody Language. `languageLabel` (resolved upstream via
    // prompt-builder.ts's resolveLanguageLabel — the same helper every other
    // review agent uses) must reach BOTH the file-shard and PR-shard user
    // prompts, and must be a no-op (byte-identical prompt) when absent.
    describe('languageLabel — respond-in-language instruction (Starian MR !16111)', () => {
        it('includes a respond-in-language instruction in the FILE-shard user prompt when languageLabel is set', async () => {
            let fileUser = '';
            const run: RunJudge = async ({ filename, user }) => {
                if (filename === 'src/a.ts') fileUser = user;
                return [];
            };
            await judgeKodyRulesSharded({
                changedFiles: [file('src/a.ts', '1 +const x: any = 1;')],
                rules: [
                    { uuid: 'r1', title: 'no any', rule: 'no any', path: '**/*.ts' },
                ],
                runJudge: run,
                languageLabel: 'Portuguese (Brazil)',
            });
            expect(fileUser).toContain('Respond in Portuguese (Brazil)');
            expect(fileUser).toContain('suggestionContent');
        });

        it('includes a respond-in-language instruction in the PR-shard user prompt when languageLabel is set', async () => {
            let prUser = '';
            const run: RunJudge = async ({ filename, user }) => {
                if (filename === null) prUser = user;
                return [];
            };
            await judgeKodyRulesSharded({
                changedFiles: [file('src/a.ts', '1 +x')],
                rules: [
                    {
                        uuid: 'pr1',
                        title: 'must have tests',
                        rule: 'every PR needs a test',
                        scope: KodyRulesScope.PULL_REQUEST,
                    },
                ],
                runJudge: run,
                languageLabel: 'Portuguese (Brazil)',
            });
            expect(prUser).toContain('Respond in Portuguese (Brazil)');
        });

        it('FILE-shard prompt is byte-identical to no-languageLabel behavior when languageLabel is omitted', async () => {
            let withLabelOmitted = '';
            let withLabelUndefined = '';
            const runA: RunJudge = async ({ user }) => {
                withLabelOmitted = user;
                return [];
            };
            const runB: RunJudge = async ({ user }) => {
                withLabelUndefined = user;
                return [];
            };
            const changedFiles = [file('src/a.ts', '1 +const x: any = 1;')];
            const rules = [
                { uuid: 'r1', title: 'no any', rule: 'no any', path: '**/*.ts' },
            ];
            await judgeKodyRulesSharded({
                changedFiles,
                rules,
                runJudge: runA,
            });
            await judgeKodyRulesSharded({
                changedFiles,
                rules,
                runJudge: runB,
                languageLabel: undefined,
            });
            expect(withLabelOmitted).not.toContain('Respond in');
            expect(withLabelOmitted).toBe(withLabelUndefined);
        });

        it('PR-shard prompt is byte-identical to no-languageLabel behavior when languageLabel is omitted', async () => {
            let withLabelOmitted = '';
            let withLabelUndefined = '';
            const runA: RunJudge = async ({ filename, user }) => {
                if (filename === null) withLabelOmitted = user;
                return [];
            };
            const runB: RunJudge = async ({ filename, user }) => {
                if (filename === null) withLabelUndefined = user;
                return [];
            };
            const changedFiles = [file('src/a.ts', '1 +x')];
            const rules = [
                {
                    uuid: 'pr1',
                    title: 'must have tests',
                    rule: 'every PR needs a test',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ];
            await judgeKodyRulesSharded({ changedFiles, rules, runJudge: runA });
            await judgeKodyRulesSharded({
                changedFiles,
                rules,
                runJudge: runB,
                languageLabel: null,
            });
            expect(withLabelOmitted).not.toContain('Respond in');
            expect(withLabelOmitted).toBe(withLabelUndefined);
        });
    });

    it('normalizes null violation fields to absent keys (strict-provider output)', async () => {
        const run: RunJudge = async () => [
            {
                ruleId: 1,
                relevantLinesStart: null,
                relevantLinesEnd: null,
                language: null,
                existingCode: null,
                improvedCode: null,
                suggestionContent: 'x',
                oneSentenceSummary: null,
            } as RawShardViolation,
        ];
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        const v = res.violations[0] as any;
        expect(v.ruleUuid).toBe('r1');
        expect('relevantLinesStart' in v).toBe(false);
        expect('oneSentenceSummary' in v).toBe(false);
        expect(v.suggestionContent).toBe('x');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM.run I/O CONTRACT MATRIX — full closure for this boundary.
//
// Boundary layers:
//   • PARSE layer  = shardViolationsSchema / shardViolationsWireSchema.validate
//     (the SAME safeParse runs in BOTH structured-output-gate branches: strict
//     json_schema for openai/anthropic/google/moonshotai, and json_object
//     fallback for kimi/glm/deepseek/z-ai). Declared type D = {violations:[]}.
//   • ORCHESTRATION layer = judgeKodyRulesSharded(input) → {violations,
//     shardsRun, shardsErrored}. runJudge is the injected LLM.run closure and
//     hands back RawShardViolation[] (already array-typed), so the output-shape
//     zoo (A/B) is exercised at the PARSE layer; transport/fail-safe (C) and
//     input variants (D) are exercised at the ORCHESTRATION layer.
//
// Non-degradation rule (#1786): each off-schema row must RECOVER the payload or
// SIGNAL explicitly (safeParse failure / shard-error log) — never silently
// keep-all/drop/default. Rows where prod silently degrades TODAY are pinned as
// `it.failing` asserting the CORRECT behavior (green now, red when fixed) and
// listed in knownDegradations. Row numbers reference llm-io-contract-matrix.md.
// ═══════════════════════════════════════════════════════════════════════════

const parses = (v: unknown) => shardViolationsSchema.safeParse(v as any).success;

describe('CONTRACT A — output-shape zoo @ parse layer (shardViolationsSchema)', () => {
    // Row 1 — exact D (happy) already asserted above; re-pinned as the anchor.
    it('[row 1] exact D parses and preserves the inner payload', () => {
        const r = shardViolationsSchema.safeParse({
            violations: [{ ruleId: 1, suggestionContent: 'x' }],
        });
        expect(r.success).toBe(true);
        expect(r.success && r.data.violations).toHaveLength(1);
    });

    // ── SIGNAL rows: off-schema shape → safeParse fails, so the provider
    //    runner surfaces/repairs it (shard-error log). NOT a silent default. ──
    it('[row 2] bare array where D is an object → signals (safeParse fails)', () => {
        expect(parses([{ ruleId: 1, suggestionContent: 'x' }])).toBe(false);
    });

    it('[row 3] single object where the violations array is expected → signals', () => {
        expect(parses({ violations: { ruleId: 1, suggestionContent: 'x' } })).toBe(
            false,
        );
    });

    it('[row 7] stringified JSON (whole D as a string) → signals, not silently empty', () => {
        expect(
            parses(JSON.stringify({ violations: [{ ruleId: 1, suggestionContent: 'x' }] })),
        ).toBe(false);
    });

    it('[row 8] markdown-fenced JSON string → signals', () => {
        expect(parses('```json\n{"violations":[]}\n```')).toBe(false);
    });

    it('[row 9] prose-wrapped JSON string → signals', () => {
        expect(parses('Here is the result: {"violations":[]}')).toBe(false);
    });

    it('[row 10] right data with renamed item keys (rule_id/content) → signals', () => {
        expect(parses({ violations: [{ rule_id: 1, content: 'x' }] })).toBe(false);
    });

    it('[row 11] item-level case mismatch (RuleId/SuggestionContent) → signals', () => {
        expect(
            parses({ violations: [{ RuleId: 1, SuggestionContent: 'x' }] }),
        ).toBe(false);
    });

    it('[row 12] partial item (ruleId present, suggestionContent missing) → signals', () => {
        expect(parses({ violations: [{ ruleId: 1 }] })).toBe(false);
    });

    it('[row 16] empty string / whitespace-only → signals', () => {
        expect(parses('')).toBe(false);
        expect(parses('   \n\t ')).toBe(false);
    });

    it('[row 17] null / undefined → signals', () => {
        expect(parses(null)).toBe(false);
        expect(parses(undefined)).toBe(false);
    });

    it('[row 18] primitive where object expected (true/0/"ok") → signals', () => {
        expect(parses(true)).toBe(false);
        expect(parses(0)).toBe(false);
        expect(parses('ok')).toBe(false);
    });

    it('[row 20] reasoning/thinking prose leaked as content → signals (real strip is in the SDK)', () => {
        // anthropic thinking-without-signature is repaired inside @ai-sdk/anthropic
        // upstream of this parse layer; if raw thinking prose ever reaches here it
        // arrives as a non-object string and fails parse rather than nulling out.
        expect(
            parses('<thinking>let me reason…</thinking>\n{"violations":[]}'),
        ).toBe(false);
    });

    // ── TOLERATE rows: off-schema-but-benign → parse succeeds, payload kept. ──
    it('[row 13] extra unknown keys are stripped, the real violation survives', () => {
        const r = shardViolationsSchema.safeParse({
            violations: [{ ruleId: 1, suggestionContent: 'x', foo: 1, bar: 2 }],
            meta: 'ignored',
        } as any);
        expect(r.success).toBe(true);
        expect(r.success && r.data.violations).toHaveLength(1);
    });

    it('[row 14] empty object {} → legit "no violations", defaults to []', () => {
        const r = shardViolationsSchema.safeParse({});
        expect(r.success && r.data.violations).toEqual([]);
    });

    it('[row 15] empty violations array → []', () => {
        const r = shardViolationsSchema.safeParse({ violations: [] });
        expect(r.success && r.data.violations).toEqual([]);
    });

    it('[row 27] unicode / emoji / escaped newlines inside string fields survive intact', () => {
        const r = shardViolationsSchema.safeParse({
            violations: [
                {
                    ruleId: 1,
                    suggestionContent: 'café 😀\nlinha 2 — travessão',
                    existingCode: 'const x = "λ";',
                },
            ],
        });
        expect(r.success).toBe(true);
        expect(r.success && r.data.violations[0].suggestionContent).toBe(
            'café 😀\nlinha 2 — travessão',
        );
    });
});

describe('CONTRACT A — SILENT-DEGRADATION guards @ parse layer (#1786 class)', () => {
    // ROOT CAUSE for every it.failing below: shardViolationsSchema.violations is
    // `.default([])` (kody-rules-sharded.judge.ts:96) and z.object strips unknown
    // keys. So ANY payload whose top-level `violations` key is ABSENT — because it
    // sits under a wrapper, a mis-cased key, or an error/envelope object — parses
    // as SUCCESS with an EMPTY list: a wrong "no violations" answer ships with no
    // signal, indistinguishable from a genuine empty {} (row 14). The correct
    // behavior is to RECOVER the wrapped payload OR SIGNAL (safeParse failure).
    // These are green today (assertion currently fails) and turn red on the fix.

    it.failing('[row 4] wrapper key {result:D} must recover or signal — not silently empty', () => {
        const wrapped = { result: { violations: [{ ruleId: 1, suggestionContent: 'x' }] } };
        // correct: either the real violation is recovered …
        const r = shardViolationsSchema.safeParse(wrapped as any);
        expect(r.success && r.data.violations.length).toBe(1);
    });

    it.failing('[row 4b] wrapper key {data:D} must recover or signal', () => {
        const r = shardViolationsSchema.safeParse({
            data: { violations: [{ ruleId: 1, suggestionContent: 'x' }] },
        } as any);
        // correct: signal the missing-key rather than default to empty.
        expect(r.success).toBe(false);
    });

    it.failing('[row 5] double wrapper {result:{result:D}} must recover or signal', () => {
        const r = shardViolationsSchema.safeParse({
            result: { result: { violations: [{ ruleId: 1, suggestionContent: 'x' }] } },
        } as any);
        expect(r.success).toBe(false);
    });

    it.failing('[row 6] numeric/opaque single-key wrap {content:D} must recover or signal', () => {
        const r = shardViolationsSchema.safeParse({
            content: { violations: [{ ruleId: 1, suggestionContent: 'x' }] },
        } as any);
        expect(r.success).toBe(false);
    });

    it.failing('[row 6b] numeric-key wrap {"0":D} must recover or signal', () => {
        const r = shardViolationsSchema.safeParse({
            '0': { violations: [{ ruleId: 1, suggestionContent: 'x' }] },
        } as any);
        expect(r.success).toBe(false);
    });

    it.failing('[row 3b] a single bare violation object at top-level must recover or signal', () => {
        // model dropped the {violations:[…]} envelope and emitted one violation.
        const r = shardViolationsSchema.safeParse({
            ruleId: 1,
            suggestionContent: 'x',
        } as any);
        expect(r.success).toBe(false);
    });

    it.failing('[row 11b] top-level key case mismatch {Violations:D} must recover or signal', () => {
        const r = shardViolationsSchema.safeParse({
            Violations: [{ ruleId: 1, suggestionContent: 'x' }],
        } as any);
        expect(r.success).toBe(false);
    });

    it.failing('[row 19] provider-envelope leak {choices:[{message:{content}}]} must signal', () => {
        // Normally the AI SDK unwraps choices/tool_call before content reaches
        // validate; a stray envelope in the json_object path must not parse to a
        // silent empty list.
        const r = shardViolationsSchema.safeParse({
            choices: [{ message: { content: '{"violations":[]}' } }],
        } as any);
        expect(r.success).toBe(false);
    });

    it.failing('[row 31] error object {error:…} returned as content must signal, not empty', () => {
        const r = shardViolationsSchema.safeParse({
            error: 'rate limited',
        } as any);
        expect(r.success).toBe(false);
    });
});

describe('CONTRACT B — semantic-but-wrong @ parse + resolve layers', () => {
    // Rows 21/22/23 (boolean encodings) and 24 (enum/severity) are N/A: the
    // shard schema has no boolean and no enum/severity field. Row 26 (duplicate
    // JSON keys) is resolved last-wins by JSON.parse before an object reaches
    // zod, so it is not observable at this boundary. See rowsNA.

    it('[row 25] ruleId index out of range is dropped (not mapped to a bogus rule)', async () => {
        const { run } = fakeJudge({
            'src/a.ts': [{ ruleId: 1 }, { ruleId: 99 }, { ruleId: -3 }],
        });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        // only the in-range index [1] survives; dangling refs are dropped.
        expect(res.violations.map((v) => v.ruleUuid)).toEqual(['r1']);
    });

    it('[row 25b] numeric-string ruleId that is out of range is also dropped', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: '7' }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(0);
    });
});

describe('CONTRACT C — unparseable / transport fail-safe @ orchestration layer', () => {
    beforeEach(() => jest.clearAllMocks());

    it('[row 28] truncated-JSON parse error inside runJudge → degrade to [] + logged, never throws', async () => {
        const warn = jest.fn();
        const run: RunJudge = async () => {
            throw new SyntaxError('Unexpected end of JSON input');
        };
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
            logger: { warn },
        });
        expect(res.violations).toHaveLength(0);
        expect(res.shardsErrored).toBe(1);
        expect(warn.mock.calls[0][0].context).toBe('kody-rules-sharded');
    });

    it('[row 29] malformed JSON (throw from runJudge) → fail-safe degrade, boundary returns shape', async () => {
        const run: RunJudge = async () => {
            throw new Error('invalid JSON: trailing comma');
        };
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res).toEqual({ violations: [], shardsRun: 1, shardsErrored: 1 });
    });

    // [row 30] LLM.run throws (network/timeout) is asserted above
    // ('counts a shard error without aborting the sweep' / 'logs WHY a shard failed').

    it('[row 31] runJudge that resolves an error-shaped array item drops that item, keeps the rest', async () => {
        // If the transport surfaces an error object as a pseudo-violation (no
        // resolvable ruleId), resolveRuleId drops it without taking the shard down.
        const run: RunJudge = async () => [
            { error: 'rate limited' } as any,
            { ruleId: 1, suggestionContent: 'valid' },
        ];
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsErrored).toBe(0);
        expect(res.violations.map((v) => v.ruleUuid)).toEqual(['r1']);
    });

    it('[row 32] empty success (runJudge resolves []) → 0 findings, 0 errors, shard counted', async () => {
        const run: RunJudge = async () => [];
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res).toEqual({ violations: [], shardsRun: 1, shardsErrored: 0 });
    });

    it('[row 33] refusal prose reaching the parse layer → signals (not a silent empty)', () => {
        expect(parses('I cannot help with this request.')).toBe(false);
    });

    it('[row 34] abort fired inside runJudge (AbortError reject) → fail-safe, no throw past boundary', async () => {
        // The boundary does not thread abortSignal itself; the injected closure
        // owns it, so an abort surfaces as a rejection and must degrade like any
        // other shard error rather than crashing the sweep.
        const abortErr = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
        });
        const run: RunJudge = async () => {
            throw abortErr;
        };
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsErrored).toBe(1);
        expect(res.violations).toHaveLength(0);
    });
});

describe('CONTRACT D — input variants @ orchestration layer', () => {
    it('[row 35] empty input (0 files) → no shards, canonical empty result', async () => {
        const { run, calls } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res).toEqual({ violations: [], shardsRun: 0, shardsErrored: 0 });
        expect(calls).toHaveLength(0);
    });

    it('[row 35b] empty rules → no shards even with changed files', async () => {
        const { run } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [],
            runJudge: run,
        });
        expect(res).toEqual({ violations: [], shardsRun: 0, shardsErrored: 0 });
    });

    it('[row 36] single file + single rule → exactly one shard', async () => {
        const { run, calls } = fakeJudge({ 'src/a.ts': [{ ruleId: 1 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsRun).toBe(1);
        expect(calls).toHaveLength(1);
        expect(res.violations).toHaveLength(1);
    });

    it('[row 37] large input crossing the PR diff-budget chunk → over-budget files degrade to a marker', async () => {
        let prUser = '';
        const run: RunJudge = async ({ filename, user }) => {
            if (filename === null) prUser = user;
            return [];
        };
        await judgeKodyRulesSharded({
            changedFiles: [
                file('src/huge.ts', '1 +' + 'x'.repeat(200_000)),
                file('src/tail.ts', '1 +const a = 1;'),
            ],
            rules: [
                { uuid: 'pr1', title: 't', rule: 'r', scope: KodyRulesScope.PULL_REQUEST },
            ],
            runJudge: run,
        });
        expect(prUser).toContain(
            "## file: 'src/huge.ts' (diff omitted — PR diff budget exceeded)",
        );
        expect(prUser).toContain('const a = 1;');
    });

    it('[row 38] duplicate input files each get their own shard (dedup is downstream)', async () => {
        const { run, calls } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsRun).toBe(2);
        expect(calls.filter((c) => c.filename === 'src/a.ts')).toHaveLength(2);
    });

    it('[row 38b] duplicate rules keep index alignment (both indices resolve)', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: 1 }, { ruleId: 2 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [
                { uuid: 'dup', title: 't', rule: 'r', path: '**/*.ts' },
                { uuid: 'dup', title: 't', rule: 'r', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        expect(res.violations.map((v) => v.ruleUuid)).toEqual(['dup', 'dup']);
    });

    it('[row 39] input items with null/undefined required fields do not crash the boundary', async () => {
        // rule missing uuid → its ruleUuids slot is '' → a violation for it is
        // dropped (unmappable) rather than throwing; a null-patch file yields an
        // empty diff and still shards cleanly.
        const nullPatchFile: any = {
            filename: 'src/a.ts',
            patch: null,
            patchWithLinesStr: null,
        };
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: 1 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [nullPatchFile],
            rules: [{ title: 't', rule: 'r', path: '**/*.ts' } as any], // no uuid
            runJudge: run,
        });
        expect(res.shardsRun).toBe(1);
        expect(res.shardsErrored).toBe(0);
        expect(res.violations).toHaveLength(0); // uuid-less rule → dropped, not thrown
    });

    it('[row 40] special-chars / whitespace-only diff is threaded to the prompt without crashing', async () => {
        let fileUser = '';
        const run: RunJudge = async ({ user }) => {
            fileUser = user;
            return [];
        };
        const weird = '1 +const s = "\t 💥 <script> λ";';
        await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', weird)],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(fileUser).toContain('💥 <script>');
    });

    it('[row 41] file exactly at the PR diff budget is INCLUDED; one char over is OMITTED', async () => {
        const atBudget = '\n'.repeat(150_000); // exactly PR_SHARD_DIFF_BUDGET_CHARS
        const overBudget = '\n'.repeat(150_001);
        let includedPrompt = '';
        let omittedPrompt = '';
        const runInc: RunJudge = async ({ filename, user }) => {
            if (filename === null) includedPrompt = user;
            return [];
        };
        const runOmit: RunJudge = async ({ filename, user }) => {
            if (filename === null) omittedPrompt = user;
            return [];
        };
        const prRule = {
            uuid: 'pr1',
            title: 't',
            rule: 'r',
            scope: KodyRulesScope.PULL_REQUEST,
        };
        await judgeKodyRulesSharded({
            changedFiles: [file('src/at.ts', atBudget)],
            rules: [prRule],
            runJudge: runInc,
        });
        await judgeKodyRulesSharded({
            changedFiles: [file('src/over.ts', overBudget)],
            rules: [prRule],
            runJudge: runOmit,
        });
        expect(includedPrompt).not.toContain('diff omitted — PR diff budget exceeded');
        expect(omittedPrompt).toContain(
            "## file: 'src/over.ts' (diff omitted — PR diff budget exceeded)",
        );
    });

    it('[row 42] file-order permutation → identical violation set (order-invariant aggregation)', async () => {
        const hits = {
            'src/a.ts': [{ ruleId: 1 }],
            'src/b.ts': [{ ruleId: 1 }],
        };
        const rules = [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }];
        const key = (vs: any[]) =>
            vs
                .map((v) => `${v.ruleUuid}@${v.relevantFile}`)
                .sort()
                .join('|');
        const forward = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/b.ts', '1 +y')],
            rules,
            runJudge: fakeJudge(hits).run,
        });
        const reversed = await judgeKodyRulesSharded({
            changedFiles: [file('src/b.ts', '1 +y'), file('src/a.ts', '1 +x')],
            rules,
            runJudge: fakeJudge(hits).run,
        });
        expect(key(forward.violations)).toBe(key(reversed.violations));
        expect(forward.violations).toHaveLength(2);
    });
});

describe('CONTRACT E — N-model policy branches (structured-output-gate)', () => {
    // The boundary DELEGATES model policy to the provider, which uses
    // structured-output-gate to pick strict json_schema vs json_object. Both
    // branches route model output through the SAME shardViolationsWireSchema
    // (strict jsonSchema for the wire + a lenient zod validate). So:
    //   • strict branch trusts clean D (and the wire schema must be OpenAI-strict
    //     compatible — every key required);
    //   • fallback branch puts the full A/B/C zoo above in scope, and the SAME
    //     lenient validate must still recover/signal it.

    it('classifies the strict-json_schema prefixes (openai/anthropic/google/moonshotai)', () => {
        for (const m of [
            'openai/gpt-5.4',
            'anthropic/claude-opus-4',
            'google/gemini-2.5-pro',
            'moonshotai/kimi-k2',
        ]) {
            expect(openRouterHonorsJsonSchema(m)).toBe(true);
        }
    });

    it('classifies the json_object fallback models (kimi/glm/deepseek/z-ai) as NOT strict', () => {
        for (const m of [
            'deepseek/deepseek-v3',
            'z-ai/glm-4.6',
            'x-ai/grok-4',
            'some-vendor/kimi-dev', // "kimi" is not a strict prefix
        ]) {
            expect(openRouterHonorsJsonSchema(m)).toBe(false);
        }
        // …but kimi/moonshot are never DOWNGRADED off native json_schema.
        expect(isNeverDowngradeModel('some-vendor/kimi-dev')).toBe(true);
        expect(isNeverDowngradeModel('deepseek/deepseek-v3')).toBe(false);
    });

    it('[strict branch] wire schema is OpenAI-strict compatible → provider trusts clean D', () => {
        const wire = (shardViolationsWireSchema as any).jsonSchema;
        const items = wire.properties.violations.items;
        expect([...(items.required ?? [])].sort()).toEqual(
            Object.keys(items.properties).sort(),
        );
        expect(wire.required).toContain('violations');
        // clean D still round-trips through the validate step.
        const r = (shardViolationsWireSchema as any).validate({
            violations: [{ ruleId: 1, suggestionContent: 'x' }],
        });
        expect(r.success).toBe(true);
    });

    it('[fallback branch] the SAME lenient validate recovers/normalizes off-schema output', () => {
        // Proves the A/B zoo above is genuinely in-scope for json_object models:
        // the provider hands raw JSON to this exact validate.
        const recovered = (shardViolationsWireSchema as any).validate({
            violations: [{ ruleId: '2', relevantLinesStart: '42', suggestionContent: 'x' }],
        });
        expect(recovered.success).toBe(true);
        expect(recovered.value.violations[0].ruleId).toBe(2); // coerced
        expect(recovered.value.violations[0].relevantLinesStart).toBe(42); // coerced
        // …and genuine garbage still SIGNALS (does not silently null).
        const signalled = (shardViolationsWireSchema as any).validate({
            violations: [{ ruleId: 1, relevantLinesStart: 'abc', suggestionContent: 'x' }],
        });
        expect(signalled.success).toBe(false);
    });
});

describe('CONTRACT — boundary ALWAYS returns its declared shape', () => {
    it('returns {violations,shardsRun,shardsErrored} with correct types even when every shard errors', async () => {
        const run: RunJudge = async () => {
            throw new Error('all shards down');
        };
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/b.ts', '1 +y')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
            concurrency: 2,
        });
        expect(Array.isArray(res.violations)).toBe(true);
        expect(res.violations).toHaveLength(0);
        expect(typeof res.shardsRun).toBe('number');
        expect(typeof res.shardsErrored).toBe('number');
        expect(res.shardsRun).toBe(2);
        expect(res.shardsErrored).toBe(2);
    });
});

// ── #1831: what the shard ASKS FOR determines what a finding looks like ─────
describe('#1831 — the file-shard prompt asks for a complete, applicable finding', () => {
    const captureUser = async (rules: any[], detectorHits?: any) => {
        let user = '';
        const runJudge: RunJudge = async (args) => {
            user = args.user;
            return [];
        };
        await judgeKodyRulesSharded({
            changedFiles: [
                {
                    filename: 'app/models/user.rb',
                    patchWithLinesStr: '3 +    return false if x == nil',
                } as any,
            ],
            rules,
            runJudge,
            detectorHits,
        });
        return user;
    };

    it('asks for improvedCode and language, which the wire schema has always required', () => {
        // Both keys are REQUIRED by shardViolationsWireSchema, but the return
        // template never showed them, so models filled them with null and every
        // sharded kody-rules finding shipped with no fix to apply and no
        // language for the diff block. #1831 needs a detector-derived finding to
        // carry an applicable improvedCode; those now come through this shard,
        // so asking here fixes the whole stream.
        return captureUser([{ uuid: 'r1', title: 't', rule: 'no nil compare' }]).then((user) => {
            expect(user).toContain('"improvedCode"');
            expect(user).toContain('"language"');
            // null stays legal: a rule like "use the structured logger" has no
            // line-level replacement the model can write without knowing the
            // project's logger, and inventing one is worse than omitting it.
            expect(user).toMatch(/use null only when the fix cannot be expressed/);
        });
    });

    it('tells the model to strip the diff prefix from existingCode', () => {
        // Without this, models copy the shard line verbatim — `266 +  console.log(`
        // — and the '+' leaks into the published comment and into anchoring.
        return captureUser([{ uuid: 'r1', title: 't', rule: 'no nil compare' }]).then((user) => {
            expect(user).toMatch(/strip the line-number and '\+' prefix/);
        });
    });

    it('keeps the candidate block out of a purely semantic shard', () => {
        // No detector rules in the review = byte-identical prompt to before
        // #1831, so nothing regresses for the orgs that have no T0 rules.
        return captureUser([{ uuid: 'r1', title: 't', rule: 'no nil compare' }]).then((user) => {
            expect(user).not.toContain('<Candidates>');
        });
    });
});
