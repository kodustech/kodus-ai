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
 * Parity gate for the FastBatch conversions migrated OFF the LangChain
 * (BYOKPromptRunner.builder().execute()) path ONTO the AI SDK
 * runStructuredReviewCall path. The prior implementation returned each parsed
 * rule spread with `{ repositoryId, status: PENDING }` and capped at 3; the
 * migrated call must produce the SAME normalized DTOs from the same parsed
 * `{ rules: [...] }` shape. runStructuredReviewCall is mocked (the parse seam),
 * exactly as structured-review-call.spec.ts mocks tracedGenerateText — driving
 * the real structured Output.object path over a MockLanguageModel HANGS.
 */
describe('KodyRulesSyncService FastBatch conversions — AI SDK migration parity', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };

    const makeService = () => {
        const permissionValidationService = {
            // FastBatch parity test only exercises DTO mapping — the resolved
            // carrier is irrelevant, so null (env default) is fine.
            resolveTaskSlot: jest.fn().mockResolvedValue(null),
        };
        const observabilityService = {
            runAiSdkLLMInSpan: jest.fn(),
        };
        const deps: any[] = new Array(11).fill({});
        deps[7] = permissionValidationService; // permissionValidationService
        deps[8] = observabilityService; // observabilityService
        const service = new (KodyRulesSyncService as any)(...deps);
        return { service, observabilityService };
    };

    beforeEach(() => mockRun.mockReset());

    it('convertFilesToKodyRulesFastBatch maps rules to normalized DTOs (repositoryId + PENDING), never wraps in runLLMInSpan', async () => {
        const rule = {
            title: 'No any',
            rule: 'Avoid using any in TypeScript',
            path: '**/*.ts',
            sourcePath: 'docs/guide.md',
            severity: 'high',
            scope: 'file',
            examples: [{ snippet: 'const x: any = 1', isCorrect: false }],
        };
        mockRun.mockResolvedValue({ rules: [rule] });
        const { service, observabilityService } = makeService();

        const result = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [{ path: 'docs/guide.md', content: '# Guide' }],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        // Exactly ONE span path: runStructuredReviewCall fires its own internal
        // span; the outer runLLMInSpan wrapper is gone (Q4 — no double-count).
        // On the happy path the raw-JSON catch's runAiSdkLLMInSpan is untouched.
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(observabilityService.runAiSdkLLMInSpan).not.toHaveBeenCalled();

        // Migration shape: byokConfig/schema/system/user/runName routed through
        // runStructuredReviewCall; no parser correction-model override survives.
        const callArg = mockRun.mock.calls[0][0];
        expect(callArg).toEqual(
            expect.objectContaining({
                schema: expect.anything(),
                system: expect.any(String),
                user: expect.stringContaining('docs/guide.md'),
                runName: expect.stringContaining(
                    'kodyRulesFilesToRulesFastBatch',
                ),
            }),
        );

        // Parity: same normalized DTO the pre-migration path produced.
        expect(result).toEqual([
            { ...rule, repositoryId: 'repo-1', status: KodyRulesStatus.PENDING },
        ]);
    });

    it('convertManifestsToKodyRulesFastBatch maps rules to normalized DTOs (repositoryId + PENDING)', async () => {
        const rule = {
            title: 'Pin deps',
            rule: 'Avoid floating dependency ranges',
            path: 'package.json',
            severity: 'medium',
            examples: [{ snippet: '"lib": "^1"', isCorrect: false }],
        };
        mockRun.mockResolvedValue({ rules: [rule] });
        const { service, observabilityService } = makeService();

        const result = await (
            service as any
        ).convertManifestsToKodyRulesFastBatch({
            files: [{ path: 'package.json', content: '{}' }],
            repositoryId: 'repo-2',
            organizationAndTeamData: ORG,
        });

        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(observabilityService.runAiSdkLLMInSpan).not.toHaveBeenCalled();
        expect(mockRun.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                runName: expect.stringContaining(
                    'kodyRulesManifestsToRulesFastBatch',
                ),
            }),
        );
        expect(result).toEqual([
            { ...rule, repositoryId: 'repo-2', status: KodyRulesStatus.PENDING },
        ]);
    });
});

/**
 * ── LLM.run I/O CONTRACT MATRIX for the KodyRulesSync parse boundary ──
 *
 * The boundary calls `LLM.run` at three parse sites, each with a structured
 * (schema) primary + a raw-JSON fallback:
 *   - convertFileToKodyRules          (schema kodyRulesIDEGeneratorSchema)
 *   - convertFilesToKodyRulesFastBatch(schema ...SchemaOnboarding)
 *   - convertManifestsToKodyRulesFastBatch(schema ...ManifestGenerator...)
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
 * FastBatch parse sites — input-variant (D) + cap/order invariants. These use
 * `kodyRulesIDEGeneratorSchemaOnboarding` / manifest schema and cap output at 3.
 */
describe('KodyRulesSyncService FastBatch — input variants, cap, order (D rows)', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const makeService = () => {
        const permissionValidationService = {
            resolveTaskSlot: jest.fn().mockResolvedValue(null),
        };
        const deps: any[] = new Array(11).fill({});
        deps[7] = permissionValidationService;
        return new (KodyRulesSyncService as any)(...deps);
    };
    const mkRule = (title: string) => ({
        title,
        rule: 'R ' + title,
        path: '**/*.ts',
        sourcePath: 'docs/x.md',
        severity: 'medium',
        examples: [],
    });

    beforeEach(() => {
        mockRun.mockReset();
        mockText.mockReset();
    });

    // Row 37/41 — cap at 3 (off-by-one boundary): 5 → 3, exactly 3 → 3, 2 → 2.
    it.each([
        [5, 3],
        [3, 3],
        [2, 2],
    ])(
        'Row 37/41: model returns %i rules → capped to %i (repositoryId + PENDING each)',
        async (n, expected) => {
            const rules = Array.from({ length: n }, (_, i) => mkRule('r' + i));
            mockRun.mockResolvedValue({ rules });
            const service = makeService();

            const result = await (service as any).convertFilesToKodyRulesFastBatch({
                files: [{ path: 'docs/x.md', content: '# x' }],
                repositoryId: 'repo-1',
                organizationAndTeamData: ORG,
            });

            expect(result).toHaveLength(expected);
            result.forEach((r: any) => {
                expect(r.repositoryId).toBe('repo-1');
                expect(r.status).toBe(KodyRulesStatus.PENDING);
            });
        },
    );

    // Row 42 — order permutation → equivalent set of DTOs (order preserved but
    // set-equal; the boundary does not sort, so permutation is metamorphic-safe).
    it('Row 42: permuted rule order → same SET of normalized DTOs', async () => {
        const a = [mkRule('a'), mkRule('b'), mkRule('c')];
        const b = [mkRule('c'), mkRule('a'), mkRule('b')];
        const service = makeService();

        mockRun.mockResolvedValueOnce({ rules: a });
        const r1 = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [{ path: 'docs/x.md', content: '# x' }],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });
        mockRun.mockResolvedValueOnce({ rules: b });
        const r2 = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [{ path: 'docs/x.md', content: '# x' }],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        const titles = (arr: any[]) => arr.map((r) => r.title).sort();
        expect(titles(r1)).toEqual(titles(r2));
    });

    // Row 35 — empty input files → [] (model returns no rules).
    it('Row 35: empty files input → []', async () => {
        mockRun.mockResolvedValue({ rules: [] });
        const service = makeService();

        const result = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        expect(result).toEqual([]);
    });

    // Row 38 — duplicate input items → each maps through without crashing.
    it('Row 38: duplicate input files → mapped without crash', async () => {
        mockRun.mockResolvedValue({ rules: [mkRule('a')] });
        const service = makeService();

        const result = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [
                { path: 'docs/x.md', content: '# x' },
                { path: 'docs/x.md', content: '# x' },
            ],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
    });

    // Row 39 — input item with null required fields → no crash.
    it('Row 39: input file with null path/content → no crash, still returns array', async () => {
        mockRun.mockResolvedValue({ rules: [mkRule('a')] });
        const service = makeService();

        const result = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [{ path: null, content: null } as any],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        expect(Array.isArray(result)).toBe(true);
    });

    // Row 37 (large / crossing) — a big multi-file batch is assembled into ONE
    // user prompt (no chunking at this boundary) and still capped at 3.
    it('Row 37: large multi-file batch → single request, capped at 3', async () => {
        const files = Array.from({ length: 40 }, (_, i) => ({
            path: `docs/f${i}.md`,
            content: 'x'.repeat(500),
        }));
        mockRun.mockResolvedValue({
            rules: [mkRule('a'), mkRule('b'), mkRule('c'), mkRule('d')],
        });
        const service = makeService();

        const result = await (service as any).convertFilesToKodyRulesFastBatch({
            files,
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(3);
    });

    // C — FastBatch raw fallback: structured throws → extractJsonArray path.
    it('Row 30: FastBatch structured throws → raw fallback recovers (capped 3)', async () => {
        mockRun.mockRejectedValue(new Error('boom'));
        mockText.mockResolvedValue(
            JSON.stringify([mkRule('a'), mkRule('b'), mkRule('c'), mkRule('d')]),
        );
        const service = makeService();

        const result = await (service as any).convertFilesToKodyRulesFastBatch({
            files: [{ path: 'docs/x.md', content: '# x' }],
            repositoryId: 'repo-1',
            organizationAndTeamData: ORG,
        });

        expect(mockText).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(3);
    });

    it('Row 30: FastBatch both throw → [] (never throws past boundary)', async () => {
        mockRun.mockRejectedValue(new Error('a'));
        mockText.mockRejectedValue(new Error('b'));
        const service = makeService();

        await expect(
            (service as any).convertFilesToKodyRulesFastBatch({
                files: [{ path: 'docs/x.md', content: '# x' }],
                repositoryId: 'repo-1',
                organizationAndTeamData: ORG,
            }),
        ).resolves.toEqual([]);
    });

    // Manifest site — structured cap + raw fallback parity.
    it('Row 37 (manifest): >3 rules capped to 3; raw fallback recovers on throw', async () => {
        const service = makeService();
        mockRun.mockResolvedValueOnce({
            rules: [mkRule('a'), mkRule('b'), mkRule('c'), mkRule('d')],
        });
        const structured = await (
            service as any
        ).convertManifestsToKodyRulesFastBatch({
            files: [{ path: 'package.json', content: '{}' }],
            repositoryId: 'repo-2',
            organizationAndTeamData: ORG,
        });
        expect(structured).toHaveLength(3);

        mockRun.mockRejectedValueOnce(new Error('boom'));
        mockText.mockResolvedValueOnce(
            JSON.stringify([mkRule('a'), mkRule('b')]),
        );
        const raw = await (service as any).convertManifestsToKodyRulesFastBatch({
            files: [{ path: 'package.json', content: '{}' }],
            repositoryId: 'repo-2',
            organizationAndTeamData: ORG,
        });
        expect(raw).toHaveLength(2);
        raw.forEach((r: any) => {
            expect(r.repositoryId).toBe('repo-2');
            expect(r.status).toBe(KodyRulesStatus.PENDING);
        });
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
