import { Test, TestingModule } from '@nestjs/testing';

import { LICENSE_SERVICE_TOKEN } from '@libs/ee/license/interfaces/license.interface';
import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { PruneRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/prune-removed-license-seats.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('PruneRemovedLicenseSeatsUseCase', () => {
    let useCase: PruneRemovedLicenseSeatsUseCase;
    let mockMemberListService: { fetch: jest.Mock };
    let mockLicenseService: {
        getAllUsersWithLicense: jest.Mock;
        unassignLicenses: jest.Mock;
    };
    let mockCodeManagementService: { getTypeIntegration: jest.Mock };
    let mockOrganizationParametersService: { findByKey: jest.Mock };

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    beforeEach(async () => {
        mockMemberListService = {
            fetch: jest.fn().mockResolvedValue({
                status: 'ok',
                members: [
                    { id: 'still-here', name: 'Still Here' },
                    { id: 42, name: 'Numeric Id' },
                ],
            }),
        };

        mockLicenseService = {
            getAllUsersWithLicense: jest.fn().mockResolvedValue([
                { git_id: 'still-here' },
                { git_id: 'left-the-company' },
            ]),
            unassignLicenses: jest
                .fn()
                .mockImplementation((_org, gitIds) =>
                    Promise.resolve({ revoked: [...gitIds], failed: [] }),
                ),
        };

        mockCodeManagementService = {
            getTypeIntegration: jest.fn().mockResolvedValue('github'),
        };

        mockOrganizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PruneRemovedLicenseSeatsUseCase,
                {
                    provide: OrganizationMemberListService,
                    useValue: mockMemberListService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: mockLicenseService,
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: mockOrganizationParametersService,
                },
            ],
        }).compile();

        useCase = module.get(PruneRemovedLicenseSeatsUseCase);
    });

    describe('safety when the member list cannot be confirmed', () => {
        it('revokes nothing and reports the member list as unavailable', async () => {
            mockMemberListService.fetch.mockResolvedValue({
                status: 'unavailable',
                members: [],
            });

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result).toEqual({
                status: 'members_unavailable',
                candidates: [],
                revoked: [],
                failed: [],
            });
            expect(mockLicenseService.unassignLicenses).not.toHaveBeenCalled();
        });
    });

    describe('preview', () => {
        it('lists seats held by users missing from the org without revoking', async () => {
            const result = await useCase.execute({
                organizationAndTeamData,
                dryRun: true,
            });

            expect(result).toEqual({
                status: 'ok',
                candidates: ['left-the-company'],
                revoked: [],
                failed: [],
            });
            expect(mockLicenseService.unassignLicenses).not.toHaveBeenCalled();
        });

        it('compares ids as strings so numeric provider ids still match', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: '42' },
            ]);

            const result = await useCase.execute({
                organizationAndTeamData,
                dryRun: true,
            });

            expect(result.candidates).toEqual([]);
        });
    });

    describe('revoking', () => {
        it('releases every seat whose holder is no longer in the org', async () => {
            const result = await useCase.execute({ organizationAndTeamData });

            expect(result).toEqual({
                status: 'ok',
                candidates: ['left-the-company'],
                revoked: ['left-the-company'],
                failed: [],
            });
            expect(mockLicenseService.unassignLicenses).toHaveBeenCalledTimes(1);
            // The provider must reach the billing service, which 400s a user
            // entry without a gitTool.
            expect(mockLicenseService.unassignLicenses).toHaveBeenCalledWith(
                organizationAndTeamData,
                ['left-the-company'],
                'github',
            );
        });

        // Every stale seat goes out in ONE call. Revoking them one at a time
        // concurrently loses updates in both seat stores.
        it('batches all stale seats into a single revoke call', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'gone-a' },
                { git_id: 'gone-b' },
                { git_id: 'gone-c' },
            ]);

            await useCase.execute({ organizationAndTeamData });

            expect(mockLicenseService.unassignLicenses).toHaveBeenCalledTimes(1);
            expect(mockLicenseService.unassignLicenses).toHaveBeenCalledWith(
                organizationAndTeamData,
                ['gone-a', 'gone-b', 'gone-c'],
                'github',
            );
        });

        it('reports partially failed revokes separately', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'gone-a' },
                { git_id: 'gone-b' },
                { git_id: 'gone-c' },
            ]);
            mockLicenseService.unassignLicenses.mockResolvedValue({
                revoked: ['gone-c'],
                failed: ['gone-a', 'gone-b'],
            });

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.revoked).toEqual(['gone-c']);
            expect(result.failed).toEqual(['gone-a', 'gone-b']);
        });

        it('does nothing when every seat holder is still in the org', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'still-here' },
            ]);

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.candidates).toEqual([]);
            expect(mockLicenseService.unassignLicenses).not.toHaveBeenCalled();
        });

        it('restricts revocation to an explicit git id list when given', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'gone-a' },
                { git_id: 'gone-b' },
            ]);

            const result = await useCase.execute({
                organizationAndTeamData,
                gitIds: ['gone-b'],
            });

            expect(result.revoked).toEqual(['gone-b']);
            expect(mockLicenseService.unassignLicenses).toHaveBeenCalledTimes(1);
        });

        it('ignores requested git ids that are still org members', async () => {
            const result = await useCase.execute({
                organizationAndTeamData,
                gitIds: ['still-here'],
            });

            expect(result.candidates).toEqual([]);
            expect(mockLicenseService.unassignLicenses).not.toHaveBeenCalled();
        });
    });

    // An app or bot is not enumerable through any provider's member listing —
    // GitHub's orgs.listMembers never returns apps at all, and the pull
    // request author fallback only reaches back 60 days. Its absence is
    // therefore never evidence that it "left the organization", so revoking
    // its seat would silently break reviews for an idle agent.
    describe('seats held by bots', () => {
        it('never proposes a bot seat for revocation when the bot is a known bot id', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'still-here' },
                { git_id: 'quiet-bot' },
            ]);
            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { seededBotIds: ['quiet-bot'] },
            });

            const result = await useCase.execute({
                organizationAndTeamData,
                dryRun: true,
            });

            expect(result.candidates).toEqual([]);
        });

        it('never proposes a bot seat when the member list still reports it as a bot', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'active-bot' },
            ]);
            mockMemberListService.fetch.mockResolvedValue({
                status: 'ok',
                members: [{ id: 'active-bot', name: 'ci-agent', type: 'bot' }],
            });

            const result = await useCase.execute({
                organizationAndTeamData,
                dryRun: true,
            });

            expect(result.candidates).toEqual([]);
        });

        it('still revokes a human who left even when bots hold seats', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'quiet-bot' },
                { git_id: 'left-the-company' },
            ]);
            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { seededBotIds: ['quiet-bot'] },
            });

            const result = await useCase.execute({
                organizationAndTeamData,
                dryRun: true,
            });

            expect(result.candidates).toEqual(['left-the-company']);
        });

        it('does not revoke a bot seat when an explicit gitIds request names it', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'quiet-bot' },
            ]);
            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { seededBotIds: ['quiet-bot'] },
            });

            const result = await useCase.execute({
                organizationAndTeamData,
                gitIds: ['quiet-bot'],
            });

            expect(result.revoked).toEqual([]);
            expect(mockLicenseService.unassignLicenses).not.toHaveBeenCalled();
        });

        // A seat granted through "assign by git id" is, by definition, for an
        // identity the member list could not show. Treating its absence as
        // "left the organization" would revoke the seat that the escape hatch
        // was built to grant.
        it('never proposes a seat that was assigned manually by git id', async () => {
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: 'unlisted-agent' },
                { git_id: 'left-the-company' },
            ]);
            mockOrganizationParametersService.findByKey.mockResolvedValue({
                configValue: { manuallyAssignedIds: ['unlisted-agent'] },
            });

            const result = await useCase.execute({
                organizationAndTeamData,
                dryRun: true,
            });

            expect(result.candidates).toEqual(['left-the-company']);
        });
    });
});
