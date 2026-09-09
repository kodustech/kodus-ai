import '@libs/llm/providers'; // self-register provider modules (routing capability gate)
import {
    PermissionValidationService,
    ValidationErrorType,
} from './permissionValidation.service';

// Cloud mode: the prepaid-credit gate lives on the cloud branch (trial and
// paid). Self-hosted has no Kodus provider, so nothing to gate there.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true, API_DEVELOPMENT_MODE: false },
}));

/**
 * "Kodus as the provider": a review whose codeReview slot resolves to the
 * `kodus` provider is paid from the org's prepaid credits. The gate blocks
 * ONLY on a known non-positive balance — a missing number (older billing, a
 * transport hiccup) must never skip a paying customer's review; the metering
 * sweep bills it after the fact.
 */
describe('PermissionValidationService — Kodus credits gate', () => {
    const orgTeam = {
        organizationId: '7f5bc971-76c2-4586-a624-84a7a98c696c',
        teamId: 'team-1',
    } as any;

    const kodusConfig = {
        version: 2,
        credentials: [{ id: 'kd', provider: 'kodus' }],
        models: [
            { id: 'm1', credentialId: 'kd', model: 'anthropic/claude-sonnet-5' },
        ],
        routing: { mode: 'manual', defaultModelId: 'm1', taskOverrides: {} },
    };
    const ownKeyConfig = {
        version: 2,
        credentials: [{ id: 'c1', provider: 'anthropic', apiKey: 'enc' }],
        models: [{ id: 'm1', credentialId: 'c1', model: 'claude-sonnet-5' }],
        routing: { mode: 'manual', defaultModelId: 'm1', taskOverrides: {} },
    };

    const makeService = (
        validation: Record<string, unknown>,
        config: unknown = kodusConfig,
    ) => {
        const licenseService = {
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true, ...validation }),
            getAllUsersWithLicense: jest
                .fn()
                .mockResolvedValue([{ git_id: 'dev-1' }]),
        };
        const orgParams = {
            findByKey: jest.fn().mockResolvedValue({ configValue: config }),
        };
        return new PermissionValidationService(
            licenseService as any,
            orgParams as any,
        );
    };
    const CTX = 'ValidatePrerequisitesStage';

    it('PAID plan + kodus slot + balance ≤ 0 → CREDITS_EXHAUSTED', async () => {
        const svc = makeService({
            subscriptionStatus: 'active',
            planType: 'teams_byok',
            creditBalanceUsd: 0,
        });
        const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
        expect(res.allowed).toBe(false);
        expect(res.errorType).toBe(ValidationErrorType.CREDITS_EXHAUSTED);
        expect(res.metadata).toMatchObject({
            creditsExhausted: true,
            creditBalanceUsd: 0,
            model: 'anthropic/claude-sonnet-5',
        });
    });

    it('PAID plan + kodus slot + negative balance (overshoot) → CREDITS_EXHAUSTED', async () => {
        const svc = makeService({
            subscriptionStatus: 'active',
            planType: 'teams_byok',
            creditBalanceUsd: -0.42,
        });
        const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
        expect(res.errorType).toBe(ValidationErrorType.CREDITS_EXHAUSTED);
    });

    it('PAID plan + kodus slot + positive balance → allowed, slot carried', async () => {
        const svc = makeService({
            subscriptionStatus: 'active',
            planType: 'teams_byok',
            creditBalanceUsd: 12.5,
        });
        const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
        expect(res.allowed).toBe(true);
        expect(res.byokConfig?.provider).toBe('kodus');
    });

    it('kodus slot satisfies a *_byok plan (it IS bring-your-own for plan purposes)', async () => {
        const svc = makeService({
            subscriptionStatus: 'active',
            planType: 'free_byok',
            creditBalanceUsd: 3,
        });
        const res = await svc.validateExecutionPermissions(orgTeam, undefined, CTX);
        expect(res.allowed).toBe(true);
        expect(res.errorType).not.toBe(ValidationErrorType.BYOK_REQUIRED);
    });

    it('balance unknown (billing predates the ledger) → fail OPEN, review runs', async () => {
        const svc = makeService({
            subscriptionStatus: 'active',
            planType: 'teams_byok',
        });
        const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
        expect(res.allowed).toBe(true);
    });

    it("an org's OWN key is never gated on credits, even at zero balance", async () => {
        const svc = makeService(
            {
                subscriptionStatus: 'active',
                planType: 'teams_byok',
                creditBalanceUsd: 0,
            },
            ownKeyConfig,
        );
        const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
        expect(res.allowed).toBe(true);
        expect(res.byokConfig?.provider).toBe('anthropic');
    });

    describe('trial', () => {
        it('TRIAL + kodus slot + balance ≤ 0 → CREDITS_EXHAUSTED (not the trial-credit gate)', async () => {
            const svc = makeService({
                subscriptionStatus: 'trial',
                planType: 'teams_byok',
                trialReviewCreditsTotal: 5,
                trialReviewCreditsRemaining: 0, // would block on trial credits w/o BYOK
                creditBalanceUsd: 0,
            });
            const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
            expect(res.allowed).toBe(false);
            expect(res.errorType).toBe(ValidationErrorType.CREDITS_EXHAUSTED);
        });

        it('TRIAL + kodus slot + positive balance → allowed even with 0 trial credits left', async () => {
            const svc = makeService({
                subscriptionStatus: 'trial',
                planType: 'teams_byok',
                trialReviewCreditsTotal: 5,
                trialReviewCreditsRemaining: 0,
                creditBalanceUsd: 20,
            });
            const res = await svc.validateExecutionPermissions(orgTeam, 'dev-1', CTX);
            expect(res.allowed).toBe(true);
            expect(res.byokConfig?.provider).toBe('kodus');
        });
    });
});
