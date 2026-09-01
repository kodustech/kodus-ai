import {
    KodyRulesStatus,
    KodyRulesType,
    KodyRulesOrigin,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

// EE services pull `@libs/ee/configs/environment`, which is gitignored (copied
// from environment.dev.ts for local builds) — mock it so the suite runs anywhere.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false, API_DEVELOPMENT_MODE: false },
}));

// The LLM.run boundary is THE seam under contract test here. Fully replace the
// module so the spec never drags in the AI SDK / structured-review-call graph,
// and so every test controls exactly what the model layer hands back.
jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { KodyRulesService } from './kodyRules.service';
import { LLM } from '@libs/llm/llm';
import { LLM_TASK } from '@libs/llm/byok-config';
import { kodyRulesRecommendationSchema } from '@libs/common/utils/prompts/kodyRulesRecommendation';
import {
    kodyMemoryResolutionSchema,
    prompt_kodyMemoryResolution_system,
} from '@libs/common/utils/prompts/kodyMemoryResolution';

const llmRun = LLM.run as unknown as jest.Mock;

/**
 * syncRulesWithPlanLimit is the plan-limit enforcement gate for Kody Rules — the
 * billing-critical decision that pauses a FREE org's rules past the ceiling and
 * un-pauses a paid org's plan-locked rules. A regression either lets a FREE org
 * run unlimited rules (revenue leak) or silently drops a paying customer's rules.
 * The repo/license deps are stubbed; these pin the decision, not the I/O.
 */
describe('KodyRulesService.syncRulesWithPlanLimit — plan-limit enforcement', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const MAX = 10;

    let repo: { findByOrganizationId: jest.Mock; updateRule: jest.Mock };
    let permission: { shouldLimitResources: jest.Mock };
    let svc: KodyRulesService;

    const entityOf = (rules: any[]) => ({
        uuid: 'doc-1',
        toObject: () => ({ rules }),
    });

    const rule = (i: number, over: Record<string, unknown> = {}) => ({
        uuid: `r${i}`,
        status: KodyRulesStatus.ACTIVE,
        lockedByPlan: false,
        ...over,
    });

    beforeEach(() => {
        repo = {
            findByOrganizationId: jest.fn().mockResolvedValue(null),
            updateRule: jest.fn().mockResolvedValue(true),
        };
        permission = { shouldLimitResources: jest.fn() };
        svc = new KodyRulesService(
            repo as any, // 1 kodyRulesRepository
            {} as any, // 2 eventEmitter
            {} as any, // 3 ruleLikeService
            {} as any, // 4 pullRequestsRepository
            { MAX_KODY_RULES: MAX } as any, // 5 kodyRulesValidationService
            {} as any, // 6 mcpManagerService
            {} as any, // 7 observabilityService
            permission as any, // 8 permissionValidationService
            {} as any, // 9 moduleRef
            {} as any, // 10 codeBaseConfigService
            undefined, // 11 kodyRuleSummaryService (optional)
        );
        jest.spyOn((svc as any).logger, 'log').mockImplementation(() => {});
        jest.spyOn((svc as any).logger, 'error').mockImplementation(() => {});
    });

    it('returns null when there is no organization id', async () => {
        expect(await svc.syncRulesWithPlanLimit({} as any)).toBeNull();
    });

    it('returns the entity untouched (no writes) when it has no rules', async () => {
        const entity = entityOf([]);
        const out = await svc.syncRulesWithPlanLimit(ORG, {
            entity: entity as any,
            limited: true,
        });
        expect(out).toBe(entity);
        expect(repo.updateRule).not.toHaveBeenCalled();
    });

    it('FREE plan: pauses ONLY the active rules beyond the 10-rule ceiling, locked by plan', async () => {
        const rules = Array.from({ length: 12 }, (_, i) => rule(i + 1));
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf(rules) as any,
            limited: true,
        });

        expect(repo.updateRule).toHaveBeenCalledTimes(2); // only #11 and #12
        expect(repo.updateRule).toHaveBeenCalledWith(
            'doc-1',
            'r11',
            expect.objectContaining({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            }),
        );
        expect(repo.updateRule).toHaveBeenCalledWith(
            'doc-1',
            'r12',
            expect.objectContaining({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            }),
        );
    });

    it('FREE plan: exactly 10 active rules is within the ceiling — no changes', async () => {
        const entity = entityOf(Array.from({ length: MAX }, (_, i) => rule(i + 1)));
        const out = await svc.syncRulesWithPlanLimit(ORG, {
            entity: entity as any,
            limited: true,
        });
        expect(repo.updateRule).not.toHaveBeenCalled();
        expect(out).toBe(entity);
    });

    it('PAID plan: un-pauses plan-locked rules but leaves manually-paused ones alone', async () => {
        const rules = [
            rule(1, { status: KodyRulesStatus.PAUSED, lockedByPlan: true }), // plan-locked → unpause
            rule(2, { status: KodyRulesStatus.PAUSED, lockedByPlan: false }), // manual pause → leave
            rule(3), // active → leave
        ];
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf(rules) as any,
            limited: false,
        });

        expect(repo.updateRule).toHaveBeenCalledTimes(1); // only the plan-locked one
        expect(repo.updateRule).toHaveBeenCalledWith(
            'doc-1',
            'r1',
            expect.objectContaining({
                status: KodyRulesStatus.ACTIVE,
                lockedByPlan: false,
            }),
        );
    });

    it('reuses the caller-provided `limited` flag instead of a second license lookup', async () => {
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf([rule(1)]) as any,
            limited: false,
        });
        expect(permission.shouldLimitResources).not.toHaveBeenCalled();
    });

    it('falls back to shouldLimitResources when `limited` is not provided', async () => {
        permission.shouldLimitResources.mockResolvedValue(false);
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf([
                rule(1, { status: KodyRulesStatus.PAUSED, lockedByPlan: true }),
            ]) as any,
        });
        expect(permission.shouldLimitResources).toHaveBeenCalled();
        expect(repo.updateRule).toHaveBeenCalledTimes(1); // paid → unpaused
    });

    it('loads the rules doc itself when the caller does not pass the entity', async () => {
        repo.findByOrganizationId.mockResolvedValue(
            entityOf([
                rule(1, { status: KodyRulesStatus.PAUSED, lockedByPlan: true }),
            ]),
        );
        await svc.syncRulesWithPlanLimit(ORG, { limited: false });
        expect(repo.findByOrganizationId).toHaveBeenCalledWith('org-1');
        expect(repo.updateRule).toHaveBeenCalledTimes(1);
    });

    it('is fail-safe when the limit check throws — returns the entity, changes nothing', async () => {
        permission.shouldLimitResources.mockRejectedValue(
            new Error('license service down'),
        );
        const entity = entityOf([rule(1)]);
        const out = await svc.syncRulesWithPlanLimit(ORG, {
            entity: entity as any,
        }); // no `limited` → forces the lookup that throws
        expect(out).toBe(entity);
        expect(repo.updateRule).not.toHaveBeenCalled();
    });

    it('is fail-safe when a per-rule update rejects — it never throws, and logs the failure', async () => {
        repo.updateRule.mockRejectedValue(new Error('mongo write failed'));
        const rules = Array.from({ length: 12 }, (_, i) => rule(i + 1));
        // Promise.allSettled means the rejections are logged, not thrown.
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf(rules) as any,
            limited: true,
        });
        expect((svc as any).logger.error).toHaveBeenCalled();
    });
});

/* ===========================================================================
 * LLM.run I/O CONTRACT — the two structured-output boundaries in this service.
 *
 * B1  getRecommendedRulesBySuggestions  (kodyRules.service.ts:1638)
 *       schema D = { recommendations: [{ uuid, reason, relevanceScore }] }
 *       consumer: 1652-1664 — `!result?.recommendations → []`, else map uuids
 *       → filter the library; whole method wrapped in try/catch → [].
 *       Declared return type: LibraryKodyRule[]  (ALWAYS an array).
 *
 * B2  evaluateMemoryActionViaLLM  (kodyRules.service.ts:2132)  +
 *     resolveGeneratedMemoryAction consumer  (1987-2033)
 *       schema D = { action: 'create'|'skip'|'update', targetMemoryUuid?, ... }
 *       consumer: `!result?.action || 'create' → create`; skip/update require a
 *       matched memory; try/catch → documented safe default 'create'.
 *
 * Every matrix row (llm-io-contract-matrix.md, rows 1-42) is asserted below.
 * These pin the DETERMINISTIC layer only: request assembly, envelope handling,
 * fail-safe, and the guaranteed return shape — NOT model decision quality.
 * ======================================================================== */

// A real uuid from data/library-kody-rules.json so B1's uuid→library filter can
// actually resolve a rule on the happy path.
const REAL_LIBRARY_UUID = '9e7b6dc6-7b19-4e1f-9c71-2c9c1a3b1d00';

describe('KodyRulesService — LLM.run contract: getRecommendedRulesBySuggestions (B1)', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const REPO = 'repo-1';

    let pullRequestsRepository: { findRecentByRepositoryId: jest.Mock };
    let permission: { resolveTaskSlot: jest.Mock };
    let svc: KodyRulesService;

    const suggestion = (over: Record<string, unknown> = {}) => ({
        label: 'l',
        severity: 'high',
        suggestionContent: 'avoid X',
        oneSentenceSummary: 's',
        ...over,
    });

    const prWith = (suggestions: any[]) => ({
        toObject: () => ({ files: [{ suggestions }] }),
    });

    const makeSvc = () => {
        const s = new KodyRulesService(
            {} as any, // 1 kodyRulesRepository
            {} as any, // 2 eventEmitter
            {} as any, // 3 ruleLikeService
            pullRequestsRepository as any, // 4 pullRequestsRepository
            {} as any, // 5 kodyRulesValidationService
            {} as any, // 6 mcpManagerService
            {} as any, // 7 observabilityService
            permission as any, // 8 permissionValidationService
            {} as any, // 9 moduleRef
            {} as any, // 10 codeBaseConfigService
            undefined, // 11 kodyRuleSummaryService
        );
        jest.spyOn((s as any).logger, 'log').mockImplementation(() => {});
        jest.spyOn((s as any).logger, 'error').mockImplementation(() => {});
        return s;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        pullRequestsRepository = { findRecentByRepositoryId: jest.fn() };
        permission = {
            resolveTaskSlot: jest
                .fn()
                .mockResolvedValue({ provider: 'openai', model: 'gpt' }),
        };
        // Default: one PR carrying one suggestion so the method reaches LLM.run.
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([suggestion()]),
        ]);
        svc = makeSvc();
    });

    // ---- Request assembly + byokConfig threading (deterministic wiring) -----
    it('assembles the LLM.run request exactly: schema D, system, user, runName, org, byokConfig from resolveTaskSlot', async () => {
        llmRun.mockResolvedValue({ recommendations: [] });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO, undefined);

        expect(permission.resolveTaskSlot).toHaveBeenCalledWith(
            ORG,
            LLM_TASK.codeReview,
        );
        expect(llmRun).toHaveBeenCalledTimes(1);
        const req = llmRun.mock.calls[0][0];
        expect(req.schema).toBe(kodyRulesRecommendationSchema);
        expect(req.byokConfig).toEqual({ provider: 'openai', model: 'gpt' });
        expect(req.organizationId).toBe('org-1');
        expect(req.runName).toBe(
            'KodyRulesService::kodyRulesRecommendationFromSuggestions',
        );
        expect(typeof req.system).toBe('string');
        expect(req.system).toContain('Kody Rules');
        expect(req.user).toContain('avoid X'); // the suggestion content is in-prompt
        expect(req.attrs).toEqual(
            expect.objectContaining({ repositoryId: REPO, suggestionsCount: 1 }),
        );
    });

    it('threads byokConfig as undefined (managed default) when resolveTaskSlot returns null', async () => {
        permission.resolveTaskSlot.mockResolvedValue(null);
        llmRun.mockResolvedValue({ recommendations: [] });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].byokConfig).toBeUndefined();
    });

    // ============================ A. output-shape zoo ======================
    it('row 1 — exact D: recovers the payload and maps uuids to library rules', async () => {
        llmRun.mockResolvedValue({
            recommendations: [
                { uuid: REAL_LIBRARY_UUID, reason: 'r', relevanceScore: 8 },
            ],
        });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(Array.isArray(out)).toBe(true);
        expect(out.map((r) => r.uuid)).toContain(REAL_LIBRARY_UUID);
    });

    // row 2 — bare array of the inner items instead of {recommendations:[...]}.
    // Prod reads `result?.recommendations` (undefined here) and SILENTLY returns
    // [] — a real payload dropped with no signal (#1786 class). Correct behavior
    // is to recover it. Pinned as it.failing (green now, red on the fix).
    // Source: libs/ee/kodyRules/service/kodyRules.service.ts:1652.
    it.failing('row 2 — bare array: recovers the dropped payload', async () => {
        llmRun.mockResolvedValue([
            { uuid: REAL_LIBRARY_UUID, reason: 'r', relevanceScore: 8 },
        ]);
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out.length).toBeGreaterThan(0);
    });

    it('row 3 — single object where an array is expected: fail-safe to [] (never throws past the boundary)', async () => {
        // recommendations is an object, so `.length===0` is false and `.map`
        // throws — the outer try/catch converts it to the safe empty return.
        llmRun.mockResolvedValue({
            recommendations: { uuid: REAL_LIBRARY_UUID },
        });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out).toEqual([]);
    });

    // row 4 — wrapper key {result:D}. Same silent drop as row 2.
    it.failing('row 4 — wrapper key {result:D}: recovers the dropped payload', async () => {
        llmRun.mockResolvedValue({
            result: {
                recommendations: [
                    { uuid: REAL_LIBRARY_UUID, reason: 'r', relevanceScore: 8 },
                ],
            },
        });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out.length).toBeGreaterThan(0);
    });

    it('row 5 — double wrapper {result:{result:D}}: returns the safe empty default (no payload surfaces)', async () => {
        llmRun.mockResolvedValue({ result: { result: { recommendations: [] } } });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 6 — numeric/opaque single-key wrap ({"0":D}/{content:D}): safe empty default', async () => {
        llmRun.mockResolvedValueOnce({ '0': { recommendations: [] } });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
        llmRun.mockResolvedValueOnce({ content: { recommendations: [] } });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 7 — stringified JSON: a string return has no .recommendations → safe []', async () => {
        llmRun.mockResolvedValue(
            JSON.stringify({ recommendations: [{ uuid: REAL_LIBRARY_UUID }] }),
        );
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 8 — markdown-fenced JSON string: safe []', async () => {
        llmRun.mockResolvedValue(
            '```json\n{"recommendations":[{"uuid":"x"}]}\n```',
        );
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 9 — prose-wrapped string: safe []', async () => {
        llmRun.mockResolvedValue('Here you go: {"recommendations":[]} thanks!');
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    // row 10 — right data, renamed key ({suggestions:[...]}). Silent drop.
    it.failing('row 10 — renamed key {suggestions:[...]}: recovers the dropped payload', async () => {
        llmRun.mockResolvedValue({
            suggestions: [
                { uuid: REAL_LIBRARY_UUID, reason: 'r', relevanceScore: 8 },
            ],
        });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out.length).toBeGreaterThan(0);
    });

    it('row 11 — case/convention mismatch ({Recommendations}): case-sensitive miss → safe [] (shared drop, ts:1652)', async () => {
        llmRun.mockResolvedValue({
            Recommendations: [{ uuid: REAL_LIBRARY_UUID }],
        });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 12 — partial items (uuid only, other keys missing): tolerated, still maps by uuid', async () => {
        llmRun.mockResolvedValue({
            recommendations: [{ uuid: REAL_LIBRARY_UUID }],
        });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out.map((r) => r.uuid)).toContain(REAL_LIBRARY_UUID);
    });

    it('row 13 — extra unknown keys alongside the right ones: tolerated, does not crash', async () => {
        llmRun.mockResolvedValue({
            meta: 'ignore me',
            recommendations: [
                {
                    uuid: REAL_LIBRARY_UUID,
                    reason: 'r',
                    relevanceScore: 8,
                    unexpected: true,
                },
            ],
        });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out.map((r) => r.uuid)).toContain(REAL_LIBRARY_UUID);
    });

    it('row 14 — empty object {}: safe []', async () => {
        llmRun.mockResolvedValue({});
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 15 — empty array (both {recommendations:[]} and bare []): safe []', async () => {
        llmRun.mockResolvedValueOnce({ recommendations: [] });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
        llmRun.mockResolvedValueOnce([]);
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 16 — empty / whitespace string: safe []', async () => {
        llmRun.mockResolvedValueOnce('');
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
        llmRun.mockResolvedValueOnce('   \n\t ');
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 17 — null / undefined return: safe []', async () => {
        llmRun.mockResolvedValueOnce(null);
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
        llmRun.mockResolvedValueOnce(undefined);
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 18 — primitive where object expected (true/0/"ok"): safe []', async () => {
        for (const v of [true, 0, 'ok']) {
            llmRun.mockResolvedValueOnce(v);
            expect(
                await svc.getRecommendedRulesBySuggestions(ORG, REPO),
            ).toEqual([]);
        }
    });

    it('row 19 — provider envelope leak ({choices:[{message:{content}}]}): not unwrapped here → safe []', async () => {
        llmRun.mockResolvedValue({
            choices: [{ message: { content: '{"recommendations":[]}' } }],
        });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 20 — reasoning/thinking leak in content (prose string): safe []', async () => {
        llmRun.mockResolvedValue(
            '<thinking>let me analyze…</thinking> no signature block',
        );
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    // ============================ B. semantic-but-wrong ====================
    it('row 25 — dangling reference: a uuid absent from the library is dropped → safe []', async () => {
        llmRun.mockResolvedValue({
            recommendations: [
                { uuid: 'ghost-uuid-not-in-library', reason: 'r', relevanceScore: 5 },
            ],
        });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    // ============================ C. unparseable / transport ===============
    it('row 28 — truncated JSON surfaced as a parse error from LLM.run: fail-safe []', async () => {
        llmRun.mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 29 — malformed JSON error from LLM.run: fail-safe []', async () => {
        llmRun.mockRejectedValue(new SyntaxError('Unexpected token } in JSON'));
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 30 — LLM.run throws (network/timeout): never propagates, fail-safe []', async () => {
        llmRun.mockRejectedValue(new Error('ETIMEDOUT'));
        await expect(
            svc.getRecommendedRulesBySuggestions(ORG, REPO),
        ).resolves.toEqual([]);
    });

    it('row 31 — error object {error:...} returned instead of thrown: safe []', async () => {
        llmRun.mockResolvedValue({ error: 'model unavailable' });
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 32 — empty success (content ""): safe []', async () => {
        llmRun.mockResolvedValue('');
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 33 — refusal prose ("I cannot help…"): safe []', async () => {
        llmRun.mockResolvedValue("I'm sorry, I can't help with that.");
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    it('row 34 — abort signal surfaced as a rejection: fail-safe []', async () => {
        llmRun.mockRejectedValue(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
        );
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
    });

    // ============================ D. input variants ========================
    it('row 35 — empty input (no recent PRs): returns [] WITHOUT calling LLM.run', async () => {
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([]);
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('row 35b — PRs present but zero suggestions: returns [] WITHOUT calling LLM.run', async () => {
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([]),
        ]);
        expect(await svc.getRecommendedRulesBySuggestions(ORG, REPO)).toEqual([]);
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('row 36 — single suggestion: LLM.run called with suggestionsCount 1', async () => {
        llmRun.mockResolvedValue({ recommendations: [] });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].attrs.suggestionsCount).toBe(1);
    });

    it('row 37 — large input crossing the 50-suggestion cap: payload is capped at 50', async () => {
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith(Array.from({ length: 60 }, () => suggestion())),
        ]);
        llmRun.mockResolvedValue({ recommendations: [] });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].attrs.suggestionsCount).toBe(50);
    });

    it('row 38 — duplicate suggestions: not de-duplicated, all forwarded', async () => {
        const dup = suggestion({ suggestionContent: 'same' });
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([dup, { ...dup }, { ...dup }]),
        ]);
        llmRun.mockResolvedValue({ recommendations: [] });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].attrs.suggestionsCount).toBe(3);
    });

    it('row 39 — suggestion with null/undefined fields: mapped without throwing, still forwarded', async () => {
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([
                {
                    label: null,
                    severity: undefined,
                    suggestionContent: null,
                    oneSentenceSummary: null,
                },
            ]),
        ]);
        llmRun.mockResolvedValue({ recommendations: [] });
        const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(out).toEqual([]);
        expect(llmRun).toHaveBeenCalledTimes(1);
        expect(llmRun.mock.calls[0][0].attrs.suggestionsCount).toBe(1);
    });

    it('row 40 — special chars / whitespace in content: JSON-encoded into the prompt, no throw', async () => {
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([
                suggestion({
                    suggestionContent: '<script>💥"quote"\n\ttab</script>',
                }),
            ]),
        ]);
        llmRun.mockResolvedValue({ recommendations: [] });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].user).toContain('💥');
    });

    it('row 41 — off-by-one at the 50 cap: 51→50 and 49→49', async () => {
        llmRun.mockResolvedValue({ recommendations: [] });

        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith(Array.from({ length: 51 }, () => suggestion())),
        ]);
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].attrs.suggestionsCount).toBe(50);

        llmRun.mockClear();
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith(Array.from({ length: 49 }, () => suggestion())),
        ]);
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        expect(llmRun.mock.calls[0][0].attrs.suggestionsCount).toBe(49);
    });

    it('row 42 — order permutation: assembly forwards items in the given order (no reordering)', async () => {
        llmRun.mockResolvedValue({ recommendations: [] });
        const a = suggestion({ suggestionContent: 'AAA' });
        const b = suggestion({ suggestionContent: 'BBB' });

        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([a, b]),
        ]);
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        const user1 = llmRun.mock.calls[0][0].user as string;
        expect(user1.indexOf('AAA')).toBeLessThan(user1.indexOf('BBB'));

        llmRun.mockClear();
        pullRequestsRepository.findRecentByRepositoryId.mockResolvedValue([
            prWith([b, a]),
        ]);
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);
        const user2 = llmRun.mock.calls[0][0].user as string;
        expect(user2.indexOf('BBB')).toBeLessThan(user2.indexOf('AAA'));
    });

    // ============================ E. provider / model matrix ===============
    // The service DELEGATES the json_schema-vs-json_object decision to LLM.run:
    // it always hands the raw zod schema, unchanged, whatever slot resolveTaskSlot
    // returns. So the strict-branch models and the fallback-branch models produce
    // an identical request here; the off-schema zoo above already exercises the
    // fallback branch's degraded returns.
    it('E — request assembly is identical across a strict-branch and a fallback-branch slot (policy delegated)', async () => {
        llmRun.mockResolvedValue({ recommendations: [] });

        permission.resolveTaskSlot.mockResolvedValue({
            provider: 'openai',
            model: 'gpt',
        });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);

        permission.resolveTaskSlot.mockResolvedValue({
            provider: 'moonshotai',
            model: 'kimi-k2',
        });
        await svc.getRecommendedRulesBySuggestions(ORG, REPO);

        const [strict, fallback] = llmRun.mock.calls;
        expect(strict[0].schema).toBe(kodyRulesRecommendationSchema);
        expect(fallback[0].schema).toBe(kodyRulesRecommendationSchema);
        expect(strict[0].system).toBe(fallback[0].system);
        expect(strict[0].runName).toBe(fallback[0].runName);
    });

    // ---- declared-shape invariant across every layer ----------------------
    it('invariant — always returns an array, whatever LLM.run yields', async () => {
        for (const v of [
            { recommendations: [{ uuid: REAL_LIBRARY_UUID }] },
            {},
            null,
            'nonsense',
            42,
            [{ uuid: REAL_LIBRARY_UUID }],
        ]) {
            llmRun.mockResolvedValueOnce(v as any);
            const out = await svc.getRecommendedRulesBySuggestions(ORG, REPO);
            expect(Array.isArray(out)).toBe(true);
        }
        llmRun.mockRejectedValueOnce(new Error('boom'));
        expect(
            Array.isArray(await svc.getRecommendedRulesBySuggestions(ORG, REPO)),
        ).toBe(true);
    });
});

describe('KodyRulesService — LLM.run contract: memory resolution (B2)', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;

    let repo: { findByOrganizationId: jest.Mock };
    let permission: { resolveTaskSlot: jest.Mock };
    let svc: KodyRulesService;

    // A generated-origin memory with no uuid → drives resolveGeneratedMemoryAction
    // into the LLM branch.
    const genMemory = (over: Record<string, unknown> = {}) => ({
        title: 'incoming title',
        rule: 'incoming rule',
        repositoryId: 'r1',
        directoryId: 'd1',
        path: 'src/a.ts',
        origin: KodyRulesOrigin.PAST_REVIEWS,
        ...over,
    });

    const existingMemory = (uuid: string, over: Record<string, unknown> = {}) => ({
        uuid,
        type: KodyRulesType.MEMORY,
        status: KodyRulesStatus.ACTIVE,
        title: `title ${uuid}`,
        rule: `rule ${uuid}`,
        repositoryId: 'r1',
        directoryId: 'd1',
        path: 'src/a.ts',
        ...over,
    });

    const makeSvc = () => {
        const s = new KodyRulesService(
            repo as any, // 1 kodyRulesRepository
            {} as any, // 2 eventEmitter
            {} as any, // 3 ruleLikeService
            {} as any, // 4 pullRequestsRepository
            {} as any, // 5 kodyRulesValidationService
            {} as any, // 6 mcpManagerService
            {} as any, // 7 observabilityService
            permission as any, // 8 permissionValidationService
            {} as any, // 9 moduleRef
            {} as any, // 10 codeBaseConfigService
            undefined, // 11 kodyRuleSummaryService
        );
        jest.spyOn((s as any).logger, 'log').mockImplementation(() => {});
        jest.spyOn((s as any).logger, 'error').mockImplementation(() => {});
        return s;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        repo = { findByOrganizationId: jest.fn() };
        permission = {
            resolveTaskSlot: jest
                .fn()
                .mockResolvedValue({ provider: 'openai', model: 'gpt' }),
        };
        // One existing ACTIVE memory so the LLM branch is reached.
        repo.findByOrganizationId.mockResolvedValue({
            rules: [existingMemory('m1')],
        });
        svc = makeSvc();
    });

    const resolve = (memory: any) =>
        (svc as any).resolveGeneratedMemoryAction(ORG, memory);

    // ---- Request assembly on the raw boundary -----------------------------
    it('evaluateMemoryActionViaLLM assembles the request: schema D, prompts, runName, org, attrs, byokConfig', async () => {
        llmRun.mockResolvedValue({ action: 'create' });
        await (svc as any).evaluateMemoryActionViaLLM(ORG, genMemory(), [
            existingMemory('m1'),
        ]);

        expect(permission.resolveTaskSlot).toHaveBeenCalledWith(
            ORG,
            LLM_TASK.codeReview,
        );
        const req = llmRun.mock.calls[0][0];
        expect(req.schema).toBe(kodyMemoryResolutionSchema);
        expect(req.system).toBe(prompt_kodyMemoryResolution_system());
        expect(req.user).toContain('incoming title');
        expect(req.runName).toBe('kodyMemoryResolution');
        expect(req.organizationId).toBe('org-1');
        expect(req.byokConfig).toEqual({ provider: 'openai', model: 'gpt' });
        expect(req.attrs).toEqual({ existingMemoriesCount: 1 });
    });

    it('threads byokConfig undefined (managed default) when resolveTaskSlot returns null', async () => {
        permission.resolveTaskSlot.mockResolvedValue(null);
        llmRun.mockResolvedValue({ action: 'create' });
        await (svc as any).evaluateMemoryActionViaLLM(ORG, genMemory(), [
            existingMemory('m1'),
        ]);
        expect(llmRun.mock.calls[0][0].byokConfig).toBeUndefined();
    });

    // ============================ A. output-shape zoo ======================
    it('row 1 — exact D (skip w/ target): resolves to skip against the matched memory', async () => {
        llmRun.mockResolvedValue({ action: 'skip', targetMemoryUuid: 'm1' });
        const res = await resolve(genMemory());
        expect(res).toEqual({
            action: 'skip',
            existingMemory: expect.objectContaining({ uuid: 'm1' }),
        });
    });

    it('row 1b — exact D (update): threads updatedTitle/updatedRule into memoryToPersist', async () => {
        llmRun.mockResolvedValue({
            action: 'update',
            targetMemoryUuid: 'm1',
            updatedTitle: 'Refined',
            updatedRule: 'Refined rule',
        });
        const res = await resolve(genMemory());
        expect(res.action).toBe('update');
        expect(res.memoryToPersist).toEqual(
            expect.objectContaining({
                uuid: 'm1',
                title: 'Refined',
                rule: 'Refined rule',
            }),
        );
        expect(res.targetMemory).toEqual(
            expect.objectContaining({ uuid: 'm1' }),
        );
    });

    it('row 2 — bare array: no .action → documented safe default create (payload preserved)', async () => {
        llmRun.mockResolvedValue([{ action: 'skip', targetMemoryUuid: 'm1' }]);
        const res = await resolve(genMemory());
        expect(res).toEqual({
            action: 'create',
            memoryToPersist: expect.objectContaining({ title: 'incoming title' }),
        });
    });

    it('row 4 — wrapper key {result:D}: no top-level .action → safe default create', async () => {
        llmRun.mockResolvedValue({ result: { action: 'skip', targetMemoryUuid: 'm1' } });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 6 — {content:D} wrap: safe default create', async () => {
        llmRun.mockResolvedValue({ content: { action: 'skip' } });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('rows 7-9 — stringified / fenced / prose string: no .action → safe default create', async () => {
        for (const v of [
            '{"action":"skip","targetMemoryUuid":"m1"}',
            '```json\n{"action":"skip"}\n```',
            'Sure! {"action":"skip"} hope that helps',
        ]) {
            llmRun.mockResolvedValueOnce(v);
            expect((await resolve(genMemory())).action).toBe('create');
        }
    });

    it('row 10 — renamed key ({decision} instead of {action}): safe default create', async () => {
        llmRun.mockResolvedValue({ decision: 'skip', targetMemoryUuid: 'm1' });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 11 — case mismatch ({Action:"skip"}): safe default create', async () => {
        llmRun.mockResolvedValue({ Action: 'skip', targetMemoryUuid: 'm1' });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 12 — partial object (action:update but no targetMemoryUuid & no exact match): defaults to create', async () => {
        repo.findByOrganizationId.mockResolvedValue({
            rules: [existingMemory('m1', { title: 'unrelated', rule: 'unrelated' })],
        });
        llmRun.mockResolvedValue({ action: 'update' });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 13 — extra unknown keys alongside a valid action: tolerated', async () => {
        llmRun.mockResolvedValue({
            action: 'skip',
            targetMemoryUuid: 'm1',
            extra: 'ignore',
            confidence: 0.9,
        });
        expect((await resolve(genMemory())).action).toBe('skip');
    });

    it('row 14 — empty object {}: safe default create', async () => {
        llmRun.mockResolvedValue({});
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 15 — empty array []: safe default create', async () => {
        llmRun.mockResolvedValue([]);
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 16 — empty / whitespace string: safe default create', async () => {
        llmRun.mockResolvedValueOnce('');
        expect((await resolve(genMemory())).action).toBe('create');
        llmRun.mockResolvedValueOnce('   ');
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 17 — null / undefined: safe default create', async () => {
        llmRun.mockResolvedValueOnce(null);
        expect((await resolve(genMemory())).action).toBe('create');
        llmRun.mockResolvedValueOnce(undefined);
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 18 — primitive (true/0/"ok"): safe default create', async () => {
        for (const v of [true, 0, 'ok']) {
            llmRun.mockResolvedValueOnce(v);
            expect((await resolve(genMemory())).action).toBe('create');
        }
    });

    it('row 19 — provider envelope leak ({choices:[...]}): no .action → safe default create', async () => {
        llmRun.mockResolvedValue({
            choices: [{ message: { content: '{"action":"skip"}' } }],
        });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 20 — reasoning/thinking leak (prose string): safe default create', async () => {
        llmRun.mockResolvedValue('<thinking>hmm</thinking> unsigned');
        expect((await resolve(genMemory())).action).toBe('create');
    });

    // ============================ B. semantic-but-wrong ====================
    it('row 24 — enum out of allowed set (action:"URGENT"): falls through to safe default create', async () => {
        llmRun.mockResolvedValue({ action: 'URGENT', targetMemoryUuid: 'm1' });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 25 — dangling targetMemoryUuid (skip, uuid not in existing, no exact match): defaults to create', async () => {
        repo.findByOrganizationId.mockResolvedValue({
            rules: [existingMemory('m1', { title: 'unrelated', rule: 'unrelated' })],
        });
        llmRun.mockResolvedValue({ action: 'skip', targetMemoryUuid: 'ghost' });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 25b — dangling targetMemoryUuid BUT exact text match rescues the reference', async () => {
        // targetMemoryUuid is wrong, yet the incoming text exactly matches m1 →
        // the isExactMemoryMatch fallback still resolves skip against m1.
        repo.findByOrganizationId.mockResolvedValue({
            rules: [
                existingMemory('m1', {
                    title: 'incoming title',
                    rule: 'incoming rule',
                }),
            ],
        });
        llmRun.mockResolvedValue({ action: 'skip', targetMemoryUuid: 'ghost' });
        const res = await resolve(genMemory());
        expect(res).toEqual({
            action: 'skip',
            existingMemory: expect.objectContaining({ uuid: 'm1' }),
        });
    });

    it('row 27 — unicode/newlines/emoji in string fields: preserved (trimmed) through the update path', async () => {
        llmRun.mockResolvedValue({
            action: 'update',
            targetMemoryUuid: 'm1',
            updatedTitle: '  🚀 Título\n  ',
            updatedRule: '  regra café\t',
        });
        const res = await resolve(genMemory());
        expect(res.memoryToPersist.title).toBe('🚀 Título');
        expect(res.memoryToPersist.rule).toBe('regra café');
    });

    // ============================ C. unparseable / transport ===============
    it('row 28 — truncated JSON error from LLM.run: caught → safe default create, logged', async () => {
        llmRun.mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
        const res = await resolve(genMemory());
        expect(res.action).toBe('create');
        expect((svc as any).logger.error).toHaveBeenCalled();
    });

    it('row 29 — malformed JSON error: caught → safe default create', async () => {
        llmRun.mockRejectedValue(new SyntaxError('Unexpected token'));
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 30 — LLM.run throws (network): never propagates → safe default create', async () => {
        llmRun.mockRejectedValue(new Error('ECONNRESET'));
        await expect(resolve(genMemory())).resolves.toEqual(
            expect.objectContaining({ action: 'create' }),
        );
    });

    it('row 31 — error object {error:...}: no .action → safe default create', async () => {
        llmRun.mockResolvedValue({ error: 'model unavailable' });
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 32 — empty success (content ""): safe default create', async () => {
        llmRun.mockResolvedValue('');
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 33 — refusal prose: safe default create', async () => {
        llmRun.mockResolvedValue("I cannot help with that request.");
        expect((await resolve(genMemory())).action).toBe('create');
    });

    it('row 34 — abort surfaced as rejection: caught → safe default create', async () => {
        llmRun.mockRejectedValue(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
        );
        expect((await resolve(genMemory())).action).toBe('create');
    });

    // ============================ D. input variants ========================
    it('row 35 — no existing memories: resolves create WITHOUT calling LLM.run', async () => {
        repo.findByOrganizationId.mockResolvedValue({ rules: [] });
        const res = await resolve(genMemory());
        expect(res.action).toBe('create');
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('row 35b — non-generated origin short-circuits to null (no LLM, no resolution)', async () => {
        const res = await resolve(genMemory({ origin: KodyRulesOrigin.MANUAL }));
        expect(res).toBeNull();
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('row 35c — memory already carrying a uuid short-circuits to null', async () => {
        const res = await resolve(genMemory({ uuid: 'already-has-one' }));
        expect(res).toBeNull();
        expect(llmRun).not.toHaveBeenCalled();
    });

    it('row 36 — single existing memory: LLM.run called with existingMemoriesCount 1', async () => {
        llmRun.mockResolvedValue({ action: 'create' });
        await resolve(genMemory());
        expect(llmRun.mock.calls[0][0].attrs.existingMemoriesCount).toBe(1);
    });

    it('row 37 — large existing set crossing the prompt cap: attrs count is the full length, prompt slices to 50', async () => {
        const many = Array.from({ length: 60 }, (_, i) =>
            existingMemory(`m${i}`),
        );
        repo.findByOrganizationId.mockResolvedValue({ rules: many });
        llmRun.mockResolvedValue({ action: 'create' });
        await resolve(genMemory());
        const req = llmRun.mock.calls[0][0];
        expect(req.attrs.existingMemoriesCount).toBe(60);
        // prompt builder caps the embedded list at 50
        expect(req.user).toContain('m0');
        expect(req.user).not.toContain('"m59"');
    });

    it('row 38 — duplicate existing memories: forwarded as-is (count reflects duplicates)', async () => {
        const d = existingMemory('dup');
        repo.findByOrganizationId.mockResolvedValue({
            rules: [d, { ...d }, { ...d }],
        });
        llmRun.mockResolvedValue({ action: 'create' });
        await resolve(genMemory());
        expect(llmRun.mock.calls[0][0].attrs.existingMemoriesCount).toBe(3);
    });

    it('row 39 — existing memory with null/undefined fields: mapped without throwing', async () => {
        repo.findByOrganizationId.mockResolvedValue({
            rules: [
                {
                    uuid: 'm1',
                    type: KodyRulesType.MEMORY,
                    status: KodyRulesStatus.ACTIVE,
                    title: null,
                    rule: undefined,
                    repositoryId: null,
                    directoryId: undefined,
                    path: null,
                },
            ],
        });
        llmRun.mockResolvedValue({ action: 'create' });
        await expect(resolve(genMemory())).resolves.toEqual(
            expect.objectContaining({ action: 'create' }),
        );
        expect(llmRun).toHaveBeenCalledTimes(1);
    });

    it('row 40 — special chars / emoji in incoming memory: JSON-encoded into the prompt, no throw', async () => {
        llmRun.mockResolvedValue({ action: 'create' });
        await resolve(genMemory({ title: '💥"quote"\n<tag>' }));
        expect(llmRun.mock.calls[0][0].user).toContain('💥');
    });

    it('row 41 — off-by-one at the 50-item prompt cap: 51 in → count 51, item 51 not embedded', async () => {
        const many = Array.from({ length: 51 }, (_, i) =>
            existingMemory(`k${i}`),
        );
        repo.findByOrganizationId.mockResolvedValue({ rules: many });
        llmRun.mockResolvedValue({ action: 'create' });
        await resolve(genMemory());
        const req = llmRun.mock.calls[0][0];
        expect(req.attrs.existingMemoriesCount).toBe(51);
        expect(req.user).not.toContain('"k50"');
    });

    it('row 42 — order permutation: existing memories forwarded in given order', async () => {
        llmRun.mockResolvedValue({ action: 'create' });
        repo.findByOrganizationId.mockResolvedValue({
            rules: [existingMemory('AAA'), existingMemory('BBB')],
        });
        await resolve(genMemory());
        const u1 = llmRun.mock.calls[0][0].user as string;
        expect(u1.indexOf('AAA')).toBeLessThan(u1.indexOf('BBB'));

        llmRun.mockClear();
        repo.findByOrganizationId.mockResolvedValue({
            rules: [existingMemory('BBB'), existingMemory('AAA')],
        });
        await resolve(genMemory());
        const u2 = llmRun.mock.calls[0][0].user as string;
        expect(u2.indexOf('BBB')).toBeLessThan(u2.indexOf('AAA'));
    });

    // ============================ E. provider / model matrix ===============
    it('E — schema + prompts identical across a strict-branch and a fallback-branch slot (policy delegated)', async () => {
        llmRun.mockResolvedValue({ action: 'create' });

        permission.resolveTaskSlot.mockResolvedValue({ provider: 'anthropic' });
        await resolve(genMemory());

        permission.resolveTaskSlot.mockResolvedValue({ provider: 'z-ai' });
        await resolve(genMemory());

        const [strict, fallback] = llmRun.mock.calls;
        expect(strict[0].schema).toBe(kodyMemoryResolutionSchema);
        expect(fallback[0].schema).toBe(kodyMemoryResolutionSchema);
        expect(strict[0].system).toBe(fallback[0].system);
    });

    // ---- declared-shape invariant -----------------------------------------
    it('invariant — always resolves to a resolution object with .action (or null on short-circuit)', async () => {
        for (const v of [
            { action: 'skip', targetMemoryUuid: 'm1' },
            {},
            null,
            'nonsense',
            [],
            42,
        ]) {
            llmRun.mockResolvedValueOnce(v as any);
            const res = await resolve(genMemory());
            expect(res).not.toBeNull();
            expect(typeof res.action).toBe('string');
        }
        llmRun.mockRejectedValueOnce(new Error('boom'));
        expect((await resolve(genMemory())).action).toBe('create');
    });
});
