import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { JoinOrganizationUseCase } from '@libs/organization/application/use-cases/onboarding/join-organization.use-case';
import { environment } from '@libs/ee/configs/environment';

jest.mock('@libs/ee/configs/environment', () => ({
    environment: {
        API_CLOUD_MODE: false,
        API_DEVELOPMENT_MODE: false,
    },
}));

describe('JoinOrganizationUseCase', () => {
    let originalCloudMode: boolean;

    const createDeps = () => {
        const userService = {
            findOne: jest.fn(),
            update: jest.fn(),
            find: jest.fn(),
        };
        const organizationService = {
            findOne: jest.fn(),
            deleteOne: jest.fn(),
        };
        const teamService = {
            findOne: jest.fn(),
            find: jest.fn(),
            deleteFisically: jest.fn(),
        };
        const teamMembersService = {
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            findManyByRelations: jest.fn(),
        };
        const profileService = {
            findOne: jest.fn(),
        };
        const authService = {
            createEmailToken: jest.fn(),
        };
        const parametersService = {
            deleteByTeamId: jest.fn(),
        };
        const notificationService = {
            emit: jest.fn(),
        };

        return {
            userService,
            organizationService,
            teamService,
            teamMembersService,
            profileService,
            authService,
            parametersService,
            notificationService,
        };
    };

    const setupDefaultFlow = (deps: ReturnType<typeof createDeps>) => {
        const user = {
            uuid: 'user-1',
            email: 'dev@kodus.io',
            organization: { uuid: 'org-old' },
        };
        const organization = {
            uuid: 'org-new',
            name: 'Kodus Org',
        };
        const team = { uuid: 'team-1' };

        deps.userService.findOne.mockResolvedValue(user);
        deps.profileService.findOne.mockResolvedValue({ name: 'Dev User' });
        deps.organizationService.findOne.mockResolvedValue(organization);
        deps.teamService.findOne.mockResolvedValue(team);
        deps.teamMembersService.findOne.mockResolvedValue(null);
        deps.teamMembersService.create.mockResolvedValue({ uuid: 'tm-1' });
        deps.userService.find.mockResolvedValue([{}]);
        deps.teamService.find.mockResolvedValue([]);

        return { user, organization, team };
    };

    beforeEach(() => {
        jest.clearAllMocks();
        originalCloudMode = environment.API_CLOUD_MODE;
    });

    afterEach(() => {
        environment.API_CLOUD_MODE = originalCloudMode;
    });

    it('should set user as ACTIVE and skip confirmation email in self-hosted mode', async () => {
        environment.API_CLOUD_MODE = false;

        const deps = createDeps();
        const { organization } = setupDefaultFlow(deps);
        deps.userService.update.mockResolvedValue({
            status: STATUS.ACTIVE,
            toObject: () => ({ status: STATUS.ACTIVE }),
        });

        const useCase = new JoinOrganizationUseCase(
            deps.userService as any,
            deps.organizationService as any,
            deps.teamService as any,
            deps.teamMembersService as any,
            deps.profileService as any,
            deps.authService as any,
            deps.parametersService as any,
            deps.notificationService as any,
        );
        jest.spyOn(useCase, 'cleanUp').mockResolvedValue(undefined);

        const result = await useCase.execute({
            userId: 'user-1',
            organizationId: 'org-new',
        });

        expect(deps.userService.update).toHaveBeenCalledWith(
            { uuid: 'user-1' },
            {
                role: expect.any(String),
                status: STATUS.ACTIVE,
                organization,
            },
        );
        expect(deps.authService.createEmailToken).not.toHaveBeenCalled();
        expect(deps.notificationService.emit).not.toHaveBeenCalled();
        expect(result).toEqual({ status: STATUS.ACTIVE });
    });

    it('should set user as PENDING_EMAIL and send confirmation email in cloud mode', async () => {
        environment.API_CLOUD_MODE = true;

        const deps = createDeps();
        const { organization, team } = setupDefaultFlow(deps);
        deps.authService.createEmailToken.mockResolvedValue('email-token');
        deps.userService.update.mockResolvedValue({
            status: STATUS.PENDING_EMAIL,
            toObject: () => ({ status: STATUS.PENDING_EMAIL }),
        });

        const useCase = new JoinOrganizationUseCase(
            deps.userService as any,
            deps.organizationService as any,
            deps.teamService as any,
            deps.teamMembersService as any,
            deps.profileService as any,
            deps.authService as any,
            deps.parametersService as any,
            deps.notificationService as any,
        );
        jest.spyOn(useCase, 'cleanUp').mockResolvedValue(undefined);

        const result = await useCase.execute({
            userId: 'user-1',
            organizationId: 'org-new',
        });

        expect(deps.userService.update).toHaveBeenCalledWith(
            { uuid: 'user-1' },
            {
                role: expect.any(String),
                status: STATUS.PENDING_EMAIL,
                organization,
            },
        );
        expect(deps.authService.createEmailToken).toHaveBeenCalledWith(
            'user-1',
            'dev@kodus.io',
        );
        expect(deps.notificationService.emit).toHaveBeenCalledWith({
            event: 'auth.email_confirmation',
            payload: {
                token: 'email-token',
                email: 'dev@kodus.io',
                organizationName: 'Kodus Org',
                organizationAndTeamData: {
                    organizationId: 'org-new',
                    teamId: team.uuid,
                },
            },
            organizationId: 'org-new',
            recipients: { kind: 'user', userId: 'user-1' },
        });
        expect(result).toEqual({ status: STATUS.PENDING_EMAIL });
    });
});
