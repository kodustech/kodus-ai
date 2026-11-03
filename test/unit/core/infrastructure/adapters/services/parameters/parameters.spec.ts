import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IParametersRepository,
    PARAMETERS_REPOSITORY_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.repository.contracts';
import { ParametersService } from '@/core/infrastructure/adapters/services/parameters.service';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

describe('ParametersService', () => {
    let parametersService: ParametersService;
    let parametersRepository: IParametersRepository;

    const mockParametersRepository = {
        find: jest.fn(),
        findOne: jest.fn(),
        findByOrganizationName: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findByKey: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ParametersService,
                {
                    provide: PARAMETERS_REPOSITORY_TOKEN,
                    useValue: mockParametersRepository,
                },
            ],
        }).compile();

        parametersService = module.get<ParametersService>(ParametersService);
        parametersRepository = module.get<IParametersRepository>(
            PARAMETERS_REPOSITORY_TOKEN,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const TEST_UUID = '1';
    const TEST_CONFIG_KEY = ParametersKey.CODE_REVIEW_CONFIG;
    const TEST_CONFIG_VALUE = 'value1';

    it('should create a new config if it does not exist', async () => {
        const organizationAndTeamData: OrganizationAndTeamData = {
            teamId: 'team1',
        };
        const parametersKey: ParametersKey = ParametersKey.CHECKIN_CONFIG;
        const configValue = 'someValue';

        // Simulating parameter not found.
        (parametersRepository.findOne as jest.Mock).mockResolvedValue(null);

        (parametersRepository.create as jest.Mock).mockResolvedValue({
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
            team: { uuid: 'team1' },
        });

        const result = await parametersService.createOrUpdateConfig(
            parametersKey,
            configValue,
            organizationAndTeamData,
        );
        expect(result).toHaveProperty('uuid');
        expect(parametersRepository.create).toHaveBeenCalled();
    });

    it('should update an existing config if it exists', async () => {
        const organizationAndTeamData: OrganizationAndTeamData = {
            teamId: 'team1',
        };
        const parametersKey: ParametersKey = ParametersKey.CHECKIN_CONFIG;
        const configValue = 'someValue';

        const existingParam = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
            team: { uuid: 'team1' },
        };

        // Simulating parameter found.
        (parametersRepository.findOne as jest.Mock).mockResolvedValue(
            existingParam,
        );

        (parametersRepository.update as jest.Mock).mockResolvedValue({
            ...existingParam,
            configValue,
        });

        const result = await parametersService.createOrUpdateConfig(
            parametersKey,
            configValue,
            organizationAndTeamData,
        );

        expect(result).toEqual(true);
        expect(parametersRepository.update).toHaveBeenCalled();
    });

    it('should throw BadRequestException when an error occurs', async () => {
        const organizationAndTeamData: OrganizationAndTeamData = {
            teamId: 'team1',
        };
        const parametersKey: ParametersKey = ParametersKey.CHECKIN_CONFIG;
        const configValue = 'someValue';

        (parametersRepository.findOne as jest.Mock).mockRejectedValue(
            new Error('Database error'),
        );

        await expect(
            parametersService.createOrUpdateConfig(
                parametersKey,
                configValue,
                organizationAndTeamData,
            ),
        ).rejects.toThrow(BadRequestException);
    });
});
