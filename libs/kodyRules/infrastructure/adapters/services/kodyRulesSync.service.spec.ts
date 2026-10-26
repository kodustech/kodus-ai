import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

// Mock the LLM boundary: the WHOLE point of the post-trial gate is that it
// must NOT reach the (managed-model) LLM conversion when the trial has ended
// and the org has no BYOK. Asserting on this mock is how we prove the gate
// fired (never called) vs. let the request through (called).
jest.mock('@libs/llm/structured-review-call', () => ({
    // The structured (schema) boundary. `LLM.run({ schema })` dispatches here.
    runStructuredReviewCall: jest.fn(),
    // The plain-text boundary. `LLM.run` WITHOUT a schema dispatches here — this
    // is the raw-JSON fallback the parse sites fall through to when the
    // structured call throws. Mocking it lets us drive the extractJsonArray zoo.
    runTextReviewCall: jest.fn(),
}));
import {
    runStructuredReviewCall,
    runTextReviewCall,
} from '@libs/llm/structured-review-call';
import {
    KodyRulesStatus,
    KodyRulesOrigin,
    KodyRulesScope,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { kodyRulesIDEGeneratorSchema } from '@libs/common/utils/prompts/kodyRules';
import { KodyRulesSyncService } from './kodyRulesSync.service';

const mockRun = runStructuredReviewCall as jest.Mock;
const mockText = runTextReviewCall as jest.Mock;

/**
 * Guards the post-trial-without-BYOK gate (commit 936f9ffc0, previously
 * untested — flagged by issue #1452 matrix-gaps §3/§4.9). Our managed default
 * models are trial-only; once the trial ends, an org WITHOUT its own key must
 * NOT silently fall back to our managed models for LLM rule-file conversion —
 * it must skip (return []). BYOK always wins regardless of subscription state.
 * The gate is a silent skip, so without this test a regression (dropping the
 * status check, or the managed model rotting) is invisible.
 */
describe('KodyRulesSyncService.convertFileToKodyRules — post-trial BYOK gate', () => {
    const ORG = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    // A config carrying one non-managed credential → the org "has BYOK"
    // (hasNonManagedCredential true). `null` → no BYOK.
    const v2WithByok = {
        version: 2,
        credentials: [{ id: 'c1', provider: 'openai', apiKey: 'enc' }],
        models: [{ id: 'm1', credentialId: 'c1', model: 'x' }],
        routing: { defaultModelId: 'm1' },
    };

    const makeService = (opts: {
        byok: boolean;
        status: SubscriptionStatus | undefined;
    }) => {
        const permissionValidationService = {
            validateBasicLicense: jest.fn().mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest
                .fn()
                .mockResolvedValue(opts.byok ? v2WithByok : null),
            getSubscriptionStatus: jest.fn().mockResolvedValue(opts.status),
        };

        // 11 positional constructor deps; only permissionValidationService (8th)
        // is exercised on the gated path — the rest are never touched before the
        // gate returns.
        const deps: any[] = new Array(11).fill({});
        deps[7] = permissionValidationService;
        const service = new (KodyRulesSyncService as any)(...deps);
        return { service, permissionValidationService };
    };

    const params = {
        // NOT a `.kody/rules/**` template → does not import verbatim, falls
        // through to the LLM conversion path where the gate lives.
        filePath: 'docs/guidelines.md',
        repositoryId: 'repo-1',
        content: '# Some guidance\nAvoid using any.',
        organizationAndTeamData: ORG,
    };
    // defaultStatus set → skips resolveSyncDefaultStatus (an unmocked dep call).
    const options = { defaultStatus: 'active' as any };

    beforeEach(() => mockRun.mockReset());

    const POST_TRIAL: SubscriptionStatus[] = [
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.PAYMENT_FAILED,
        SubscriptionStatus.CANCELED,
        SubscriptionStatus.EXPIRED,
    ];

    it.each(POST_TRIAL)(
        'no BYOK + %s → skips LLM conversion (returns [], never calls the model)',
        async (status) => {
            const { service } = makeService({ byok: false, status });

            const result = await (service as any).convertFileToKodyRules(
                params,
                options,
            );

            expect(result).toEqual([]);
            expect(mockRun).not.toHaveBeenCalled();
        },
    );

    it('trial (not ended) + no BYOK → managed model IS allowed (gate does not fire)', async () => {
        // Managed models are legitimate DURING the trial; the LLM path must run.
        mockRun.mockResolvedValue({ rules: [] });
        const { service } = makeService({
            byok: false,
            status: SubscriptionStatus.TRIAL,
        });

        await (service as any)
            .convertFileToKodyRules(params, options)
            .catch(() => undefined); // ignore any post-LLM processing error

        expect(mockRun).toHaveBeenCalled();
    });

    it('BYOK present + post-trial (EXPIRED) → BYOK wins, LLM path runs (gate does not fire)', async () => {
        // BYOK always wins: the customer's own key funds the call regardless of
        // subscription state, so the gate must let it through.
        mockRun.mockResolvedValue({ rules: [] });
        const { service } = makeService({
            byok: true,
            status: SubscriptionStatus.EXPIRED,
        });

        await (service as any)
            .convertFileToKodyRules(params, options)
            .catch(() => undefined);

        expect(mockRun).toHaveBeenCalled();
    });
});

/**
 * ── LLM.run I/O CONTRACT MATRIX for the KodyRulesSync parse boundary ──
 *
 * The boundary calls `LLM.run` at one parse site, with a structured (schema)
 * primary + a raw-JSON fallback:
 *   - convertFileToKodyRules          (schema kodyRulesIDEGeneratorSchema)
 * Declared payload D = `{ rules: [...] }`; declared return = an Array of
 * Partial<CreateKodyRuleDto> (or `null` only when the license check denies).
 *
 * Model policy (E — the structured-output json_schema-vs-json_object gate) is
 * DELEGATED to runStructuredReviewCall, a SEPARATE boundary. At THIS boundary
 * the two branches surface as:
 *   - strict json_schema honored  → the structured call returns clean D; this
 *     boundary TRUSTS it (rows exercised via `mockRun`).
 *   - json_object fallback (zoo)  → when the structured call throws, this
 *     boundary drops to the raw-text path whose parser is `extractJsonArray`;
 *     the full A/B/C zoo is in-scope there (rows exercised via `mockText` and
 *     by calling `extractJsonArray` directly).
 *
 * SCOPE = deterministic layer only: request assembly, envelope parsing,
 * fallback, guaranteed return shape. NOT the model's decision quality.
 */
describe('KodyRulesSyncService.convertFileToKodyRules — LLM I/O contract (structured / strict branch)', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };

    const v2WithByok = {
        version: 2,
        credentials: [{ id: 'c1', provider: 'openai', apiKey: 'enc' }],
        models: [{ id: 'm1', credentialId: 'c1', model: 'x' }],
        routing: { defaultModelId: 'm1' },
    };

    // BYOK present + EXPIRED → the post-trial gate never fires, so every test
    // here reaches the LLM.run parse sites. (The gate itself is covered above.)
    const makeService = (over: Record<string, any> = {}) => {
        const permissionValidationService = {
            validateBasicLicense: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest.fn().mockResolvedValue(v2WithByok),
            getSubscriptionStatus: jest
                .fn()
                .mockResolvedValue(SubscriptionStatus.EXPIRED),
            ...over,
        };
        const deps: any[] = new Array(11).fill({});
        deps[7] = permissionValidationService;
        return new (KodyRulesSyncService as any)(...deps);
    };

    // filePath is NOT a `.kody/rules/**` template and there is NO fileRef, so
    // the method skips verbatim-import AND @file inlining and lands squarely on
    // the LLM path — the seam under test.
    const baseParams = {
        filePath: 'docs/guidelines.md',
        repositoryId: 'repo-1',
        content: '# Guidance\nAvoid using any.',
        organizationAndTeamData: ORG,
    };
    // defaultStatus set → skips resolveSyncDefaultStatus (an unmocked dep call).
    const opts = { defaultStatus: KodyRulesStatus.ACTIVE };

    const fullRule = {
        title: 'No any',
        rule: 'Avoid using any in TypeScript',
        path: '**/*.ts',
        pathSource: 'content-inferred',
        sourcePath: 'docs/guidelines.md',
        severity: 'high',
        scope: 'file',
        examples: [{ snippet: 'const x: any = 1', isCorrect: false }],
    };

    beforeEach(() => {
        mockRun.mockReset();
        mockText.mockReset();
    });

    const convert = (service: any, params: any = baseParams) =>
        service.convertFileToKodyRules(params, opts);

    // ── Request assembly (exact args / schema / system / user / byokConfig) ──
    it('assembles the structured request: schema, system, user(file+content), byokConfig slot, org, runName (Rows 36/40)', async () => {
        mockRun.mockResolvedValue({ rules: [fullRule] });
        const service = makeService();

        await convert(service);

        expect(mockRun).toHaveBeenCalledTimes(1);
        const callArg = mockRun.mock.calls[0][0];
        expect(callArg.schema).toBe(kodyRulesIDEGeneratorSchema);
        expect(typeof callArg.system).toBe('string');
        expect(callArg.system).toContain('Convert repository rule files');
        expect(callArg.user).toContain('docs/guidelines.md');
        expect(callArg.user).toContain('Avoid using any.');
        // BYOK slot threaded through (Row: byokConfig threading).
        expect(callArg.byokConfig).toBeDefined();
        expect(callArg.organizationId).toBe('org-1');
        expect(callArg.runName).toContain('kodyRulesFileToRules');
        // Strict branch: clean D is trusted; the raw fallback is NOT engaged.
        expect(mockText).not.toHaveBeenCalled();
    });

    // Row 1 — exact D, correct keys/types.
    it('Row 1: exact D {rules:[rule]} → one normalized DTO with the guaranteed shape', async () => {
        mockRun.mockResolvedValue({ rules: [fullRule] });
        const service = makeService();

        const result = await convert(service);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(
            expect.objectContaining({
                title: 'No any',
                rule: 'Avoid using any in TypeScript',
                severity: 'high',
                scope: KodyRulesScope.FILE,
                sourcePath: 'docs/guidelines.md',
                repositoryId: 'repo-1',
                origin: KodyRulesOrigin.REPO_FILE_SYNC,
                status: KodyRulesStatus.ACTIVE,
                path: expect.any(String),
                examples: [{ snippet: 'const x: any = 1', isCorrect: false }],
            }),
        );
    });

    // Row 12 — partial object: only some keys present → defaults filled, no crash.
    it('Row 12: partial rule (title+rule only) → severity/scope/examples defaulted', async () => {
        mockRun.mockResolvedValue({
            rules: [{ title: 'T', rule: 'R' }],
        });
        const service = makeService();

        const result = await convert(service);

        expect(result[0]).toEqual(
            expect.objectContaining({
                title: 'T',
                rule: 'R',
                severity: 'medium', // KodyRuleSeverity.MEDIUM default
                scope: KodyRulesScope.FILE,
                examples: [],
                status: KodyRulesStatus.ACTIVE,
                repositoryId: 'repo-1',
            }),
        );
    });

    // Row 13 — extra unknown keys tolerated (spread through), no crash.
    it('Row 13: extra unknown keys are tolerated (spread, not rejected)', async () => {
        mockRun.mockResolvedValue({
            rules: [{ ...fullRule, somethingUnknown: 42, another: 'x' }],
        });
        const service = makeService();

        const result = await convert(service);

        expect(result[0]).toEqual(
            expect.objectContaining({ somethingUnknown: 42, another: 'x' }),
        );
    });

    // Row 20 — reasoning/thinking leak as an extra sibling key → rules still read.
    it('Row 20: reasoning/thinking leak alongside rules → payload recovered, leak ignored', async () => {
        mockRun.mockResolvedValue({
            rules: [fullRule],
            reasoning: 'let me think... <thinking> ...',
        });
        const service = makeService();

        const result = await convert(service);

        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('reasoning');
    });

    // Rows 14/15/17 — empty object / empty array / null → typed-empty [] (a
    // signalled safe default, not a crash). Declared return type preserved.
    it.each([
        ['Row 14 empty object', {}],
        ['Row 15 empty rules array', { rules: [] }],
        ['Row 17 null', null],
        ['Row 17 undefined', undefined],
        ['Row 18 primitive true', true],
        ['Row 18 primitive 0', 0],
        ['Row 16 empty string', ''],
        ['Row 31 error object', { error: 'boom' }],
        ['Row 19 provider envelope leak', {
            choices: [{ message: { content: '{}' } }],
        }],
    ])(
        '%s from structured call → typed-empty [] (Array preserved, no throw)',
        async (_label, shape) => {
            mockRun.mockResolvedValue(shape as any);
            const service = makeService();

            const result = await convert(service);

            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(0);
            // No raw fallback for a NON-throwing off-shape (only throws fall
            // through); the boundary already returned a safe typed-empty.
            expect(mockText).not.toHaveBeenCalled();
        },
    );

    // Row 3 — single object where an array is expected: `result.rules.map`
    // throws internally → caught → drops to the raw fallback (no crash past the
    // boundary). Fail-safe recovery.
    it('Row 3: rules-as-object (not array) → does not throw past boundary; engages raw fallback', async () => {
        mockRun.mockResolvedValue({ rules: { title: 'T', rule: 'R' } });
        mockText.mockResolvedValue(JSON.stringify([fullRule]));
        const service = makeService();

        const result = await convert(service);

        expect(mockText).toHaveBeenCalledTimes(1);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
    });

    // ── Row 2 (#1786 class): a bare array of valid rules from the structured
    // call is SILENTLY DROPPED — `result?.rules` is undefined so the guard at
    // kodyRulesSync.service.ts:2290 returns []. Under strict json_schema this
    // "cannot happen", but the non-degradation rule says an off-shape carrying
    // real data must be recovered or signalled, never silently dropped. Pinned
    // it.failing: GREEN today (returns []), RED when the boundary learns to
    // recover a bare array. Source: kodyRulesSync.service.ts:2290.
    it.failing(
        'Row 2 (#1786): bare array of rules from structured call must be recovered, not dropped',
        async () => {
            mockRun.mockResolvedValue([fullRule] as any);
            const service = makeService();

            const result = await convert(service);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(
                expect.objectContaining({ title: 'No any' }),
            );
        },
    );

    // ── C — transport / fail-safe ──
    // Row 30 — structured throws, raw succeeds → recovered via fallback.
    it('Row 30: structured LLM.run throws → raw fallback recovers the payload', async () => {
        mockRun.mockRejectedValue(new Error('network'));
        mockText.mockResolvedValue(JSON.stringify([fullRule]));
        const service = makeService();

        const result = await convert(service);

        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(mockText).toHaveBeenCalledTimes(1);
        // Raw fallback is text (no schema) — proves the no-schema branch is used.
        expect(mockText.mock.calls[0][0].schema).toBeUndefined();
        expect(mockText.mock.calls[0][0].system).toContain(
            'Return ONLY the JSON array',
        );
        expect(result).toHaveLength(1);
    });

    // Row 30/32/33 — structured throws AND raw throws/empties → [] (never
    // throws past the boundary; the guaranteed return type holds).
    it('Row 30: both structured and raw throw → [] (never throws past boundary)', async () => {
        mockRun.mockRejectedValue(new Error('a'));
        mockText.mockRejectedValue(new Error('b'));
        const service = makeService();

        await expect(convert(service)).resolves.toEqual([]);
    });

    it('Row 32/33: structured throws, raw returns empty/refusal prose → [] safe default', async () => {
        mockRun.mockRejectedValue(new Error('len'));
        mockText.mockResolvedValue('I cannot help with that request.');
        const service = makeService();

        await expect(convert(service)).resolves.toEqual([]);
    });

    // ── License gate: the ONLY path that returns non-array (null). Documented. ──
    it('license denied → returns null (documented non-array return; LLM never called)', async () => {
        const service = makeService({
            validateBasicLicense: jest
                .fn()
                .mockResolvedValue({ allowed: false }),
        });

        const result = await convert(service);

        expect(result).toBeNull();
        expect(mockRun).not.toHaveBeenCalled();
    });

    // ── D — input variants ──
    // Row 35 — empty content still parses to [] gracefully.
    it('Row 35: empty content + model returns no rules → []', async () => {
        mockRun.mockResolvedValue({ rules: [] });
        const service = makeService();

        const result = await convert(service, { ...baseParams, content: '' });

        expect(result).toEqual([]);
    });

    // Row 27/40 — unicode / emoji / special chars in content survive into the
    // request, and unicode inside rule string fields survives the parse.
    it('Row 27/40: unicode+emoji content threaded verbatim; unicode rule fields preserved', async () => {
        const content = 'Regra: não usar `any` 🚫 — 日本語 \t\n whitespace';
        mockRun.mockResolvedValue({
            rules: [{ ...fullRule, title: 'Título 🚀 日本語' }],
        });
        const service = makeService();

        const result = await convert(service, { ...baseParams, content });

        expect(mockRun.mock.calls[0][0].user).toContain('🚫');
        expect(mockRun.mock.calls[0][0].user).toContain('日本語');
        expect(result[0].title).toBe('Título 🚀 日本語');
    });
});

/**
 * json_object fallback branch — the raw-text path and its parser
 * `extractJsonArray`. This is where the full A/B/C zoo is in-scope, because the
 * raw path has NO schema guard: whatever the model emits as text must be
 * recovered (parse/repair) or safely dropped to []. `extractJsonArray` is a
 * pure private method; we exercise it directly AND through the wrapping raw path.
 */
describe('KodyRulesSyncService.extractJsonArray — raw-JSON zoo (json_object branch)', () => {
    const service = new (KodyRulesSyncService as any)(
        ...new Array(11).fill({}),
    );
    const extract = (t: any) => (service as any).extractJsonArray(t);
    const rule = { title: 'T', rule: 'R', severity: 'high' };

    // Row 2 — bare array recovered verbatim.
    it('Row 2: bare JSON array → recovered', () => {
        expect(extract(JSON.stringify([rule]))).toEqual([rule]);
    });

    // Row 4 — wrapper object {rules:[...]} → inner array sliced out and recovered.
    it('Row 4: wrapper {rules:[...]} → inner array recovered', () => {
        expect(extract(JSON.stringify({ rules: [rule] }))).toEqual([rule]);
    });

    // Row 5 — double wrapper → the single inner array is still recovered.
    it('Row 5: double wrapper {result:{rules:[...]}} → inner array recovered', () => {
        expect(extract(JSON.stringify({ result: { rules: [rule] } }))).toEqual([
            rule,
        ]);
    });

    // Row 6 — numeric/opaque single-key wrap → inner array recovered.
    it('Row 6: {"0":[...]} / {content:[...]} wrap → inner array recovered', () => {
        expect(extract(JSON.stringify({ '0': [rule] }))).toEqual([rule]);
        expect(extract(JSON.stringify({ content: [rule] }))).toEqual([rule]);
    });

    // Row 11 — wrapper key case/convention is irrelevant (parser slices by
    // brackets, not by key), so a renamed/miscased wrapper still recovers.
    it('Row 11: miscased/renamed wrapper key → array still recovered', () => {
        expect(extract('{"Rules":[' + JSON.stringify(rule) + ']}')).toEqual([
            rule,
        ]);
    });

    // Row 7 — stringified JSON (whole payload as a quoted string).
    it('Row 7: stringified JSON array → unwrapped and recovered', () => {
        expect(extract(JSON.stringify(JSON.stringify([rule])))).toEqual([rule]);
    });

    // Row 8 — markdown-fenced JSON.
    it('Row 8: ```json fenced array → fence stripped and recovered', () => {
        expect(extract('```json\n' + JSON.stringify([rule]) + '\n```')).toEqual(
            [rule],
        );
    });

    // Row 9 / Row 20 — prose-wrapped (thinking leak in content) → array salvaged.
    it('Row 9/20: prose-wrapped array → salvaged from surrounding text', () => {
        expect(
            extract('Here is the result: ' + JSON.stringify([rule]) + ' Enjoy!'),
        ).toEqual([rule]);
    });

    // Row 26 — duplicate keys in an object → JSON.parse last-wins (deterministic).
    it('Row 26: duplicate keys → deterministic last-wins after parse', () => {
        const out = extract('[{"title":"A","title":"B","rule":"R"}]');
        expect(out).toEqual([{ title: 'B', rule: 'R' }]);
    });

    // Rows 14/16/18/28/29 — unrecoverable → null (the raw path maps null → []).
    it.each([
        ['Row 14 empty object', '{}'],
        ['Row 16 empty string', ''],
        ['Row 16 whitespace only', '   \n\t '],
        ['Row 18 primitive true', 'true'],
        ['Row 18 primitive number', '0'],
        ['Row 28 truncated JSON', '[{"title":"A","rule":'],
        ['Row 29 malformed (trailing comma)', '[{"title":"A",},]'],
        ['Row 29 malformed (single quotes)', "[{'title':'A'}]"],
        ['Row 17 null input', null],
        ['Row 17 undefined input', undefined],
        ['Row 18 non-string input', 123],
    ])('%s → null (signalled unparseable)', (_label, input) => {
        expect(extract(input)).toBeNull();
    });

    // Row 15 — empty array is a valid recover (not null).
    it('Row 15: empty array [] → recovered as []', () => {
        expect(extract('[]')).toEqual([]);
    });
});

/**
 * The raw-text fallback path OF convertFileToKodyRules (the wrapper around
 * extractJsonArray + its normalizeRule). Driven by making the structured call
 * throw so the boundary drops to `mockText`. This is where the semantic-but-
 * wrong (B) rows bite, because normalizeRule here has no schema guard.
 */
describe('KodyRulesSyncService.convertFileToKodyRules — raw fallback normalize (json_object branch)', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const v2WithByok = {
        version: 2,
        credentials: [{ id: 'c1', provider: 'openai', apiKey: 'enc' }],
        models: [{ id: 'm1', credentialId: 'c1', model: 'x' }],
        routing: { defaultModelId: 'm1' },
    };
    const makeService = () => {
        const permissionValidationService = {
            validateBasicLicense: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest.fn().mockResolvedValue(v2WithByok),
            getSubscriptionStatus: jest
                .fn()
                .mockResolvedValue(SubscriptionStatus.EXPIRED),
        };
        const deps: any[] = new Array(11).fill({});
        deps[7] = permissionValidationService;
        return new (KodyRulesSyncService as any)(...deps);
    };
    const params = {
        filePath: 'docs/guidelines.md',
        repositoryId: 'repo-1',
        content: '# g',
        organizationAndTeamData: ORG,
    };
    const opts = { defaultStatus: KodyRulesStatus.ACTIVE };
    const convert = (s: any) => s.convertFileToKodyRules(params, opts);

    beforeEach(() => {
        mockRun.mockReset();
        mockText.mockReset();
        mockRun.mockRejectedValue(new Error('force raw path'));
    });

    // Row 8 — fenced JSON from the raw model → recovered + normalized.
    it('Row 8: fenced JSON via raw path → recovered and normalized to DTO', async () => {
        mockText.mockResolvedValue(
            '```json\n' +
                JSON.stringify([
                    { title: 'T', rule: 'R', severity: 'high' },
                ]) +
                '\n```',
        );
        const service = makeService();

        const result = await convert(service);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(
            expect.objectContaining({
                title: 'T',
                severity: 'high',
                origin: KodyRulesOrigin.REPO_FILE_SYNC,
                status: KodyRulesStatus.ACTIVE,
                repositoryId: 'repo-1',
            }),
        );
    });

    // Row 29/28 — unparseable raw text → [] (fail-safe, never throws).
    it('Row 28/29: unparseable raw text → [] (fail-safe)', async () => {
        mockText.mockResolvedValue('total garbage, no json here');
        const service = makeService();

        await expect(convert(service)).resolves.toEqual([]);
    });

    // ── Row 24 (#1786 class): an out-of-set severity is only lowercased, never
    // validated against low|medium|high|critical, so "URGENT" ships as "urgent"
    // — a wrong enum with no signal. Source: kodyRulesSync.service.ts:2379.
    // Pinned it.failing: GREEN today, RED when severity is normalized to the
    // allowed set.
    it.failing(
        'Row 24 (#1786): out-of-set severity on raw path must normalize to a valid enum',
        async () => {
            mockText.mockResolvedValue(
                JSON.stringify([
                    { title: 'T', rule: 'R', severity: 'URGENT' },
                ]),
            );
            const service = makeService();

            const result = await convert(service);

            expect(['low', 'medium', 'high', 'critical']).toContain(
                result[0].severity,
            );
        },
    );

    // ── Rows 21/22/23 (#1786 class): example.isCorrect arrives boolean-ish
    // (string "false"/"yes", number 1). normalizeRule does `isCorrect || false`
    // — a truthy STRING "false" survives as the string "false" (semantically
    // WRONG: should be boolean false). Source: kodyRulesSync.service.ts:2389.
    // Pinned it.failing: correct behaviour is a real boolean.
    it.failing(
        'Row 21: string "false" for isCorrect must coerce to boolean false',
        async () => {
            mockText.mockResolvedValue(
                JSON.stringify([
                    {
                        title: 'T',
                        rule: 'R',
                        examples: [{ snippet: 's', isCorrect: 'false' }],
                    },
                ]),
            );
            const service = makeService();

            const result = await convert(service);

            expect(result[0].examples[0].isCorrect).toBe(false);
        },
    );

    it.failing(
        'Row 22: "yes" for isCorrect must coerce to boolean true',
        async () => {
            mockText.mockResolvedValue(
                JSON.stringify([
                    {
                        title: 'T',
                        rule: 'R',
                        examples: [{ snippet: 's', isCorrect: 'yes' }],
                    },
                ]),
            );
            const service = makeService();

            const result = await convert(service);

            expect(result[0].examples[0].isCorrect).toBe(true);
        },
    );

    it.failing(
        'Row 23: number 1 for isCorrect must coerce to boolean true',
        async () => {
            mockText.mockResolvedValue(
                JSON.stringify([
                    {
                        title: 'T',
                        rule: 'R',
                        examples: [{ snippet: 's', isCorrect: 1 }],
                    },
                ]),
            );
            const service = makeService();

            const result = await convert(service);

            expect(result[0].examples[0].isCorrect).toBe(true);
        },
    );

    // Row 10 — inner-key rename (right data, wrong keys): a rule missing `title`
    // passes through as a partial (the caller's `r.title && r.rule` filter drops
    // it later). At THIS boundary it neither crashes nor fabricates a title.
    it('Row 10: inner renamed keys → partial DTO (title undefined), no crash', async () => {
        mockText.mockResolvedValue(
            JSON.stringify([{ name: 'T', body: 'R' }]),
        );
        const service = makeService();

        const result = await convert(service);

        expect(Array.isArray(result)).toBe(true);
        expect(result[0].title).toBeUndefined();
        expect(result[0]).toEqual(
            expect.objectContaining({ name: 'T', body: 'R' }),
        );
    });
});

/**
 * getRuleId — the persistence-result envelope parser (a small output-shape zoo
 * of its own: the create/update mutation returns different shapes depending on
 * centralized-PR mode vs. direct entity). It must extract the id or signal
 * undefined, never throw.
 */
describe('KodyRulesSyncService.getRuleId — result envelope parser (A rows)', () => {
    const service = new (KodyRulesSyncService as any)(
        ...new Array(11).fill({}),
    );
    const getRuleId = (r: any) => (service as any).getRuleId(r);

    it('Row 1/4: {uuid} → uuid; {id} → id; {_id} → _id (precedence uuid>id>_id)', () => {
        expect(getRuleId({ uuid: 'u1' })).toBe('u1');
        expect(getRuleId({ id: 'i1' })).toBe('i1');
        expect(getRuleId({ _id: 'x1' })).toBe('x1');
        expect(getRuleId({ uuid: 'u1', id: 'i1', _id: 'x1' })).toBe('u1');
    });

    it('Row 12/16: empty-string uuid falls through to id, then _id', () => {
        expect(getRuleId({ uuid: '', id: 'i1' })).toBe('i1');
        expect(getRuleId({ uuid: '', id: '', _id: 'x1' })).toBe('x1');
    });

    it.each([
        ['Row 17 null', null],
        ['Row 17 undefined', undefined],
        ['Row 14 empty object', {}],
        ['Row 12 no id keys', { title: 'x' }],
        ['Row 18 primitive', 'just-a-string'],
        ['Row 18 number', 42],
    ])('%s → undefined (signalled, no throw)', (_label, input) => {
        expect(getRuleId(input as any)).toBeUndefined();
    });
});

/**
 * Guards the "every record, not just the first" contract of the
 * sourcePath-scoped delete/depin passes. A sourcePath can carry several
 * records (duplicates from concurrent syncs — observed live: two identical
 * rules from one merge). `Array.find` soft-deleted ONE of them and left the
 * survivor ACTIVE for a file that no longer existed; the same `.find` served
 * the @kody-ignore path, so a marker added to an already-imported file left
 * survivors too.
 */
describe('KodyRulesSyncService — deleteRuleBySourcePath', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const PATH = '.kody/rules/x.md';

    const makeService = (rules: any[]) => {
        const kodyRulesService = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'doc-1', rules }),
            createOrUpdate: jest.fn().mockResolvedValue({}),
        };
        const deps: any[] = new Array(KodyRulesSyncService.length).fill({});
        deps[0] = kodyRulesService;
        const service = new (KodyRulesSyncService as any)(...deps);
        return { service, kodyRulesService };
    };

    const rule = (uuid: string, extra: Record<string, unknown> = {}) => ({
        uuid,
        repositoryId: 'repo-1',
        sourcePath: PATH,
        status: KodyRulesStatus.ACTIVE,
        ...extra,
    });

    const writtenDtos = (kodyRulesService: { createOrUpdate: jest.Mock }) =>
        kodyRulesService.createOrUpdate.mock.calls.map(
            ([, dto]: [unknown, any]) => dto,
        );

    it('soft-deletes EVERY live record for (repositoryId, sourcePath), not just the first', async () => {
        const { service, kodyRulesService } = makeService([
            rule('dup-1'),
            rule('dup-2', { status: KodyRulesStatus.PAUSED }),
            // Multi-rule files carry an anchor after '#': still the same file.
            rule('dup-3', { sourcePath: `${PATH}#anchor` }),
            rule('other-repo', { repositoryId: 'repo-2' }),
            rule('other-path', { sourcePath: '.kody/rules/y.md' }),
        ]);

        await service.deleteRuleBySourcePath({
            organizationAndTeamData: ORG,
            repositoryId: 'repo-1',
            sourcePath: PATH,
        });

        const written = writtenDtos(kodyRulesService);
        expect(written.map((d) => d.uuid).sort()).toEqual([
            'dup-1',
            'dup-2',
            'dup-3',
        ]);
        expect(written.every((d) => d.status === KodyRulesStatus.DELETED)).toBe(
            true,
        );
    });

    it('skips records that are already DELETED (no redundant writes)', async () => {
        const { service, kodyRulesService } = makeService([
            rule('gone', { status: KodyRulesStatus.DELETED }),
            rule('live'),
        ]);

        await service.deleteRuleBySourcePath({
            organizationAndTeamData: ORG,
            repositoryId: 'repo-1',
            sourcePath: PATH,
        });

        expect(writtenDtos(kodyRulesService).map((d) => d.uuid)).toEqual([
            'live',
        ]);
    });

    it('keeps going when one record fails to write — the rest still end DELETED', async () => {
        const { service, kodyRulesService } = makeService([
            rule('boom'),
            rule('ok'),
        ]);
        kodyRulesService.createOrUpdate
            .mockRejectedValueOnce(new Error('write failed'))
            .mockResolvedValue({});

        await service.deleteRuleBySourcePath({
            organizationAndTeamData: ORG,
            repositoryId: 'repo-1',
            sourcePath: PATH,
        });

        expect(writtenDtos(kodyRulesService).map((d) => d.uuid)).toEqual([
            'boom',
            'ok',
        ]);
    });

    it('is a no-op when nothing matches', async () => {
        const { service, kodyRulesService } = makeService([
            rule('other-path', { sourcePath: '.kody/rules/y.md' }),
        ]);

        await service.deleteRuleBySourcePath({
            organizationAndTeamData: ORG,
            repositoryId: 'repo-1',
            sourcePath: PATH,
        });

        expect(kodyRulesService.createOrUpdate).not.toHaveBeenCalled();
    });

});

describe('KodyRulesSyncService — stale deletion snapshots', () => {
    const org = { organizationId: 'org-1', teamId: 'team-1' };
    const deletion = { execute: jest.fn() };
    const rules = { findByOrganizationId: jest.fn() };
    const deps: any[] = new Array(11).fill({});
    deps[0] = rules;
    deps[6] = deletion;
    const service = new (KodyRulesSyncService as any)(...deps);

    beforeEach(() => jest.clearAllMocks());

    it.each(['ide', 'global'])(
        'continues the %s purge after a concurrent deletion without counting the missing rule',
        async (kind) => {
            const { NotFoundException } = await import('@nestjs/common');
            rules.findByOrganizationId.mockResolvedValue({
                rules: ['first', 'second'].map((uuid) => ({
                    uuid,
                    status: KodyRulesStatus.ACTIVE,
                    repositoryId: kind === 'ide' ? 'repo-1' : 'global',
                    sourcePath: '.cursor/rules/test.mdc',
                    origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
                    sourceRepositoryId: 'repo-1',
                })),
            });
            deletion.execute
                .mockRejectedValueOnce(new NotFoundException('Rule not found'))
                .mockResolvedValueOnce(true);
            const result =
                kind === 'ide'
                    ? await service.transitionIdeSyncRulesStatus({
                          organizationAndTeamData: org,
                          repositoryIds: ['repo-1'],
                          targetStatus: KodyRulesStatus.DELETED,
                      })
                    : await service.purgeGlobalRulesForSourceRepository({
                          organizationAndTeamData: org,
                          sourceRepositoryId: 'repo-1',
                      });
            expect(deletion.execute).toHaveBeenCalledTimes(2);
            expect(result).toBe(1);
        },
    );

    it('does not swallow a team outside the organization as a missing rule', async () => {
        const { NotFoundException } = await import('@nestjs/common');
        const error = new NotFoundException('Team not found');
        deletion.execute.mockRejectedValueOnce(error);
        await expect(
            service.deleteSyncedRuleIfPresent(org, 'rule-1'),
        ).rejects.toBe(error);
    });

    it('does not swallow a storage failure as a missing rule', async () => {
        const error = new Error('storage unavailable');
        deletion.execute.mockRejectedValueOnce(error);
        await expect(
            service.deleteSyncedRuleIfPresent(org, 'rule-1'),
        ).rejects.toBe(error);
    });
});

describe('KodyRulesSyncService — bulk IDE rule transitions across repositories', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };

    const ideRule = (repositoryId: string) => ({
        uuid: `rule-${repositoryId}`,
        repositoryId,
        sourcePath: '.cursorrules',
        status: KodyRulesStatus.ACTIVE,
    });

    const makeService = () => {
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue({
                rules: [ideRule('a'), ideRule('b'), ideRule('c')],
            }),
        };
        const createOrUpdateKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue({}),
        };
        const deps: any[] = new Array(KodyRulesSyncService.length).fill({});
        deps[0] = kodyRulesService;
        deps[5] = createOrUpdateKodyRulesUseCase;
        const service = new (KodyRulesSyncService as any)(...deps);
        return { service, kodyRulesService, createOrUpdateKodyRulesUseCase };
    };

    it('loads the organization rules once and pauses only the listed repositories', async () => {
        const { service, kodyRulesService, createOrUpdateKodyRulesUseCase } =
            makeService();

        await service.pauseAllIdeSyncRulesForRepositories({
            organizationAndTeamData: ORG,
            repositoryIds: ['a', 'b'],
        });

        expect(kodyRulesService.findByOrganizationId).toHaveBeenCalledTimes(1);
        const paused = createOrUpdateKodyRulesUseCase.execute.mock.calls.map(
            ([dto]: [any]) => [dto.uuid, dto.status],
        );
        expect(paused).toEqual([
            ['rule-a', KodyRulesStatus.PAUSED],
            ['rule-b', KodyRulesStatus.PAUSED],
        ]);
    });

    it('a bulk resume of imported rules by an admin also resumes the ones Kody paused', async () => {
        const { service, kodyRulesService, createOrUpdateKodyRulesUseCase } =
            makeService();
        kodyRulesService.findByOrganizationId.mockResolvedValue({
            rules: [
                { ...ideRule('a'), uuid: 'by-hand', status: KodyRulesStatus.PAUSED },
                {
                    ...ideRule('a'),
                    uuid: 'by-kody',
                    status: KodyRulesStatus.PAUSED,
                    autoPause: { state: 'ignored', pausedAt: new Date() },
                },
            ],
        });

        await service.resumeAllIdeSyncRulesForRepository({
            organizationAndTeamData: ORG,
            repositoryId: 'a',
        });

        const resumed = createOrUpdateKodyRulesUseCase.execute.mock.calls.map(
            ([dto]: [any]) => dto.uuid,
        );
        expect(resumed).toEqual(['by-hand', 'by-kody']);
    });

    it('does nothing for an empty list', async () => {
        const { service, kodyRulesService } = makeService();

        await service.pauseAllIdeSyncRulesForRepositories({
            organizationAndTeamData: ORG,
            repositoryIds: [],
        });

        expect(kodyRulesService.findByOrganizationId).not.toHaveBeenCalled();
    });
});

describe('KodyRulesSyncService — repository rule files vs coding-agent files', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const REPO = { id: 'repo-1', name: 'repo' };

    const TEMPLATE = [
        '---',
        'title: "No console"',
        'severity_min: high',
        'path: ["src/**"]',
        '---',
        '',
        '## Instructions',
        'Use the structured logger.',
    ].join('\n');

    const toContent = (text: string) => ({
        data: { content: Buffer.from(text).toString('base64'), encoding: 'base64' },
    });

    const makeService = (opts: {
        files?: Record<string, string>;
        orgRules?: any[];
        configValue?: unknown;
        knowledgeApproval?: boolean;
        allFiles?: Array<{ path: string; size?: number; sha?: string }>;
    }) => {
        const files = opts.files ?? {};
        const kodyRulesService = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ rules: opts.orgRules ?? [] }),
            createOrUpdate: jest
                .fn()
                .mockImplementation(async (_org: unknown, dto: any) => ({
                    ...dto,
                    uuid: dto.uuid ?? `new-${dto.sourcePath}`,
                })),
            updateRuleSourceFileIssue: jest.fn().mockResolvedValue(null),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: opts.configValue ?? {
                    configs: { repoInstructionsEnabled: false },
                    repositories: [{ id: REPO.id, configs: {} }],
                },
            }),
        };
        const codeManagementService = {
            getPullRequestByNumber: jest.fn().mockResolvedValue({
                head: { ref: 'feature' },
                base: { ref: 'main' },
            }),
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getRepositoryContentFile: jest
                .fn()
                .mockImplementation(async ({ file }: any) =>
                    files[file.filename] !== undefined
                        ? toContent(files[file.filename])
                        : null,
                ),
            getRepositoryAllFiles: jest
                .fn()
                .mockResolvedValue(opts.allFiles ?? []),
        };
        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const createOrUpdateKodyRulesUseCase = {
            execute: jest
                .fn()
                .mockImplementation(async (dto: any) => ({
                    ...dto,
                    uuid: dto.uuid ?? `new-${dto.sourcePath}`,
                })),
        };
        const deleteRuleUseCase = { execute: jest.fn().mockResolvedValue(true) };
        const permissionValidationService = {
            validateBasicLicense: jest.fn().mockResolvedValue({ allowed: true }),
            resolveGlobalRulesImportTier: jest.fn().mockResolvedValue('paid'),
        };
        const codeBaseConfigService = {
            getSimpleConfig: jest.fn().mockResolvedValue({
                kodyKnowledgeApproval: { enabled: !!opts.knowledgeApproval },
            }),
        };

        const deps: any[] = new Array(KodyRulesSyncService.length).fill({});
        deps[0] = kodyRulesService;
        deps[1] = parametersService;
        deps[3] = codeManagementService;
        deps[4] = updateOrCreateCodeReviewParameterUseCase;
        deps[5] = createOrUpdateKodyRulesUseCase;
        deps[6] = deleteRuleUseCase;
        deps[7] = permissionValidationService;
        deps[10] = codeBaseConfigService;
        const service = new (KodyRulesSyncService as any)(...deps);
        jest.spyOn(service, 'processContextReferences').mockResolvedValue(
            undefined,
        );

        const written = () => [
            ...createOrUpdateKodyRulesUseCase.execute.mock.calls.map(
                ([dto]: [any]) => dto,
            ),
            ...kodyRulesService.createOrUpdate.mock.calls.map(
                ([, dto]: [unknown, any]) => dto,
            ),
        ];
        const fetched = () =>
            codeManagementService.getRepositoryContentFile.mock.calls.map(
                ([arg]: [any]) => arg.file.filename,
            );

        return {
            service,
            kodyRulesService,
            codeManagementService,
            deleteRuleUseCase,
            written,
            fetched,
        };
    };

    beforeEach(() => {
        mockRun.mockReset();
        mockText.mockReset();
    });

    describe('syncFromChangedFiles', () => {
        const sync = (service: any, files: any[]) =>
            service.syncFromChangedFiles({
                organizationAndTeamData: ORG,
                repository: REPO,
                pullRequestNumber: 7,
                files,
            });

        it('imports a .kody/rules template with the coding-agent toggle off, without an LLM', async () => {
            const { service, written } = makeService({
                files: { '.kody/rules/no-console.md': TEMPLATE },
            });

            await sync(service, [
                { filename: '.kody/rules/no-console.md', status: 'added' },
            ]);

            expect(written()).toEqual([
                expect.objectContaining({
                    title: 'No console',
                    sourcePath: '.kody/rules/no-console.md',
                    repositoryId: REPO.id,
                    path: 'src/**',
                    origin: KodyRulesOrigin.REPO_FILE_SYNC,
                    status: KodyRulesStatus.ACTIVE,
                }),
            ]);
            expect(mockRun).not.toHaveBeenCalled();
            expect(mockText).not.toHaveBeenCalled();
        });

        it('lands a template PENDING when knowledge approval is on', async () => {
            const { service, written } = makeService({
                files: { '.kody/rules/no-console.md': TEMPLATE },
                knowledgeApproval: true,
            });

            await sync(service, [
                { filename: '.kody/rules/no-console.md', status: 'modified' },
            ]);

            expect(written()).toEqual([
                expect.objectContaining({ status: KodyRulesStatus.PENDING }),
            ]);
        });

        it.each([true, false])(
            'never converts coding-agent files (toggle %s), not even with @kody-sync',
            async (toggle) => {
                const { service, written, fetched } = makeService({
                    configValue: {
                        configs: { repoInstructionsEnabled: toggle },
                        repositories: [{ id: REPO.id, configs: {} }],
                    },
                    files: {
                        'CLAUDE.md': '@kody-sync\nAlways use pnpm.',
                        '.cursor/rules/style.mdc': '@kody-sync\nNo any.',
                        '.agents/rules/a.md': TEMPLATE,
                    },
                });

                await sync(service, [
                    { filename: 'CLAUDE.md', status: 'modified' },
                    { filename: '.cursor/rules/style.mdc', status: 'added' },
                    { filename: '.agents/rules/a.md', status: 'added' },
                ]);

                expect(written()).toEqual([]);
                expect(fetched()).toEqual([]);
                expect(mockRun).not.toHaveBeenCalled();
            },
        );

        it('leaves the frozen rule of a removed coding-agent file untouched', async () => {
            const { service, written, deleteRuleUseCase } = makeService({
                orgRules: [
                    {
                        uuid: 'frozen',
                        repositoryId: REPO.id,
                        sourcePath: 'CLAUDE.md',
                        status: KodyRulesStatus.ACTIVE,
                    },
                ],
            });

            await sync(service, [{ filename: 'CLAUDE.md', status: 'removed' }]);

            expect(written()).toEqual([]);
            expect(deleteRuleUseCase.execute).not.toHaveBeenCalled();
        });

        it('skips a file under a rule location that does not parse as a template, without an LLM', async () => {
            const { service, written } = makeService({
                files: {
                    'docs/rules/no-foo.md': '# no-foo\n\nDisallows foo.',
                },
            });

            await sync(service, [
                { filename: 'docs/rules/no-foo.md', status: 'added' },
            ]);

            expect(written()).toEqual([]);
            expect(mockRun).not.toHaveBeenCalled();
            expect(mockText).not.toHaveBeenCalled();
        });

        it('soft-deletes the rule of a removed template file', async () => {
            const { service, written } = makeService({
                orgRules: [
                    {
                        uuid: 'r1',
                        repositoryId: REPO.id,
                        sourcePath: '.kody/rules/no-console.md',
                        status: KodyRulesStatus.ACTIVE,
                    },
                ],
            });

            await sync(service, [
                { filename: '.kody/rules/no-console.md', status: 'removed' },
            ]);

            expect(written()).toEqual([
                expect.objectContaining({
                    uuid: 'r1',
                    status: KodyRulesStatus.DELETED,
                }),
            ]);
        });

        it('does not call the git host when no rule file changed', async () => {
            const { service, codeManagementService } = makeService({});

            await sync(service, [{ filename: 'src/a.ts', status: 'modified' }]);

            expect(
                codeManagementService.getPullRequestByNumber,
            ).not.toHaveBeenCalled();
        });
    });

    describe('syncRepositoryMain', () => {
        it('imports templates from the default branch with the toggle off and ignores agent files', async () => {
            const { service, written, codeManagementService } = makeService({
                allFiles: [{ path: '.kody/rules/no-console.md' }],
                files: { '.kody/rules/no-console.md': TEMPLATE },
            });

            await service.syncRepositoryMain({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            const patterns: string[] =
                codeManagementService.getRepositoryAllFiles.mock.calls[0][0]
                    .filters.filePatterns;
            expect(patterns).toContain('.kody/rules/**');
            expect(patterns).not.toContain('CLAUDE.md');
            expect(written()).toEqual([
                expect.objectContaining({
                    sourcePath: '.kody/rules/no-console.md',
                    repositoryId: REPO.id,
                }),
            ]);
        });

        it('refuses a requested path that is a coding-agent file', async () => {
            const { service, written, fetched } = makeService({
                files: { 'CLAUDE.md': '@kody-sync\nUse pnpm.' },
            });

            await service.syncRepositoryMain({
                organizationAndTeamData: ORG,
                repository: REPO,
                path: 'CLAUDE.md',
            });

            expect(written()).toEqual([]);
            expect(fetched()).toEqual([]);
        });
    });

    describe('syncRepositoryMainFast (onboarding)', () => {
        it('imports only templates, scoped to the repository, never manifests or agent files', async () => {
            const { service, written, codeManagementService } = makeService({
                allFiles: [{ path: '.kody/rules/no-console.md', size: 200 }],
                files: { '.kody/rules/no-console.md': TEMPLATE },
                knowledgeApproval: true,
            });

            const result = await service.syncRepositoryMainFast({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(
                codeManagementService.getRepositoryAllFiles,
            ).toHaveBeenCalledTimes(1);
            const patterns: string[] =
                codeManagementService.getRepositoryAllFiles.mock.calls[0][0]
                    .filters.filePatterns;
            expect(patterns).not.toContain('package.json');
            expect(patterns).not.toContain('CLAUDE.md');
            expect(written()).toEqual([
                expect.objectContaining({
                    title: 'No console',
                    repositoryId: REPO.id,
                    sourcePath: '.kody/rules/no-console.md',
                    origin: KodyRulesOrigin.REPO_FILE_SYNC,
                    status: KodyRulesStatus.PENDING,
                }),
            ]);
            expect(result.rules).toHaveLength(1);
            expect(mockRun).not.toHaveBeenCalled();
        });

        it('reports a non-template file as skipped instead of generating a rule', async () => {
            const { service, written } = makeService({
                allFiles: [{ path: 'rules/readme.md', size: 20 }],
                files: { 'rules/readme.md': '# Rules\nSee wiki.' },
            });

            const result = await service.syncRepositoryMainFast({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(written()).toEqual([]);
            expect(result.skippedFiles).toEqual([
                { file: 'rules/readme.md', reason: 'not a rule template' },
            ]);
            expect(mockRun).not.toHaveBeenCalled();
        });
    });

    describe('a .kody/rules file that stops parsing', () => {
        const existingRule = (over: Record<string, unknown> = {}) => ({
            uuid: 'rule-a',
            repositoryId: REPO.id,
            sourcePath: '.kody/rules/a.md',
            origin: KodyRulesOrigin.REPO_FILE_SYNC,
            status: KodyRulesStatus.ACTIVE,
            ...over,
        });

        it('keeps its rule active and flags it, instead of pausing a rule the team wrote', async () => {
            const { service, written, kodyRulesService } = makeService({
                allFiles: [{ path: '.kody/rules/a.md', size: 20 }],
                files: { '.kody/rules/a.md': 'Use integer cents for money.' },
                orgRules: [existingRule()],
            });

            await service.syncRepositoryMainFast({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(written()).toEqual([]);
            expect(
                kodyRulesService.updateRuleSourceFileIssue,
            ).toHaveBeenCalledWith(
                ORG.organizationId,
                'rule-a',
                'not_a_rule_template',
            );
        });

        it('does not flag it twice', async () => {
            const { service, kodyRulesService } = makeService({
                allFiles: [{ path: '.kody/rules/a.md', size: 20 }],
                files: { '.kody/rules/a.md': 'Use integer cents for money.' },
                orgRules: [
                    existingRule({ sourceFileIssue: 'not_a_rule_template' }),
                ],
            });

            await service.syncRepositoryMainFast({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(
                kodyRulesService.updateRuleSourceFileIssue,
            ).not.toHaveBeenCalled();
        });

        it('clears the flag once the file parses again', async () => {
            const { service, written } = makeService({
                allFiles: [{ path: '.kody/rules/a.md', size: 200 }],
                files: { '.kody/rules/a.md': TEMPLATE },
                orgRules: [
                    existingRule({ sourceFileIssue: 'not_a_rule_template' }),
                ],
            });

            await service.syncRepositoryMainFast({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(written()).toEqual([
                expect.objectContaining({
                    uuid: 'rule-a',
                    sourceFileIssue: null,
                }),
            ]);
        });
    });

    describe('syncRepositoryGlobal', () => {
        it('keeps global rules from a source repo coding-agent file frozen, and deletes removed templates', async () => {
            const { service, deleteRuleUseCase, codeManagementService } =
                makeService({
                    allFiles: [],
                    orgRules: [
                        {
                            uuid: 'from-claude',
                            repositoryId: 'global',
                            sourceRepositoryId: REPO.id,
                            origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
                            sourcePath: 'CLAUDE.md',
                            status: KodyRulesStatus.ACTIVE,
                        },
                        {
                            uuid: 'from-template',
                            repositoryId: 'global',
                            sourceRepositoryId: REPO.id,
                            origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
                            sourcePath: '.kody/rules/a.md',
                            status: KodyRulesStatus.ACTIVE,
                        },
                    ],
                });

            await service.syncRepositoryGlobal({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            const patterns: string[] =
                codeManagementService.getRepositoryAllFiles.mock.calls[0][0]
                    .filters.filePatterns;
            expect(patterns).not.toContain('CLAUDE.md');
            expect(
                deleteRuleUseCase.execute.mock.calls.map(([uuid]: [string]) => uuid),
            ).toEqual(['from-template']);
        });

        const globalRule = (over: Record<string, unknown> = {}) => ({
            uuid: 'global-a',
            repositoryId: 'global',
            sourceRepositoryId: REPO.id,
            origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
            sourcePath: '.kody/rules/a.md',
            status: KodyRulesStatus.ACTIVE,
            ...over,
        });

        it('flags a global rule whose file stopped parsing, and keeps it', async () => {
            const { service, kodyRulesService, deleteRuleUseCase } =
                makeService({
                    allFiles: [
                        { path: '.kody/rules/a.md', size: 20, sha: 'new' },
                    ],
                    files: {
                        '.kody/rules/a.md': 'Use integer cents for money.',
                    },
                    orgRules: [globalRule()],
                });

            await service.syncRepositoryGlobal({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(
                kodyRulesService.updateRuleSourceFileIssue,
            ).toHaveBeenCalledWith(
                ORG.organizationId,
                'global-a',
                'not_a_rule_template',
            );
            expect(deleteRuleUseCase.execute).not.toHaveBeenCalled();
        });

        it('clears the flag when the file is reverted to the version it last synced', async () => {
            const { service, written } = makeService({
                allFiles: [{ path: '.kody/rules/a.md', size: 200, sha: 'synced' }],
                files: { '.kody/rules/a.md': TEMPLATE },
                orgRules: [
                    globalRule({
                        sourceFileIssue: 'not_a_rule_template',
                        lastContentHash: 'synced',
                    }),
                ],
            });

            await service.syncRepositoryGlobal({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(written()).toEqual([
                expect.objectContaining({
                    uuid: 'global-a',
                    sourceFileIssue: null,
                }),
            ]);
        });

        it('clears the flag on a global rule once its file parses again', async () => {
            const { service, written } = makeService({
                allFiles: [{ path: '.kody/rules/a.md', size: 200, sha: 'new' }],
                files: { '.kody/rules/a.md': TEMPLATE },
                orgRules: [
                    globalRule({ sourceFileIssue: 'not_a_rule_template' }),
                ],
            });

            await service.syncRepositoryGlobal({
                organizationAndTeamData: ORG,
                repository: REPO,
            });

            expect(written()).toEqual([
                expect.objectContaining({
                    uuid: 'global-a',
                    sourceFileIssue: null,
                }),
            ]);
        });
    });
});

/**
 * A merge that renames a rule file reaches the sync as ONE `renamed` entry
 * carrying `previous_filename`. The old path must end with no live record:
 * the newest one is re-keyed in place (its uuid survives) and every other
 * record on the old path is soft-deleted.
 */
describe('KodyRulesSyncService.syncFromChangedFiles — renamed rule file', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const OLD = '.kody/rules/old.md';
    const NEW = '.kody/rules/new.md';

    const makeService = (
        rules: any[],
        opts: { centralized?: boolean } = {},
    ) => {
        const store = rules.map((r) => ({ ...r }));
        const write = (dto: any) => {
            const hit = store.find((r) => r.uuid === dto.uuid);
            if (hit) Object.assign(hit, dto);
            else store.push({ ...dto, uuid: `new-${store.length}` });
        };
        const kodyRulesService = {
            findByOrganizationId: jest.fn(async () => ({
                uuid: 'doc-1',
                rules: store.map((r) => ({ ...r })),
            })),
            createOrUpdate: jest.fn(async (_org: unknown, dto: any) =>
                write(dto),
            ),
        };
        const createOrUpdateKodyRulesUseCase = {
            // Centralized-config mode returns PR metadata and defers the
            // write, so the re-keyed record is still on the old path.
            execute: jest.fn(async (dto: any) =>
                opts.centralized ? { prUrl: 'x' } : write(dto),
            ),
        };
        const deps: any[] = new Array(KodyRulesSyncService.length).fill({});
        deps[0] = kodyRulesService;
        deps[3] = { getPullRequestByNumber: jest.fn().mockResolvedValue({}) };
        deps[4] = { execute: jest.fn().mockResolvedValue({}) };
        deps[5] = createOrUpdateKodyRulesUseCase;
        const service = new (KodyRulesSyncService as any)(...deps);
        jest.spyOn(service, 'getMergedFileContent').mockResolvedValue('body');
        jest.spyOn(service, 'templateFileToRule').mockResolvedValue({
            kind: 'rule',
            rule: { title: 't', rule: 'r', path: '**/*.ts' },
        });
        jest.spyOn(service, 'resolveDirectoryForFile').mockResolvedValue(null);
        jest.spyOn(service, 'processContextReferences').mockResolvedValue(
            undefined,
        );
        return { service, store };
    };

    const record = (uuid: string, createdAt: string) => ({
        uuid,
        repositoryId: 'repo-1',
        sourcePath: OLD,
        status: KodyRulesStatus.ACTIVE,
        createdAt,
    });

    const sync = (service: any) =>
        service.syncFromChangedFiles({
            organizationAndTeamData: ORG,
            repository: { id: 'repo-1', name: 'repo' },
            pullRequestNumber: 7,
            files: [
                { filename: NEW, previous_filename: OLD, status: 'renamed' },
            ],
        });

    const live = (store: any[], path: string) =>
        store.filter(
            (r) =>
                r.sourcePath === path && r.status !== KodyRulesStatus.DELETED,
        );

    it('leaves 0 live records on the old path and 1 on the new one', async () => {
        const { service, store } = makeService([
            record('older', '2026-01-01T00:00:00Z'),
            record('newer', '2026-01-02T00:00:00Z'),
        ]);

        await sync(service);

        expect(live(store, OLD)).toEqual([]);
        expect(live(store, NEW).map((r) => r.uuid)).toEqual(['newer']);
        expect(store.find((r) => r.uuid === 'older').status).toBe(
            KodyRulesStatus.DELETED,
        );
    });

    it('spares the record being re-keyed when the write is deferred (centralized mode)', async () => {
        const { service, store } = makeService(
            [
                record('older', '2026-01-01T00:00:00Z'),
                record('newer', '2026-01-02T00:00:00Z'),
            ],
            { centralized: true },
        );

        await sync(service);

        expect(live(store, OLD).map((r) => r.uuid)).toEqual(['newer']);
        expect(store.find((r) => r.uuid === 'older').status).toBe(
            KodyRulesStatus.DELETED,
        );
    });
});
