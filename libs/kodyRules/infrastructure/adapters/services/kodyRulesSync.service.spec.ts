import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

// Mock the LLM boundary: the WHOLE point of the post-trial gate is that it
// must NOT reach the (managed-model) LLM conversion when the trial has ended
// and the org has no BYOK. Asserting on this mock is how we prove the gate
// fired (never called) vs. let the request through (called).
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRulesSyncService } from './kodyRulesSync.service';

const mockRun = runStructuredReviewCall as jest.Mock;

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

    const makeService = (opts: {
        byok: boolean;
        status: SubscriptionStatus | undefined;
    }) => {
        const permissionValidationService = {
            validateBasicLicense: jest.fn().mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest
                .fn()
                .mockResolvedValue(opts.byok ? { main: { model: 'x' } } : null),
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
 * (BYOKPromptRunnerService.builder().execute()) path ONTO the AI SDK
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
            getBYOKConfig: jest
                .fn()
                .mockResolvedValue({ main: { model: 'x' } }),
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
