import '@libs/llm/providers'; // self-register provider modules (routing capability gate)
import {
    PermissionValidationService,
    ValidationErrorType,
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

    it('BYOK present + model unroutable + NOT trial → BYOK_REQUIRED (never managed)', async () => {
        const svc = makeService('active');
        const res = await svc.validateExecutionPermissions(orgTeam, undefined);
        expect(res.allowed).toBe(false);
        expect(res.errorType).toBe(ValidationErrorType.BYOK_REQUIRED);
        expect(res.metadata).toMatchObject({ byokModelUnresolvable: true });
    });

    it('BYOK present + model unroutable + TRIAL → allowed (Kodus foots managed credits)', async () => {
        const svc = makeService('trial');
        const res = await svc.validateExecutionPermissions(orgTeam, undefined);
        // The integrity gate exempts trial; the review proceeds (managed credits).
        expect(res.allowed).toBe(true);
    });
});
