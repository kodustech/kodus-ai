import { AutoAssignLicenseUseCase } from './auto-assign-license.use-case';

// Covers every decision branch of the auto-assign gate. This is the logic that
// decides whether an unlicensed PR author's review proceeds on self-hosted:
// with the org default `auto_license_assignment.enabled=false` it returns
// AUTO_ASSIGN_DISABLED, which is why a seat must be assigned explicitly (the
// freebie/auto-assign paths only exist once the feature is turned on).
describe('AutoAssignLicenseUseCase', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const base = {
        organizationAndTeamData: orgTeam,
        userGitId: '5993570',
        prNumber: 1,
        prCount: 1,
        repositoryName: 'tiny-url',
        provider: 'github',
    };

    const make = (cfg: {
        config?: unknown;
        licensedUsers?: Array<{ git_id: string }>;
        assignResult?: boolean;
    }) => {
        const organizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(cfg.config ?? null),
        };
        const licenseService = {
            getAllUsersWithLicense: jest
                .fn()
                .mockResolvedValue(cfg.licensedUsers ?? []),
            assignLicense: jest
                .fn()
                .mockResolvedValue(cfg.assignResult ?? true),
        };
        return {
            uc: new AutoAssignLicenseUseCase(
                organizationParametersService as any,
                licenseService as any,
            ),
            licenseService,
        };
    };

    const enabled = (extra: Record<string, unknown> = {}) => ({
        configValue: {
            enabled: true,
            allowedUsers: [],
            ignoredUsers: [],
            ...extra,
        },
    });

    it('AUTO_ASSIGN_DISABLED when the org param is absent', async () => {
        const { uc, licenseService } = make({ config: null });

        const res = await uc.execute(base);

        expect(res).toEqual({
            shouldProceed: false,
            reason: 'AUTO_ASSIGN_DISABLED',
        });
        expect(licenseService.assignLicense).not.toHaveBeenCalled();
    });

    it('AUTO_ASSIGN_DISABLED when enabled=false (the seed default)', async () => {
        const { uc } = make({ config: { configValue: { enabled: false } } });

        const res = await uc.execute(base);

        expect(res.reason).toBe('AUTO_ASSIGN_DISABLED');
    });

    it('NOT_ALLOWED_USER when allowedUsers excludes the author', async () => {
        const { uc } = make({ config: enabled({ allowedUsers: ['other-user'] }) });

        const res = await uc.execute(base);

        expect(res).toEqual({
            shouldProceed: false,
            reason: 'NOT_ALLOWED_USER',
        });
    });

    it('ALREADY_LICENSED short-circuits to proceed without re-assigning', async () => {
        const { uc, licenseService } = make({
            config: enabled(),
            licensedUsers: [{ git_id: '5993570' }],
        });

        const res = await uc.execute(base);

        expect(res).toEqual({ shouldProceed: true, reason: 'ALREADY_LICENSED' });
        expect(licenseService.assignLicense).not.toHaveBeenCalled();
    });

    it('IGNORED_USER blocks an unlicensed author on the ignore list', async () => {
        const { uc } = make({ config: enabled({ ignoredUsers: ['5993570'] }) });

        const res = await uc.execute(base);

        expect(res).toEqual({ shouldProceed: false, reason: 'IGNORED_USER' });
    });

    it('FREEBIE: first PR (prCount<=1) proceeds without consuming a seat', async () => {
        const { uc, licenseService } = make({ config: enabled() });

        const res = await uc.execute({ ...base, prCount: 1 });

        expect(res).toEqual({ shouldProceed: true, reason: 'FREEBIE' });
        expect(licenseService.assignLicense).not.toHaveBeenCalled();
    });

    it('ASSIGNED: 2nd+ PR assigns a seat and proceeds', async () => {
        const { uc, licenseService } = make({
            config: enabled(),
            assignResult: true,
        });

        const res = await uc.execute({ ...base, prCount: 2 });

        expect(res).toEqual({ shouldProceed: true, reason: 'ASSIGNED' });
        expect(licenseService.assignLicense).toHaveBeenCalledWith(
            orgTeam,
            '5993570',
            'github',
        );
    });

    it('ASSIGNMENT_FAILED: 2nd+ PR but the seat limit is reached → blocked', async () => {
        const { uc } = make({ config: enabled(), assignResult: false });

        const res = await uc.execute({ ...base, prCount: 2 });

        expect(res).toEqual({
            shouldProceed: false,
            reason: 'ASSIGNMENT_FAILED',
        });
    });

    it('ASSIGNMENT_FAILED (fail-closed) when the flow throws', async () => {
        const organizationParametersService = {
            findByKey: jest.fn().mockRejectedValue(new Error('db down')),
        };
        const licenseService = {
            getAllUsersWithLicense: jest.fn(),
            assignLicense: jest.fn(),
        };
        const uc = new AutoAssignLicenseUseCase(
            organizationParametersService as any,
            licenseService as any,
        );

        const res = await uc.execute(base);

        expect(res).toEqual({
            shouldProceed: false,
            reason: 'ASSIGNMENT_FAILED',
        });
    });
});
