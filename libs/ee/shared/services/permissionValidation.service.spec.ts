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
