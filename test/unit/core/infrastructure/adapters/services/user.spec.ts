import { STATUS } from "@/config/types/database/status.type";
import { AUTH_SERVICE_TOKEN } from "@/core/domain/auth/contracts/auth.service.contracts";
import { IProfileRepository, PROFILE_REPOSITORY_TOKEN } from "@/core/domain/profile/contracts/profile.repository.contract";
import { ITeamRepository, TEAM_REPOSITORY_TOKEN } from "@/core/domain/team/contracts/team.repository.contract";
import { IUserRepository, USER_REPOSITORY_TOKEN } from "@/core/domain/user/contracts/user.repository.contract";
import { UserRole } from "@/core/domain/user/enums/userRole.enum";
import { ProfilesService } from "@/core/infrastructure/adapters/services/profile.service";
import { TeamService } from "@/core/infrastructure/adapters/services/team.service";
import { UsersService } from "@/core/infrastructure/adapters/services/users.service"
import { Test, TestingModule } from "@nestjs/testing";

import { v4 as uuidv4 } from 'uuid';

describe("User SignUp", () => {
    let usersService: UsersService;
    let usersRepository: IUserRepository;

    let profileService: ProfilesService;
    let profileRepository: IProfileRepository;

    let teamService: TeamService;
    let teamRepository: ITeamRepository;

    const mockUsersRepository = {
        findOne: jest.fn(),
        create: jest.fn(),
        register: jest.fn(),
    }

    const mockAuthService = {
        hashPassword: jest.fn()
    }

    const mockProfileRepository = {
        findOne: jest.fn(),
        create: jest.fn(),
        updateByUserId: jest.fn()
    }

    const mockTeamRepository = {
        create: jest.fn()
    }


    beforeEach(async () => {
        const userModule: TestingModule = await Test.createTestingModule({
            providers: [
                UsersService,
                {
                    provide: AUTH_SERVICE_TOKEN,
                    useValue: mockAuthService,
                },
                {
                    provide: USER_REPOSITORY_TOKEN,
                    useValue: mockUsersRepository
                },

            ]
        }).compile();

        const profileModule: TestingModule = await Test.createTestingModule({
            providers: [
                ProfilesService,
                {
                    provide: PROFILE_REPOSITORY_TOKEN,
                    useValue: mockProfileRepository
                },

            ]
        }).compile();

        const teamModule: TestingModule = await Test.createTestingModule({
            providers: [
                TeamService,
                {
                    provide: TEAM_REPOSITORY_TOKEN,
                    useValue: mockTeamRepository
                },

            ]
        }).compile();

        usersService = userModule.get<UsersService>(UsersService);
        usersRepository = userModule.get<IUserRepository>(USER_REPOSITORY_TOKEN);

        profileService = profileModule.get<ProfilesService>(ProfilesService);
        profileRepository = profileModule.get<IProfileRepository>(PROFILE_REPOSITORY_TOKEN);

        teamService = teamModule.get<TeamService>(TeamService);
        teamRepository = teamModule.get<ITeamRepository>(TEAM_REPOSITORY_TOKEN);

    });

    afterEach(() => {
        jest.clearAllMocks();
    })

    const TEAM_NAME = "team name valid";
    const EMPLOYEE_NAME = "john doe";
    const EMAIL = "john.doe@organization.io";
    const PASSWORD = "SecurePassword@123";

    it('should be able to register a new user', async () => {
        const mockParams: any = {
            email: EMAIL,
            password: PASSWORD,
            role: [UserRole.OWNER],
            status: STATUS.ACTIVE,
            organization: { uuid: "orgId" }
        };

        (usersRepository.create as jest.Mock).mockResolvedValue({ uuid: uuidv4(), ...mockParams });

        const registeredUser = await usersService.register(mockParams);

        expect(registeredUser).toBeDefined();
    });

    it('should be able to register a new profile and team name when creating a user', async () => {
        const mockCreateUserParams: any = {
            email: EMAIL,
            password: PASSWORD,
            role: [UserRole.OWNER],
            status: STATUS.ACTIVE,
            organization: { uuid: "orgId" }
        };

        (usersRepository.create as jest.Mock).mockResolvedValue({ uuid: uuidv4(), ...mockCreateUserParams });

        const registeredUser = await usersService.register(mockCreateUserParams);

        const mockCreateProfileParams = {
            user: { uuid: registeredUser.uuid }
        };

        profileService.updateByUserId = jest.fn().mockResolvedValue(mockCreateProfileParams);

        await profileService.updateByUserId(registeredUser.uuid, {
            name: EMPLOYEE_NAME,
            status: true,
            user: {
                uuid: registeredUser.uuid
            }
        });

        const mockCreateTeam = {
            teamName: TEAM_NAME,
            organizationId: registeredUser.organization.uuid
        };

        teamService.createTeam = jest.fn().mockResolvedValue(mockCreateTeam);

        const createdTeam = await teamService.createTeam(mockCreateTeam);

        expect(profileService.updateByUserId).toHaveBeenCalled();
        expect(profileService.updateByUserId).toHaveBeenCalledWith(registeredUser.uuid, {
            name: EMPLOYEE_NAME,
            status: true,
            user: {
                uuid: registeredUser.uuid
            }
        });

        expect(createdTeam).toBeDefined();
    });


})
