// The LLM.run boundary is mocked with a factory so the heavy @libs/llm import
// chain (structured-review-call / model-failover / byok) never loads under jest;
// every test drives the exact envelope the model layer would hand back.
jest.mock('@libs/llm/llm', () => ({
    LLM: { run: jest.fn() },
}));

import { LLM } from '@libs/llm/llm';
import {
    ClassifySessionUseCase,
    LLMDecisionExtractionSchema,
} from './classify-session.use-case';

const llmRun = LLM.run as jest.Mock;

/**
 * The deterministic core of CLI-session classification: it turns a raw event
 * stream into an aggregated session, and normalizes the model's output before it
 * is stored (clamping confidence, keeping invented scope paths out, typing the
 * decision). These are pure — no repo, no model — so they are exercised directly.
 */
describe('ClassifySessionUseCase — pure aggregation & normalization', () => {
    const uc = new ClassifySessionUseCase({} as any, {} as any);
    const call = (m: string, ...args: any[]) => (uc as any)[m](...args);

    describe('aggregateEvents', () => {
        const ev = (type: string, payload: any = {}) => ({ type, payload });

        it('collects prompts and responses, skipping empty / whitespace-only ones', () => {
            const agg = call('aggregateEvents', [
                ev('turn_start', { turnId: 't1', prompt: 'do X' }),
                ev('turn_start', { turnId: 't2', prompt: '   ' }), // blank → skipped
                ev('turn_end', { turnId: 't1', response: 'done' }),
                ev('turn_end', { turnId: 't2', response: '' }), // blank → skipped
            ]);
            expect(agg.prompts).toEqual(['do X']);
            expect(agg.responses).toEqual(['done']);
        });

        it('parses toolCalls as plain strings OR {toolName|tool, summary} objects', () => {
            const agg = call('aggregateEvents', [
                ev('turn_end', {
                    toolCalls: [
                        'grep',
                        { toolName: 'Read', summary: 'file.ts' },
                        { tool: 'Bash' },
                    ],
                }),
            ]);
            expect(agg.toolCalls).toEqual(['grep', 'Read: file.ts', 'Bash']);
        });

        it('parses filesModified as strings OR {path}, and DEDUPES them', () => {
            const agg = call('aggregateEvents', [
                ev('turn_end', {
                    filesModified: ['a.ts', { path: 'b.ts' }, 'a.ts'],
                }),
            ]);
            expect(agg.filesModified).toEqual(['a.ts', 'b.ts']);
        });

        it('pairs a turn_end with its turn_start by turnId', () => {
            const agg = call('aggregateEvents', [
                ev('turn_start', { turnId: 't1', prompt: 'ask' }),
                ev('turn_end', { turnId: 't1', response: 'reply', toolCalls: ['grep'] }),
            ]);
            expect(agg.turns).toHaveLength(1);
            expect(agg.turns[0]).toMatchObject({
                prompt: 'ask',
                response: 'reply',
                toolCalls: ['grep'],
            });
        });

        it('flushes an orphaned turn_start that never got a turn_end', () => {
            const agg = call('aggregateEvents', [
                ev('turn_start', { turnId: 't1', prompt: 'ask' }),
            ]);
            expect(agg.turns).toHaveLength(1);
            expect(agg.turns[0].prompt).toBe('ask');
        });
    });

    describe('hasUsefulContent — filesRead and commands alone do NOT count', () => {
        const base = {
            prompts: [],
            responses: [],
            toolCalls: [],
            filesModified: [],
            subagents: [],
            filesRead: [],
            commands: [],
        };

        it('is true when any of prompts/responses/toolCalls/filesModified/subagents is present', () => {
            expect(call('hasUsefulContent', { ...base, prompts: ['x'] })).toBe(true);
            expect(call('hasUsefulContent', { ...base, subagents: [{}] })).toBe(true);
        });

        it('is false for an empty session — and for one that only READ files or ran commands', () => {
            expect(call('hasUsefulContent', base)).toBe(false);
            expect(
                call('hasUsefulContent', {
                    ...base,
                    filesRead: ['a.ts'],
                    commands: ['ls'],
                }),
            ).toBe(false);
        });
    });

    describe('inferDecisionType — keyword classification with precedence', () => {
        it.each([
            ['we changed the database schema', 'architectural_decision'],
            ['naming convention for files', 'convention'],
            ['X versus Y, a real tradeoff', 'tradeoff'],
            ['upgrade the claude sdk', 'tooling'],
            ['refactor the jwt middleware', 'implementation_detail'],
            ['just some small talk', 'other'],
        ])('classifies %j as %s', (text, expected) => {
            expect(call('inferDecisionType', text)).toBe(expected);
        });

        it('architectural wins over implementation when both keywords appear', () => {
            // "schema" (architectural) is checked before "implement".
            expect(call('inferDecisionType', 'implement the schema')).toBe(
                'architectural_decision',
            );
        });
    });

    describe('shouldAutoPromote', () => {
        it('promotes ONLY high-confidence architectural / convention / tradeoff decisions', () => {
            expect(call('shouldAutoPromote', 'architectural_decision', 0.7)).toBe(true);
            expect(call('shouldAutoPromote', 'convention', 0.9)).toBe(true);
            expect(call('shouldAutoPromote', 'tradeoff', 0.75)).toBe(true);
        });

        it('does not promote below the 0.7 bar, a non-promotable type, or a non-number confidence', () => {
            expect(call('shouldAutoPromote', 'architectural_decision', 0.69)).toBe(false);
            expect(call('shouldAutoPromote', 'tooling', 0.95)).toBe(false);
            expect(call('shouldAutoPromote', 'convention', undefined)).toBe(false);
        });
    });

    describe('normalizeConfidence — clamp to [0,1]', () => {
        it('clamps out-of-range values and passes valid ones through', () => {
            expect(call('normalizeConfidence', 0.5)).toBe(0.5);
            expect(call('normalizeConfidence', 1.5)).toBe(1);
            expect(call('normalizeConfidence', -0.2)).toBe(0);
        });

        it('returns undefined for non-numbers and NaN', () => {
            expect(call('normalizeConfidence', undefined)).toBeUndefined();
            expect(call('normalizeConfidence', NaN)).toBeUndefined();
            expect(call('normalizeConfidence', 'x')).toBeUndefined();
        });
    });

    describe('normalizePath', () => {
        it('converts back-slashes and strips ./ and leading/trailing slashes', () => {
            expect(call('normalizePath', '.\\src\\a.ts')).toBe('src/a.ts');
            expect(call('normalizePath', '/src/a.ts/')).toBe('src/a.ts');
            expect(call('normalizePath', './a.ts')).toBe('a.ts');
        });

        it('returns "" for a non-string input', () => {
            expect(call('normalizePath', 42)).toBe('');
        });
    });

    describe('normalizeScope — keeps only paths the session actually touched (anti-hallucination)', () => {
        it('drops a model-invented path that is not under any modified file', () => {
            const scope = call(
                'normalizeScope',
                ['src/a.ts', 'made/up.ts'],
                ['src/a.ts'],
            );
            expect(scope).toEqual(['src/a.ts']); // made/up.ts dropped
        });

        it('keeps a directory PREFIX of a modified file', () => {
            expect(call('normalizeScope', ['src'], ['src/a.ts'])).toEqual(['src']);
        });

        it('falls back to the modified files when no requested scope is valid', () => {
            const scope = call(
                'normalizeScope',
                ['totally/invented.ts'],
                ['src/a.ts', 'src/b.ts'],
            );
            expect(scope).toEqual(['src/a.ts', 'src/b.ts']);
        });
    });
});

/**
 * The LLM.run I/O contract for `extractWithLLM` — the single structured-output
 * boundary of this use-case. It asserts request assembly (exact schema / system
 * / user / runName / org / byokConfig threading), envelope parsing
 * (`result?.decisions ?? []`), the guaranteed `CliSessionClassifiedDecision[]`
 * return shape, and — via `execute()` — the documented fail-safe to heuristics.
 *
 * Scope is the deterministic layer only: assembly, parse, fallback, return
 * shape. It never asserts whether a classification is *correct* (eval track).
 */
describe('ClassifySessionUseCase.extractWithLLM — LLM.run I/O contract', () => {
    const uc = new ClassifySessionUseCase({} as any, {} as any);
    const extract = (agg: any, orgId?: string) =>
        (uc as any).extractWithLLM(agg, orgId);

    // A minimal aggregated session that assembly walks over.
    const agg = (over: any = {}) => ({
        agentType: 'claude-code',
        gitRemote: 'git@x:y.git',
        turns: [],
        prompts: [],
        responses: [],
        toolCalls: [],
        filesModified: [],
        filesRead: [],
        commands: [],
        subagents: [],
        ...over,
    });

    // One well-formed decision item (the "inner" payload the code wants).
    const decision = (over: any = {}) => ({
        type: 'convention',
        origin: 'human',
        decision: 'use kebab-case for files',
        rationale: 'team standard',
        confidence: 0.8,
        evidence: ['README.md'],
        scope: ['src/a.ts'],
        ...over,
    });

    afterEach(() => {
        llmRun.mockReset();
    });

    // ── Request assembly (the deterministic call the boundary makes) ──────────
    describe('request assembly', () => {
        // Row 1 (side effect must be exact) + E delegation: the boundary always
        // requests structured output with the exported schema, leaving the
        // strict-vs-fallback model policy (structured-output-gate) to LLM.run.
        it('calls LLM.run once with the exact schema / system / user / runName / org / byokConfig', async () => {
            llmRun.mockResolvedValue({ decisions: [] });

            await extract(
                agg({
                    turns: [
                        {
                            prompt: 'ask',
                            response: 'reply',
                            toolCalls: ['grep', 'read'],
                            filesModified: ['src/a.ts'],
                        },
                    ],
                    filesModified: ['src/a.ts'],
                    filesRead: ['src/b.ts'],
                    commands: ['ls'],
                    subagents: [{ type: 'x', task: 't' }],
                }),
                'org-42',
            );

            expect(llmRun).toHaveBeenCalledTimes(1);
            const req = llmRun.mock.calls[0][0];
            expect(req.schema).toBe(LLMDecisionExtractionSchema);
            expect(req.runName).toBe(
                'ClassifySessionUseCase::classifySession',
            );
            expect(req.organizationId).toBe('org-42');
            expect(req.byokConfig).toBeUndefined();
            expect(req.system).toContain(
                'classifying a complete coding session',
            );
            // user is the JSON-encoded, capped payload
            const payload = JSON.parse(req.user);
            expect(payload).toMatchObject({
                agentType: 'claude-code',
                gitRemote: 'git@x:y.git',
                turns: [
                    {
                        prompt: 'ask',
                        response: 'reply',
                        toolCalls: ['grep', 'read'],
                        filesModified: ['src/a.ts'],
                    },
                ],
                filesModified: ['src/a.ts'],
            });
        });
    });

    // ── A. Output-shape zoo ──────────────────────────────────────────────────
    describe('A. output-shape zoo', () => {
        // Row 1 — exact D, full mapping is exact.
        it('[1] exact D → maps every field and flags autoPromote', async () => {
            llmRun.mockResolvedValue({ decisions: [decision()] });
            const res = await extract(agg({ filesModified: ['src/a.ts'] }));
            expect(res).toEqual([
                {
                    type: 'convention',
                    origin: 'human',
                    decision: 'use kebab-case for files',
                    rationale: 'team standard',
                    confidence: 0.8,
                    evidence: ['README.md'],
                    scope: ['src/a.ts'],
                    autoPromoteCandidate: true, // convention + 0.8 ≥ 0.7
                },
            ]);
        });

        // Row 2 — bare array of inner items instead of {decisions:[...]}.
        // Prod: `result?.decisions` is undefined → [] → the real payload is
        // silently dropped (classify-session.use-case.ts:362). #1786 class.
        it.failing(
            '[2] bare array of decisions → SHOULD recover, not silently drop',
            async () => {
                llmRun.mockResolvedValue([decision()] as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );

        // Row 3a — a single decision object at the top level (no wrapper).
        // Prod: `.decisions` undefined → [] → dropped. #1786 class.
        it.failing(
            '[3] single decision object (no {decisions} wrapper) → SHOULD recover',
            async () => {
                llmRun.mockResolvedValue(decision() as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );

        // Row 3b — decisions as a single object instead of an array. rawDecisions
        // is truthy but has no .map → the boundary throws (an explicit signal,
        // not a silent wrong answer; execute() then fails safe to heuristics).
        it('[3] decisions:{object} (not array) → throws explicitly (signalled)', async () => {
            llmRun.mockResolvedValue({ decisions: decision() } as any);
            await expect(
                extract(agg({ filesModified: ['src/a.ts'] })),
            ).rejects.toBeInstanceOf(TypeError);
        });

        // Rows 4/5/6 — wrapper keys around D. Prod: `.decisions` undefined →
        // [] → dropped. #1786 class.
        it.failing(
            '[4] wrapper key {result:D} → SHOULD recover the inner decisions',
            async () => {
                llmRun.mockResolvedValue({
                    result: { decisions: [decision()] },
                } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );
        it.failing(
            '[5] double wrapper {result:{result:D}} → SHOULD recover',
            async () => {
                llmRun.mockResolvedValue({
                    result: { result: { decisions: [decision()] } },
                } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );
        it.failing(
            '[6] opaque single-key wrap {content:D} → SHOULD recover',
            async () => {
                llmRun.mockResolvedValue({
                    content: { decisions: [decision()] },
                } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );

        // Rows 7/8/9/20 — string returns (stringified JSON, markdown-fenced,
        // prose-wrapped, thinking leak). A string has no `.decisions` → [] →
        // dropped. Recovering these is normally LLM.run's job, but the boundary
        // as written does not guard, so a leaked string silently drops payload.
        it.failing.each([
            ['[7] stringified JSON', JSON.stringify({ decisions: [decision()] })],
            [
                '[8] markdown-fenced',
                '```json\n' + JSON.stringify({ decisions: [decision()] }) + '\n```',
            ],
            [
                '[9] prose-wrapped',
                'Here is the result: ' +
                    JSON.stringify({ decisions: [decision()] }),
            ],
            [
                '[20] thinking-leak prose',
                'Let me think... the decision is convention.',
            ],
        ])('%s → SHOULD recover, not drop', async (_label, raw) => {
            llmRun.mockResolvedValue(raw as any);
            const res = await extract(agg({ filesModified: ['src/a.ts'] }));
            expect(res.length).toBeGreaterThan(0);
        });

        // Row 10 — right data, wrong top-level key.
        it.failing(
            '[10] wrong key {items:[...]} → SHOULD recover the renamed payload',
            async () => {
                llmRun.mockResolvedValue({ items: [decision()] } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );

        // Row 11 — case mismatch on the wrapper key (`Decisions`).
        it.failing(
            '[11] case-mismatched key {Decisions:[...]} → SHOULD recover',
            async () => {
                llmRun.mockResolvedValue({ Decisions: [decision()] } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(1);
            },
        );

        // Row 12 — a decision item missing its required `decision` text. The
        // boundary maps it through with decision:undefined instead of dropping
        // an invalid item (classify-session.use-case.ts:363). #1786 class.
        it.failing(
            '[12] partial item (no `decision`) → SHOULD be dropped, not shipped blank',
            async () => {
                llmRun.mockResolvedValue({
                    decisions: [{ type: 'convention' }],
                } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res).toHaveLength(0);
            },
        );

        // Row 13 — extra unknown keys must be tolerated, not crash.
        it('[13] extra unknown keys → tolerated, ignored in the mapping', async () => {
            llmRun.mockResolvedValue({
                decisions: [decision({ surprise: 'x' })],
                meta: 1,
            } as any);
            const res = await extract(agg({ filesModified: ['src/a.ts'] }));
            expect(res).toHaveLength(1);
            expect(res[0]).not.toHaveProperty('surprise');
        });

        // Rows 14/15 — empty object / empty array → typed-empty [] (legit: the
        // model found nothing; execute() then tries heuristics).
        it('[14] empty object {} → [] (no throw)', async () => {
            llmRun.mockResolvedValue({} as any);
            await expect(extract(agg())).resolves.toEqual([]);
        });
        it('[15] {decisions:[]} → []', async () => {
            llmRun.mockResolvedValue({ decisions: [] });
            await expect(extract(agg())).resolves.toEqual([]);
        });

        // Rows 16/17/18 — degenerate scalars → typed-empty [] via `?? []`.
        it.each([
            ['[16] empty string', ''],
            ['[16] whitespace-only', '   '],
            ['[17] null', null],
            ['[17] undefined', undefined],
            ['[18] primitive true', true],
            ['[18] primitive 0', 0],
            ['[18] primitive "ok"', 'ok'],
        ])('%s → [] (fail-safe empty, no throw)', async (_label, raw) => {
            llmRun.mockResolvedValue(raw as any);
            await expect(extract(agg())).resolves.toEqual([]);
        });

        // Row 19 — provider envelope leak. Payload is nested under
        // choices[].message.content, so `.decisions` is undefined → dropped.
        it.failing(
            '[19] provider envelope {choices:[{message:{content}}]} → SHOULD recover',
            async () => {
                llmRun.mockResolvedValue({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    decisions: [decision()],
                                }),
                            },
                        },
                    ],
                } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res.length).toBeGreaterThan(0);
            },
        );
    });

    // ── B. Semantic-but-wrong ────────────────────────────────────────────────
    describe('B. semantic-but-wrong values', () => {
        // Row 24 — enum out of the allowed set. The boundary casts `type` and
        // `origin` without re-validation, so an invalid enum ships
        // (classify-session.use-case.ts:367-368). #1786 class.
        it.failing(
            '[24] type out of allowed set → SHOULD be rejected, not shipped',
            async () => {
                llmRun.mockResolvedValue({
                    decisions: [decision({ type: 'URGENT' })],
                } as any);
                const res = await extract(agg({ filesModified: ['src/a.ts'] }));
                expect(res.find((d: any) => d.type === 'URGENT')).toBeUndefined();
            },
        );

        // Row 25 — dangling/invented scope reference is dropped and falls back
        // to the files the session actually touched (recovered here).
        it('[25] invented scope path → dropped, falls back to modified files', async () => {
            llmRun.mockResolvedValue({
                decisions: [decision({ scope: ['made/up.ts'] })],
            });
            const res = await extract(agg({ filesModified: ['src/a.ts'] }));
            expect(res[0].scope).toEqual(['src/a.ts']);
        });

        // Row 27 — unicode / emoji / escaped newlines inside a string field are
        // preserved through the mapping and trim.
        it('[27] unicode & emoji in `decision` are preserved', async () => {
            const text = 'décidé 🚀 use\nkebab-case';
            llmRun.mockResolvedValue({
                decisions: [decision({ decision: text })],
            });
            const res = await extract(agg({ filesModified: ['src/a.ts'] }));
            expect(res[0].decision).toBe(text);
        });

        // Row 23-ish — confidence encoded as a number out of range is clamped;
        // a non-number confidence becomes undefined (autoPromote then false).
        it('[23/24] out-of-range confidence is clamped to [0,1]', async () => {
            llmRun.mockResolvedValue({
                decisions: [decision({ confidence: 5 })],
            });
            const res = await extract(agg({ filesModified: ['src/a.ts'] }));
            expect(res[0].confidence).toBe(1);
        });
    });

    // ── D. Input variants (happy LLM.run; assert deterministic assembly) ──────
    describe('D. input variants → assembly invariant', () => {
        const payloadOf = async (aggregated: any) => {
            llmRun.mockResolvedValue({ decisions: [] });
            await extract(aggregated);
            return JSON.parse(llmRun.mock.calls[0][0].user);
        };

        // Row 35 — empty input never throws; the payload has empty collections.
        it('[35] empty session → no throw, empty turns', async () => {
            const p = await payloadOf(agg());
            expect(p.turns).toEqual([]);
        });

        // Row 36 — single item.
        it('[36] single turn → one turn in the payload', async () => {
            const p = await payloadOf(
                agg({ turns: [{ prompt: 'a', response: 'b', toolCalls: [], filesModified: [] }] }),
            );
            expect(p.turns).toHaveLength(1);
        });

        // Rows 37/41 — large input crossing the caps: turns→20, files→30,
        // per-turn toolCalls/filesModified→5. Off-by-one boundary asserted at 20.
        it('[37/41] large input is capped: turns≤20, files≤30, per-turn lists≤5', async () => {
            const bigTurns = Array.from({ length: 25 }, (_, i) => ({
                prompt: `p${i}`,
                response: `r${i}`,
                toolCalls: Array.from({ length: 8 }, (_, j) => `tool${j}`),
                filesModified: Array.from({ length: 8 }, (_, j) => `f${j}.ts`),
            }));
            const p = await payloadOf(
                agg({
                    turns: bigTurns,
                    filesModified: Array.from({ length: 40 }, (_, i) => `x${i}.ts`),
                }),
            );
            expect(p.turns).toHaveLength(20); // off-by-one boundary: 25→20
            expect(p.filesModified).toHaveLength(30);
            expect(p.turns[0].toolCalls).toHaveLength(5);
            expect(p.turns[0].filesModified).toHaveLength(5);
        });

        it('[41] exactly 20 turns are all kept (boundary)', async () => {
            const p = await payloadOf(
                agg({
                    turns: Array.from({ length: 20 }, (_, i) => ({
                        prompt: `p${i}`,
                        response: '',
                        toolCalls: [],
                        filesModified: [],
                    })),
                }),
            );
            expect(p.turns).toHaveLength(20);
        });

        // Row 38 — duplicate scope entries collapse (Set) in the output.
        it('[38] duplicate items → scope is de-duplicated', async () => {
            llmRun.mockResolvedValue({
                decisions: [decision({ scope: ['src/a.ts', 'src/a.ts'] })],
            });
            const res = await extract(
                agg({ filesModified: ['src/a.ts', 'src/a.ts'] }),
            );
            expect(res[0].scope).toEqual(['src/a.ts']);
        });

        // Row 39 — a turn with null/undefined fields coerces to '' / [] (no throw).
        it('[39] turn with null/undefined fields → coerced, no throw', async () => {
            const p = await payloadOf(
                agg({
                    turns: [
                        {
                            prompt: undefined,
                            response: undefined,
                            toolCalls: [],
                            filesModified: [],
                        },
                    ],
                }),
            );
            expect(p.turns[0]).toMatchObject({ prompt: '', response: '' });
        });

        // Row 40 — special chars / whitespace survive JSON encoding of `user`.
        it('[40] special chars & whitespace survive into the user payload', async () => {
            const weird = '  💥\t"quote"\n<script>  ';
            const p = await payloadOf(
                agg({ turns: [{ prompt: weird, response: '', toolCalls: [], filesModified: [] }] }),
            );
            expect(p.turns[0].prompt).toBe(weird);
        });

        // Row 42 — metamorphic: permuting the turns permutes the payload in the
        // same order (assembly is order-preserving, it does not reorder).
        it('[42] order permutation → payload preserves the given order', async () => {
            const mk = (order: string[]) =>
                agg({
                    turns: order.map((prompt) => ({
                        prompt,
                        response: '',
                        toolCalls: [],
                        filesModified: [],
                    })),
                });
            llmRun.mockResolvedValue({ decisions: [] });
            await extract(mk(['A', 'B']));
            await extract(mk(['B', 'A']));
            const first = JSON.parse(llmRun.mock.calls[0][0].user);
            const second = JSON.parse(llmRun.mock.calls[1][0].user);
            expect(first.turns.map((t: any) => t.prompt)).toEqual(['A', 'B']);
            expect(second.turns.map((t: any) => t.prompt)).toEqual(['B', 'A']);
        });
    });

    // ── Return-shape invariant ───────────────────────────────────────────────
    it('always returns a CliSessionClassifiedDecision[] across shapes', async () => {
        for (const raw of [null, {}, { decisions: [] }, 'x', 0]) {
            llmRun.mockResolvedValue(raw as any);
            const res = await extract(agg());
            expect(Array.isArray(res)).toBe(true);
        }
    });
});

/**
 * The fail-safe layer (matrix C) — driven through `execute()` because that is
 * where the try/catch, the empty→heuristic fallback, and the terminal
 * repository write live. A fake repository records the terminal call so we can
 * assert the boundary degrades to heuristics and never throws past itself.
 */
describe('ClassifySessionUseCase.execute — fail-safe (C)', () => {
    const sessionEnd = {
        uuid: 'u1',
        type: 'session_end',
        sessionId: 's1',
        organizationId: 'org-1',
        payload: {},
    };
    // Two events that aggregate into useful content WITH a prompt, so the
    // heuristic fallback can produce decisions.
    const events = [
        { type: 'turn_start', payload: { turnId: 't1', prompt: 'we chose to use kebab-case convention' } },
        { type: 'turn_end', payload: { turnId: 't1', response: 'done', filesModified: ['src/a.ts'] } },
    ];

    const makeRepo = () => ({
        findByUuid: jest.fn().mockResolvedValue(sessionEnd),
        findBySessionId: jest.fn().mockResolvedValue(events),
        markClassificationProcessing: jest.fn().mockResolvedValue(undefined),
        markClassificationCompleted: jest.fn().mockResolvedValue(undefined),
        markClassificationFailed: jest.fn().mockResolvedValue(undefined),
        markClassificationSkipped: jest.fn().mockResolvedValue(undefined),
    });

    afterEach(() => llmRun.mockReset());

    // Row 30 — LLM.run throws (network/timeout): execute catches, falls back to
    // heuristics, marks completed with 'heuristic-fallback', never re-throws.
    it('[30] LLM.run throws → heuristic fallback, no throw past execute', async () => {
        const repo = makeRepo();
        const uc = new ClassifySessionUseCase(repo as any, {} as any);
        llmRun.mockRejectedValue(new Error('network down'));

        await expect(uc.execute('u1')).resolves.toBeUndefined();

        expect(repo.markClassificationFailed).not.toHaveBeenCalled();
        expect(repo.markClassificationCompleted).toHaveBeenCalledTimes(1);
        const [, decisions, source] =
            repo.markClassificationCompleted.mock.calls[0];
        expect(source).toBe('heuristic-fallback');
        expect(Array.isArray(decisions)).toBe(true);
    });

    // Rows 28/29 — truncated / malformed JSON are repaired-or-thrown INSIDE
    // LLM.run; at this boundary they surface as a throw, taking the same
    // fail-safe path as row 30.
    it('[28/29] truncated/malformed surfaces as a throw → heuristic fallback', async () => {
        const repo = makeRepo();
        const uc = new ClassifySessionUseCase(repo as any, {} as any);
        llmRun.mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));

        await expect(uc.execute('u1')).resolves.toBeUndefined();
        expect(repo.markClassificationCompleted).toHaveBeenCalledTimes(1);
        expect(repo.markClassificationCompleted.mock.calls[0][2]).toBe(
            'heuristic-fallback',
        );
    });

    // Row 31 — {error} object (not a throw): decisions is [] → heuristics run
    // and, with a prompt present, complete as 'heuristic' (safe degrade).
    it('[31] {error} object return → empty decisions → heuristic completion', async () => {
        const repo = makeRepo();
        const uc = new ClassifySessionUseCase(repo as any, {} as any);
        llmRun.mockResolvedValue({ error: 'model_error' } as any);

        await uc.execute('u1');
        expect(repo.markClassificationCompleted).toHaveBeenCalledTimes(1);
        expect(repo.markClassificationCompleted.mock.calls[0][2]).toBe(
            'heuristic',
        );
    });

    // Rows 32/33 — empty success ('') / refusal prose → no decisions → the same
    // heuristic degrade path, never a throw.
    it.each([
        ['[32] empty success', ''],
        ['[33] refusal prose', 'I cannot help with that.'],
    ])('%s → heuristic completion, no throw', async (_label, raw) => {
        const repo = makeRepo();
        const uc = new ClassifySessionUseCase(repo as any, {} as any);
        llmRun.mockResolvedValue(raw as any);

        await expect(uc.execute('u1')).resolves.toBeUndefined();
        expect(repo.markClassificationCompleted).toHaveBeenCalledTimes(1);
        expect(repo.markClassificationCompleted.mock.calls[0][2]).toBe(
            'heuristic',
        );
    });

    // Return-shape / origin invariant: a clean LLM result completes with the
    // 'llm' source (the boundary trusts a valid parsed envelope).
    it('[1] valid LLM decisions → completes with source "llm"', async () => {
        const repo = makeRepo();
        const uc = new ClassifySessionUseCase(repo as any, {} as any);
        llmRun.mockResolvedValue({
            decisions: [
                {
                    type: 'convention',
                    decision: 'use kebab-case',
                    confidence: 0.9,
                    scope: ['src/a.ts'],
                },
            ],
        });

        await uc.execute('u1');
        expect(repo.markClassificationCompleted).toHaveBeenCalledTimes(1);
        expect(repo.markClassificationCompleted.mock.calls[0][2]).toBe('llm');
    });
});
