import '@libs/llm/providers'; // self-register provider modules (routing capability gate)
import {
    PermissionValidationService,
    ValidationErrorType,
    PlanType,
} from './permissionValidation.service';

// `@libs/ee/configs/environment` is gitignored (copied from environment.dev.ts
// for local builds), so mock it. Pinning API_CLOUD_MODE=false +
// API_DEVELOPMENT_MODE=false routes validateExecutionPermissions through the
// self-hosted seat-enforcement path under test.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false, API_DEVELOPMENT_MODE: false },
}));

// Guards the exact gate that, when it regressed-by-omission (a valid license
// turned CE→licensed but no seat was assigned), silently skipped EVERY review
// on licensed self-hosted with a bare 👎. See permissionValidation.service.ts
// validateSelfHostedPermissions.
describe('PermissionValidationService — self-hosted seat enforcement', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const makeService = (license: {
        validateOrganizationLicense?: jest.Mock;
        getAllUsersWithLicense?: jest.Mock;
    }) => {
        const licenseService = {
            validateOrganizationLicense: jest.fn(),
            getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
            ...license,
        };
        const orgParams = { findByKey: jest.fn() };
        return {
            svc: new PermissionValidationService(
                licenseService as any,
                orgParams as any,
            ),
            licenseService,
        };
    };

    it('no/invalid license → Community Edition allows everything (no seat check)', async () => {
        const { svc, licenseService } = makeService({
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: false }),
        });

        const res = await svc.validateExecutionPermissions(orgTeam, '5993570');

        expect(res.allowed).toBe(true);
        expect(licenseService.getAllUsersWithLicense).not.toHaveBeenCalled();
    });

    it('licensed but no userGitId (system-triggered) → allowed', async () => {
        const { svc } = makeService({
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true }),
        });

        const res = await svc.validateExecutionPermissions(orgTeam, undefined);

        expect(res.allowed).toBe(true);
    });

    it('licensed + author has NO seat → denies with USER_NOT_LICENSED', async () => {
        const { svc } = makeService({
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true }),
            getAllUsersWithLicense: jest
                .fn()
                .mockResolvedValue([{ git_id: 'someone-else' }]),
        });

        const res = await svc.validateExecutionPermissions(orgTeam, '5993570');

        expect(res.allowed).toBe(false);
        expect(res.errorType).toBe(ValidationErrorType.USER_NOT_LICENSED);
    });

    it('licensed + author HAS a seat → allowed', async () => {
        const { svc } = makeService({
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true }),
            getAllUsersWithLicense: jest
                .fn()
                .mockResolvedValue([{ git_id: '5993570' }]),
        });

        const res = await svc.validateExecutionPermissions(orgTeam, '5993570');

        expect(res.allowed).toBe(true);
    });

    // Contract guard: the seat match is strict (`u.git_id === userGitId`).
    // The webhook handler stores the author as `sender.id.toString()` and the
    // /license/assign endpoint takes `gitId: string`, so both sides MUST be
    // strings. A numeric seat id silently fails to match — exactly the kind of
    // type drift that would re-break enforcement without anyone noticing.
    it('seat id type drift (number vs string) does NOT match → denied', async () => {
        const { svc } = makeService({
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true }),
            getAllUsersWithLicense: jest
                .fn()
                .mockResolvedValue([{ git_id: 5993570 as unknown as string }]),
        });

        const res = await svc.validateExecutionPermissions(orgTeam, '5993570');

        expect(res.allowed).toBe(false);
        expect(res.errorType).toBe(ValidationErrorType.USER_NOT_LICENSED);
    });
});

// A BYOK org whose configured model can't be routed (broken/incomplete credential)
// must NEVER silently fall to the managed default — it blocks (reusing
// BYOK_REQUIRED) so the user fixes the credential, EXCEPT during an active trial
// (Kodus foots the managed credits then). Enforced uniformly, before the dev/self-
// hosted branches. Regression for the "Bedrock configured but reviews ran on the
// managed DeepSeek, silently" incident.
describe('PermissionValidationService — BYOK model integrity (never silently managed)', () => {
    const orgTeam = {
        organizationId: '7f5bc971-76c2-4586-a624-84a7a98c696c', // must be a UUID
        teamId: 'team-1',
    } as any;

    // A stored BYOK config whose only model is an Amazon Bedrock model whose
    // credential carries NO auth material (no apiKey, no awsBearerToken, no IAM
    // pair) → the slot can't be built → resolveTaskSlot returns undefined.
    const brokenByokConfig = {
        version: 2,
        credentials: [
            {
                id: 'c1',
                provider: 'amazon_bedrock',
                settings: { awsRegion: 'us-east-1' }, // region only — no auth
            },
        ],
        models: [
            {
                id: 'm1',
                credentialId: 'c1',
                model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            },
        ],
        routing: { mode: 'manual', defaultModelId: 'm1', taskOverrides: {} },
    };

    const makeService = (subscriptionStatus: string) => {
        const licenseService = {
            validateOrganizationLicense: jest
                .fn()
                .mockResolvedValue({ valid: true, subscriptionStatus }),
            getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
        };
        const orgParams = {
            findByKey: jest
                .fn()
                .mockResolvedValue({ configValue: brokenByokConfig }),
        };
        return new PermissionValidationService(
            licenseService as any,
            orgParams as any,
        );
    };

    // The integrity gate is scoped to the code-review flow (its contextName), so
    // a broken codeReview credential never blocks the chat/issues callers that
    // route their own model. Exercise it as the review pipeline does.
    const REVIEW_CTX = 'ValidatePrerequisitesStage';

    it('BYOK present + model unroutable + NOT trial → BYOK_REQUIRED (never managed)', async () => {
        const svc = makeService('active');
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            REVIEW_CTX,
        );
        expect(res.allowed).toBe(false);
        expect(res.errorType).toBe(ValidationErrorType.BYOK_REQUIRED);
        expect(res.metadata).toMatchObject({ byokModelUnresolvable: true });
    });

    it('BYOK present + model unroutable + TRIAL → allowed (Kodus foots managed credits)', async () => {
        const svc = makeService('trial');
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            REVIEW_CTX,
        );
        // The integrity gate exempts trial; the review proceeds (managed credits).
        expect(res.allowed).toBe(true);
    });

    it('same broken BYOK from a NON-review caller (chat/issues) → NOT blocked (probe is review-scoped)', async () => {
        const svc = makeService('active');
        // A broken codeReview credential must not take down chat/issues, which
        // route their OWN task's model — the codeReview probe stays out of them.
        const res = await svc.validateExecutionPermissions(
            orgTeam,
            undefined,
            'ChatWithKodyFromGitUseCase',
        );
        expect(res.errorType).not.toBe(ValidationErrorType.BYOK_REQUIRED);
    });
});

/**
 * Plan-type gating — the pure decisions that route billing/access: which plans
 * must bring their own key (requiresBYOK) and which need per-seat validation
 * (requiresUserLicense), plus the string→PlanType classification they hang off.
 * A regression here silently reclassifies a customer's plan (e.g. lets a FREE
 * org run on Kodus-managed credits, or drops the seat check on a MANAGED plan),
 * so these are pinned against the actual keyword precedence, not just happy paths.
 */
describe('PermissionValidationService — plan-type gating (pure decisions)', () => {
    const svc = new PermissionValidationService({} as any, {} as any);
    const identify = (p?: string) => (svc as any).identifyPlanType(p);
    const requiresBYOK = (pt: PlanType | null) => (svc as any).requiresBYOK(pt);
    const requiresUserLicense = (pt: PlanType | null) =>
        (svc as any).requiresUserLicense(pt);

    describe('identifyPlanType', () => {
        it('returns null for missing / empty input', () => {
            expect(identify(undefined)).toBeNull();
            expect(identify('')).toBeNull();
        });

        it('matches the plan keyword case-insensitively, anywhere in the string', () => {
            expect(identify('FREE')).toBe(PlanType.FREE);
            expect(identify('kodus-byok-enterprise')).toBe(PlanType.BYOK);
            expect(identify('Managed Plan')).toBe(PlanType.MANAGED);
            expect(identify('trial-30d')).toBe(PlanType.TRIAL);
        });

        it('honors keyword PRECEDENCE — "free" wins over "trial" in "free-trial"', () => {
            // Both keywords are present; the "free" check runs first. If that order
            // ever changed, the plan would silently flip to TRIAL and stop
            // requiring BYOK — a billing regression with no error.
            expect(identify('free-trial')).toBe(PlanType.FREE);
        });

        it('returns null for an unrecognized plan (no keyword match)', () => {
            expect(identify('enterprise')).toBeNull();
            expect(identify('pro')).toBeNull();
        });
    });

    describe('requiresBYOK — only FREE and BYOK plans must bring their own key', () => {
        it('is true for FREE and BYOK', () => {
            expect(requiresBYOK(PlanType.FREE)).toBe(true);
            expect(requiresBYOK(PlanType.BYOK)).toBe(true);
        });

        it('is false for MANAGED, TRIAL, and unknown (managed credits allowed)', () => {
            expect(requiresBYOK(PlanType.MANAGED)).toBe(false);
            expect(requiresBYOK(PlanType.TRIAL)).toBe(false);
            expect(requiresBYOK(null)).toBe(false);
        });
    });

    describe('requiresUserLicense — only BYOK and MANAGED need per-seat validation', () => {
        it('is true for BYOK and MANAGED', () => {
            expect(requiresUserLicense(PlanType.BYOK)).toBe(true);
            expect(requiresUserLicense(PlanType.MANAGED)).toBe(true);
        });

        it('is false for FREE, TRIAL, and unknown', () => {
            expect(requiresUserLicense(PlanType.FREE)).toBe(false);
            expect(requiresUserLicense(PlanType.TRIAL)).toBe(false);
            expect(requiresUserLicense(null)).toBe(false);
        });
    });
});
