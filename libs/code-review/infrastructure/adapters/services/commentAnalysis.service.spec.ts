/**
 * commentAnalysis.service.spec.ts — structured-call delegation.
 *
 * Proves the comment-analysis consumer resolves the routed `codeReview` slot via
 * the permission service and then runs it through the SHARED structured executor
 * (`runStructuredReviewCall`) — instead of a hand-rolled resolveTaskModel +
 * wrapByokModel + tracedGenerateText copy. The executor owns the limiter,
 * reasoning, span, wire-schema conversion and retry (tested in its own spec), so
 * here we only assert the delegation boundary:
 *  - the org + `codeReview` task drive the slot resolution;
 *  - the CIPHERTEXT slot + trial default + telemetry metadata reach the executor;
 *  - decryption never happens here (the ciphertext slot is passed through as-is).
 *
 * Seam strategy: mock `resolveTaskSlot` (the permission-service method) and
 * `runStructuredReviewCall` (the shared executor) — no real model / network.
 */

const runStructuredReviewCall = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (...args: any[]) =>
        (runStructuredReviewCall as any)(...args),
}));

import { CommentAnalysisService } from './commentAnalysis.service';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('CommentAnalysisService — structured-call delegation', () => {
    let service: CommentAnalysisService;
    let observabilityService: { runAiSdkLLMInSpan: jest.Mock };
    let permissionValidationService: { resolveTaskSlot: jest.Mock };
    const resolveTaskSlot = jest.fn();

    const org = { organizationId: 'org-1', teamId: 'team-1' } as any;
    // A CIPHERTEXT-bearing slot (never plaintext) — the executor decrypts, not us.
    const CIPHERTEXT_SLOT = {
        provider: 'openai',
        apiKey: 'enc-oa',
        model: 'gpt-4o',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        resolveTaskSlot.mockResolvedValue(CIPHERTEXT_SLOT);
        // Irrelevance filter returns no ids → filterComments short-circuits to []
        // after exactly one structured call.
        runStructuredReviewCall.mockResolvedValue({ ids: [] });

        observabilityService = { runAiSdkLLMInSpan: jest.fn() };
        permissionValidationService = { resolveTaskSlot };

        service = new CommentAnalysisService(
            observabilityService as any,
            permissionValidationService as any,
        );
    });

    it('resolves the codeReview slot and delegates to the shared structured executor', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        expect(resolveTaskSlot).toHaveBeenCalledWith(org, 'codeReview');
        // observabilityService is NOT threaded by the service anymore — LLM.run
        // owns the span internally (app singleton), so it never appears here.
        expect(runStructuredReviewCall).toHaveBeenCalledWith(
            expect.objectContaining({
                byokConfig: CIPHERTEXT_SLOT,
                defaultModelOverride: undefined,
                spanName: expect.stringContaining(
                    `${CommentAnalysisService.name}::`,
                ),
                telemetryMetadata: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            }),
        );
    });

    it('hands the executor the CIPHERTEXT slot — decryption stays inside the executor', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        const arg = runStructuredReviewCall.mock.calls[0][0];
        expect(arg.byokConfig).toEqual(CIPHERTEXT_SLOT);
        expect(arg.byokConfig.apiKey).toBe('enc-oa'); // ciphertext, not decrypted here
    });
});

/**
 * Pure comment-processing logic — the deterministic core that decides WHICH
 * comments the rule-learner ever sees. None of it touches the LLM, yet a
 * regression here silently changes the training set: a bot slips through, a
 * duplicate is learned twice, an excluded reviewer's comment is kept, a
 * short/Kody-authored comment pollutes the corpus, or the wrong language is
 * tagged. The delegation block above never exercises any of it. We build the
 * service with inert deps and drive the pure methods directly.
 */
describe('CommentAnalysisService — pure comment processing', () => {
    const build = () =>
        new CommentAnalysisService(
            { runAiSdkLLMInSpan: jest.fn() } as any,
            { resolveTaskSlot: jest.fn() } as any,
        );
    const svc = () => build() as any;
    const long = (seed: string) => seed.repeat(120); // comfortably > 100 chars

    describe('processComments', () => {
        const pr = (over: any = {}) => ({
            pr: { id: 'pr-1' },
            generalComments: [],
            reviewComments: [],
            ...over,
        });

        it('merges general+review, dedups by id, and drops comments of length <= 100', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [{ id: 1, body: long('a') }],
                    reviewComments: [
                        { id: 1, body: 'duplicate id — dropped' },
                        { id: 2, body: 'x'.repeat(100) }, // exactly 100 → dropped (boundary)
                    ],
                }),
            ]);

            expect(out).toHaveLength(1);
            expect(out[0].id).toBe(1);
        });

        it('keeps a comment of length 101 (strictly greater than 100)', () => {
            const out = svc().processComments([
                pr({ generalComments: [{ id: 1, body: 'x'.repeat(101) }] }),
            ]);
            expect(out).toHaveLength(1);
        });

        it('builds an Azure composite id from threadId+id', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [
                        { id: 5, threadId: 't9', body: long('a') },
                    ],
                }),
            ]);
            expect(out[0].id).toBe('t9-5');
        });

        it('expands GitLab discussion notes (comments with no body key)', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [
                        {
                            notes: [
                                {
                                    id: 'n1',
                                    body: long('a'),
                                    author: { id: 'u1' },
                                },
                            ],
                        },
                    ],
                }),
            ]);
            expect(out).toHaveLength(1);
            expect(out[0].id).toBe('n1');
        });

        it('drops bot-authored comments, keeps human ones', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [
                        { id: 1, user: { type: 'Bot' }, body: long('a') },
                        { id: 2, user: { type: 'User' }, body: long('b') },
                    ],
                }),
            ]);
            expect(out.map((c: any) => c.id)).toEqual([2]);
        });

        it('drops excluded reviewers but keeps comments whose author is unidentifiable', () => {
            const out = svc().processComments(
                [
                    pr({
                        generalComments: [
                            { id: 1, user: { id: 99 }, body: long('a') },
                            { id: 2, body: long('b') }, // no author → kept
                        ],
                    }),
                ],
                new Set(['99']),
            );
            expect(out.map((c: any) => c.id)).toEqual([2]);
        });

        it('tags comments with the dominant supported language from the PR files', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [{ id: 1, body: long('a') }],
                    files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
                }),
            ]);
            expect(out[0].language).toBe('typescript');
        });

        it('returns [] when nothing survives processing', () => {
            const out = svc().processComments([
                pr({ generalComments: [{ id: 1, body: 'too short' }] }),
            ]);
            expect(out).toEqual([]);
        });
    });

    describe('getCommentAuthorId', () => {
        const id = (c: any) => svc().getCommentAuthorId(c);

        it('prefers user.id and stringifies it', () => {
            expect(id({ user: { id: 42 } })).toBe('42');
        });
        it('falls back to author.id (GitLab shape)', () => {
            expect(id({ author: { id: 'g1' } })).toBe('g1');
        });
        it('stringifies a zero id rather than treating it as absent', () => {
            expect(id({ user: { id: 0 } })).toBe('0');
        });
        it.each([[''], [null], [undefined]])(
            'returns undefined for an empty/nullish id (%p)',
            (raw) => {
                expect(id({ user: { id: raw } })).toBeUndefined();
            },
        );
    });

    describe('fileExtensionFrequencyAnalysis', () => {
        it('returns per-extension frequencies as fractions of the total', () => {
            const out = svc().fileExtensionFrequencyAnalysis([
                { filename: 'a.ts' },
                { filename: 'b.ts' },
                { filename: 'c.js' },
            ]);
            expect(out.ts).toBeCloseTo(2 / 3);
            expect(out.js).toBeCloseTo(1 / 3);
        });

        it('returns an empty map (no divide-by-zero) for no files', () => {
            expect(svc().fileExtensionFrequencyAnalysis([])).toEqual({});
        });
    });

    describe('mapRuleUuidToRule', () => {
        it('keeps only rules whose uuid is in the list', () => {
            const out = svc().mapRuleUuidToRule({
                rules: [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }],
                uuids: ['b', 'c'],
            });
            expect(out.map((r: any) => r.uuid)).toEqual(['b', 'c']);
        });
    });

    describe('standardizeRules', () => {
        it('blanks a non-library uuid and fills the canonical defaults', () => {
            const out = svc().standardizeRules({
                rules: [{ uuid: 'not-in-library', title: 'T', rule: 'R' }],
            });
            expect(out).toEqual([
                {
                    uuid: '',
                    title: 'T',
                    rule: 'R',
                    severity: KodyRuleSeverity.LOW,
                    examples: [],
                    repositoryId: 'global',
                    status: KodyRulesStatus.PENDING,
                },
            ]);
        });
    });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LLM.run I/O CONTRACT MATRIX (#1786) — the deterministic parse/return boundary.
 *
 * SCOPE. Every LLM.run site in this file goes through `runStructuredLLM` →
 * `LLM.run({ schema, ... })`, whose STRUCTURED path is the shared executor
 * `runStructuredReviewCall` (mocked here — the same seam the delegation block
 * above uses). That executor owns the wire-schema conversion, JSON parse/repair,
 * schema validation and the strict-json_schema-vs-json_object provider gate
 * (source lines 97-107: "the central strict-wire-schema conversion"). So the
 * RAW-envelope zoo (stringified / markdown-fenced / prose / truncated / malformed
 * / duplicate-JSON-keys / refusal-prose / empty-success transport) is the
 * executor's contract, verified in ITS spec — NOT recoverable here, because this
 * boundary never sees a string; it receives a parsed `z.infer<S>`. Those rows are
 * in rowsNA.
 *
 * What THIS boundary owns and we assert here:
 *   - field extraction off the parsed envelope (`res?.ids/.suggestions/.rules/
 *     .uuids`) and the empty/missing → typed-empty `[]` contract;
 *   - it never crash-leaks on an off-schema OBJECT and always returns its
 *     declared array type (or fails explicitly by throwing — never a silent
 *     wrong-default that is NOT an array);
 *   - field mapping (addBodyToCategorizedComment / standardize) preserving values
 *     verbatim (enum + unicode pass-through — validation delegated to the schema);
 *   - the error contract: filter/generate PROPAGATE (documented), categorize
 *     SWALLOWS (documented) — the one owned silent-degradation is pinned failing;
 *   - all D input variants (empty/single/large/dup/null/special/off-by-one/perm);
 *   - E: the service is model-agnostic — it always passes `schema` to the
 *     executor regardless of the slot's provider (never downgrades the gate).
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('CommentAnalysisService — LLM.run I/O contract (#1786 matrix)', () => {
    let service: CommentAnalysisService;
    const resolveTaskSlot = jest.fn();
    const org = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const OPENAI_SLOT = { provider: 'openai', apiKey: 'enc', model: 'gpt-4o' };
    const KIMI_SLOT = {
        provider: 'moonshotai',
        apiKey: 'enc',
        model: 'kimi-k2',
    };

    // A comment long enough to survive processComments' >100-char gate, though
    // categorize/filter/generate don't gate on length — the LLM decides.
    const c = (id: any, body = 'x'.repeat(120)) => ({ id, body }) as any;

    beforeEach(() => {
        jest.clearAllMocks();
        resolveTaskSlot.mockResolvedValue(OPENAI_SLOT);
        service = new CommentAnalysisService(
            { runAiSdkLLMInSpan: jest.fn() } as any,
            { resolveTaskSlot } as any,
        );
    });

    // Queue sequential executor returns for a multi-call flow.
    const seq = (...values: any[]) => {
        values.forEach((v) =>
            v instanceof Error
                ? runStructuredReviewCall.mockRejectedValueOnce(v)
                : runStructuredReviewCall.mockResolvedValueOnce(v),
        );
    };
    // categorizeComments = irrelevance filter (call 1) then categorizer (call 2).
    // Keep id '1' through the filter, then drive the categorizer with `shape`.
    const categorizeWith = (shape: any) => {
        seq({ ids: ['1'] }, shape);
        return service.categorizeComments({
            comments: [c(1)],
            organizationAndTeamData: org,
        });
    };

    // ── A. Output-shape zoo ────────────────────────────────────────────────

    describe('A — output-shape zoo (parsed-object variants the executor could leak)', () => {
        it('A1: exact D → recovers the real payload and maps body back by id', async () => {
            const out = await categorizeWith({
                suggestions: [
                    { id: '1', category: 'security', severity: 'high' },
                ],
            });
            expect(out).toEqual([
                {
                    id: 1,
                    body: 'x'.repeat(120),
                    category: 'security',
                    severity: 'high',
                },
            ]);
        });

        it('A1 (generate stage): exact {rules} → standardized rules out', async () => {
            // filter keeps id, generate returns one rule, no existing rules so
            // the dedupe stage is skipped, quality keeps the rule.
            seq(
                { ids: ['1'] },
                {
                    rules: [
                        { uuid: 'r1', title: 'T', rule: 'R', severity: 'High' },
                    ],
                },
                { uuids: ['r1'] },
            );
            const out = await service.generateKodyRules({
                comments: [c(1)],
                existingRules: [],
                organizationAndTeamData: org,
            });
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                title: 'T',
                rule: 'R',
                repositoryId: 'global',
                status: KodyRulesStatus.PENDING,
            });
        });

        it('A12: partial object (payload key present, items missing fields) → tolerated, no crash', async () => {
            const out = await categorizeWith({ suggestions: [{ id: '1' }] });
            expect(out).toHaveLength(1);
            expect(out[0].category).toBeUndefined();
            expect(out[0].severity).toBeUndefined();
        });

        it('A13: extra unknown keys alongside the right ones → tolerated', async () => {
            const out = await categorizeWith({
                suggestions: [
                    { id: '1', category: 'security', severity: 'high' },
                ],
                _usage: { tokens: 42 },
                model: 'gpt-4o',
            });
            expect(out).toHaveLength(1);
        });

        it('A14: empty object {} → typed-empty [] (documented safe-default), never throws', async () => {
            await expect(categorizeWith({})).resolves.toEqual([]);
        });

        it('A15: empty array in the payload key → typed-empty []', async () => {
            await expect(
                categorizeWith({ suggestions: [] }),
            ).resolves.toEqual([]);
        });

        it('A16: empty-string / whitespace executor return → typed-empty []', async () => {
            await expect(categorizeWith('')).resolves.toEqual([]);
            await expect(categorizeWith('   ')).resolves.toEqual([]);
        });

        it('A17: null / undefined executor return → typed-empty []', async () => {
            await expect(categorizeWith(null)).resolves.toEqual([]);
            await expect(categorizeWith(undefined)).resolves.toEqual([]);
        });

        it('A18: primitive where object expected → typed-empty []', async () => {
            await expect(categorizeWith(true)).resolves.toEqual([]);
            await expect(categorizeWith(0)).resolves.toEqual([]);
            await expect(categorizeWith('ok')).resolves.toEqual([]);
        });

        // A2/A4/A5/A6/A10/A11/A19: the executor hands back a parsed OBJECT whose
        // expected payload key is absent. Raw-shape recovery is the executor's
        // job (delegated); this boundary must NOT crash-leak and must return its
        // declared array type. Driven through filterComments (single call, reads
        // `res?.ids`) so the assertion is unambiguous.
        it.each([
            ['A2 bare array', [{ id: '1' }]],
            ['A4 wrapper key {data:D}', { data: { ids: ['1'] } }],
            ['A5 double wrapper', { result: { result: { ids: ['1'] } } }],
            ['A6 numeric/opaque single-key wrap', { '0': { ids: ['1'] } }],
            ['A6 content wrap', { content: { ids: ['1'] } }],
            ['A10 right data, wrong keys', { identifiers: ['1'] }],
            ['A11 case/convention mismatch', { Ids: ['1'] }],
            [
                'A19 provider envelope leak',
                { choices: [{ message: { content: '{"ids":["1"]}' } }] },
            ],
        ])(
            '%s → typed-empty [] (recovery delegated to executor), never crash-leaks',
            async (_label, shape) => {
                runStructuredReviewCall.mockResolvedValueOnce(shape);
                const out = await (service as any).filterComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                });
                expect(Array.isArray(out)).toBe(true);
                expect(out).toEqual([]);
            },
        );

        it('A3: single object where an ARRAY is expected → fails EXPLICITLY (throws), never a silent wrong-typed default', async () => {
            // `ids` present but a non-array object: the empty-guard does not fire
            // (`.length` is undefined, not 0), so the subsequent `.includes`
            // throws — an explicit signal, not a silent [] with a wrong answer.
            runStructuredReviewCall.mockResolvedValueOnce({
                ids: { '0': '1' },
            });
            await expect(
                (service as any).filterComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                }),
            ).rejects.toBeDefined();
        });
    });

    // ── B. Semantic-but-wrong ──────────────────────────────────────────────

    describe('B — semantic-but-wrong values', () => {
        it('B24: enum/severity out of the allowed set → passed through verbatim (enum validation delegated to the executor schema, not re-checked here)', async () => {
            const out = await categorizeWith({
                suggestions: [
                    { id: '1', category: 'NOT_A_CATEGORY', severity: 'URGENT' },
                ],
            });
            // Documents that this boundary does NOT re-validate the enum: the
            // json_schema/zod gate in runStructuredReviewCall is the single
            // validator. If it ever regresses, a bad enum reaches the mapper —
            // caught by the executor's own contract spec, not silenced here.
            expect(out).toEqual([
                {
                    id: 1,
                    body: 'x'.repeat(120),
                    category: 'NOT_A_CATEGORY',
                    severity: 'URGENT',
                },
            ]);
        });

        it('B25: dangling reference — a returned uuid absent from the candidates is dropped, not crashed', () => {
            const out = (service as any).mapRuleUuidToRule({
                rules: [{ uuid: 'a' }, { uuid: 'b' }],
                uuids: ['b', 'ghost-uuid-not-present'],
            });
            expect(out.map((r: any) => r.uuid)).toEqual(['b']);
        });

        it('B25 (filter stage): ids referencing comments not in the input are simply not matched', async () => {
            runStructuredReviewCall.mockResolvedValueOnce({
                ids: ['1', '999-does-not-exist'],
            });
            const out = await (service as any).filterComments({
                comments: [c(1)],
                organizationAndTeamData: org,
            });
            expect(out).toHaveLength(1);
            expect(out[0].id).toBe(1);
        });

        it('B27: unicode / emoji / escaped newlines in mapped fields survive verbatim', async () => {
            const body = 'café ☕ \n\t 日本語 💥 line2';
            seq(
                { ids: ['1'] },
                {
                    suggestions: [
                        { id: '1', category: 'código 🔒', severity: 'high' },
                    ],
                },
            );
            const out = await service.categorizeComments({
                comments: [c(1, body)],
                organizationAndTeamData: org,
            });
            expect(out[0].body).toBe(body);
            expect(out[0].category).toBe('código 🔒');
        });
    });

    // ── C. Unparseable / transport (fail-safe layer) ───────────────────────

    describe('C — transport / fail-safe', () => {
        it('C30: LLM.run throws — filterComments PROPAGATES (documented: a provider failure must mark the run errored, not "no result")', async () => {
            runStructuredReviewCall.mockRejectedValue(new Error('network'));
            await expect(
                (service as any).filterComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                }),
            ).rejects.toThrow('network');
        });

        it('C30: LLM.run throws — generateKodyRules PROPAGATES (no swallowing catch by design)', async () => {
            runStructuredReviewCall.mockRejectedValue(new Error('timeout'));
            await expect(
                service.generateKodyRules({
                    comments: [c(1)],
                    existingRules: [],
                    organizationAndTeamData: org,
                }),
            ).rejects.toThrow('timeout');
        });

        // categorizeComments' try/catch swallows the throw and — because the
        // catch has no `return` — yields `undefined`, violating its declared
        // `Promise<CategorizedComment[]>`. The CORRECT fail-safe is a typed empty
        // `[]` (an array callers can `.map`/`.length` safely). Pinned failing so
        // it flips red when the boundary is fixed to return [].
        // Source: commentAnalysis.service.ts:178-186 (catch with no return).
        it.failing(
            'C30: LLM.run throws — categorizeComments must fail-safe to a typed [] (currently returns undefined)',
            async () => {
                runStructuredReviewCall.mockRejectedValue(new Error('boom'));
                const out = await service.categorizeComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                });
                expect(out).toEqual([]);
            },
        );

        it('C30: even while swallowing, categorizeComments never throws past the boundary', async () => {
            runStructuredReviewCall.mockRejectedValue(new Error('boom'));
            await expect(
                service.categorizeComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                }),
            ).resolves.not.toThrow();
        });

        it('C31: error OBJECT returned instead of a throw → read as a missing payload → typed-empty [] (no {error} leaks into output)', async () => {
            runStructuredReviewCall.mockResolvedValueOnce({
                error: 'quota_exceeded',
            });
            const out = await (service as any).filterComments({
                comments: [c(1)],
                organizationAndTeamData: org,
            });
            expect(out).toEqual([]);
        });
    });

    // ── D. Input variants ──────────────────────────────────────────────────

    describe('D — input variants', () => {
        it('D35: empty input → [] and still delegates the call (no pre-short-circuit)', async () => {
            runStructuredReviewCall.mockResolvedValue({ ids: [] });
            const out = await service.categorizeComments({
                comments: [],
                organizationAndTeamData: org,
            });
            expect(out).toEqual([]);
            expect(runStructuredReviewCall).toHaveBeenCalledTimes(1);
        });

        it('D35: empty input → generateKodyRules returns []', async () => {
            runStructuredReviewCall.mockResolvedValue({ ids: [] });
            const out = await service.generateKodyRules({
                comments: [],
                existingRules: [],
                organizationAndTeamData: org,
            });
            expect(out).toEqual([]);
        });

        it('D36: single item → happy path returns exactly one categorized comment', async () => {
            const out = await categorizeWith({
                suggestions: [
                    { id: '1', category: 'refactoring', severity: 'low' },
                ],
            });
            expect(out).toHaveLength(1);
        });

        it('D37: large input crossing the 100-comment cap → processComments slices to 100 (the only chunk boundary; no per-call batching)', () => {
            const many = Array.from({ length: 150 }, (_, i) => ({
                id: i + 1,
                body: 'x'.repeat(120),
            }));
            const out = (service as any).processComments([
                {
                    pr: { id: 'pr' },
                    generalComments: many,
                    reviewComments: [],
                },
            ]);
            expect(out).toHaveLength(100);
        });

        it('D38: duplicate ids in the filter result set → each matching input comment is kept (filter is membership, not dedup)', async () => {
            runStructuredReviewCall.mockResolvedValueOnce({ ids: ['7'] });
            const out = await (service as any).filterComments({
                comments: [c(7), c(7, 'y'.repeat(120))],
                organizationAndTeamData: org,
            });
            expect(out).toHaveLength(2);
        });

        it('D39: null/undefined required field — no matching old comment → addBody fails safe to [] (no crash past boundary)', async () => {
            // filter keeps '1', categorizer returns an id with no old-comment
            // match; addBodyToCategorizedComment's own try/catch returns [].
            seq(
                { ids: ['1'] },
                {
                    suggestions: [
                        { id: '999', category: 'security', severity: 'high' },
                    ],
                },
            );
            const out = await service.categorizeComments({
                comments: [c(1)],
                organizationAndTeamData: org,
            });
            expect(out).toEqual([]);
        });

        it('D40: special-chars / whitespace-only body flows through processComments and is preserved', () => {
            const weird = '  \t\n «ñ» 🚀 '.padEnd(120, '·');
            const out = (service as any).processComments([
                {
                    pr: { id: 'pr' },
                    generalComments: [{ id: 1, body: weird }],
                    reviewComments: [],
                },
            ]);
            expect(out[0].body).toBe(weird);
        });

        it('D41: off-by-one at the 100-cap — exactly 100 kept as-is, 101 sliced to 100', () => {
            const build = (n: number) =>
                Array.from({ length: n }, (_, i) => ({
                    id: i + 1,
                    body: 'x'.repeat(120),
                }));
            const exactly100 = (service as any).processComments([
                { pr: { id: 'p' }, generalComments: build(100), reviewComments: [] },
            ]);
            const oneOver = (service as any).processComments([
                { pr: { id: 'p' }, generalComments: build(101), reviewComments: [] },
            ]);
            expect(exactly100).toHaveLength(100);
            expect(oneOver).toHaveLength(100);
        });

        it('D42: order permutation of the same input → the same SET of kept comments (metamorphic)', () => {
            const items = [
                { id: 1, body: 'a'.repeat(120) },
                { id: 2, body: 'b'.repeat(120) },
                { id: 3, body: 'c'.repeat(120) },
            ];
            const run = (arr: any[]) =>
                ((service as any).processComments([
                    { pr: { id: 'p' }, generalComments: arr, reviewComments: [] },
                ]) as any[])
                    .map((x) => x.id)
                    .sort();
            expect(run([...items])).toEqual(run([...items].reverse()));
        });

        it('D42 (mapRuleUuidToRule): permuting the uuid list yields the same kept-rule set (output follows rule order)', () => {
            const rules = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
            const a = (service as any).mapRuleUuidToRule({
                rules,
                uuids: ['a', 'c'],
            });
            const b = (service as any).mapRuleUuidToRule({
                rules,
                uuids: ['c', 'a'],
            });
            expect(a).toEqual(b);
        });
    });

    // ── E. Provider / model policy (delegated gate) ────────────────────────

    describe('E — N-model policy: the boundary is model-agnostic (always requests structured output)', () => {
        it.each([
            ['strict json_schema provider (openai)', OPENAI_SLOT],
            ['json_object fallback provider (moonshotai/kimi)', KIMI_SLOT],
        ])(
            'passes a `schema` to the executor for %s — never downgrades the strict/json_object gate itself',
            async (_label, slot) => {
                resolveTaskSlot.mockResolvedValue(slot);
                runStructuredReviewCall.mockResolvedValue({ ids: [] });
                await (service as any).filterComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                });
                const arg = runStructuredReviewCall.mock.calls[0][0];
                expect(arg.schema).toBeDefined();
                expect(arg.byokConfig).toBe(slot);
            },
        );
    });

    // ── Cross-cutting: the boundary always returns its DECLARED type ───────

    describe('always returns the declared array type across the off-schema layer', () => {
        it.each([[null], [undefined], [true], [42], ['str'], [{}], [{ nope: 1 }], [[]]])(
            'filterComments(%p executor return) → an array, never a crash',
            async (shape) => {
                runStructuredReviewCall.mockResolvedValueOnce(shape as any);
                const out = await (service as any).filterComments({
                    comments: [c(1)],
                    organizationAndTeamData: org,
                });
                expect(Array.isArray(out)).toBe(true);
            },
        );
    });
});
