import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IParametersRepository,
    PARAMETERS_REPOSITORY_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.repository.contracts';
import { IParameters } from '@/core/domain/parameters/interfaces/parameters.interface';
import { ParametersService } from '@/core/infrastructure/adapters/services/parameters.service';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

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

    it('should be able to find parameters', async () => {
        const mockParams: IParameters[] = [
            {
                uuid: TEST_UUID,
                configKey: TEST_CONFIG_KEY,
                configValue: TEST_CONFIG_VALUE,
            },
        ];

        /*
        Using *.find.mockResolvedValue directly causes a typing error, so it is necessary to use
        casting to avoid this issue.
        */
        (parametersRepository.find as jest.Mock).mockResolvedValue(mockParams);

        const result = await parametersService.find();
        expect(result).toEqual(mockParams);
        expect(parametersRepository.find).toHaveBeenCalledWith(undefined);
    });

    it('should find one parameter', async () => {
        const mockParam: IParameters = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
        };

        (parametersRepository.findOne as jest.Mock).mockResolvedValue(
            mockParam,
        );

        const result = await parametersService.findOne({ uuid: TEST_UUID });
        expect(result).toEqual(mockParam);
        expect(parametersRepository.findOne).toHaveBeenCalledWith({
            uuid: TEST_UUID,
        });
    });

    it('should create a parameter', async () => {
        const mockParam: IParameters = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
            team: { uuid: 'team1' },
        };

        const createdParam: IParameters = { uuid: TEST_UUID, ...mockParam };

        (parametersRepository.create as jest.Mock).mockResolvedValue(
            createdParam,
        );

        const result = await parametersService.create(mockParam);
        expect(result).toEqual(createdParam);
        expect(parametersRepository.create).toHaveBeenCalledWith(mockParam);
    });

    it('should update a parameter', async () => {
        const mockParam: IParameters = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
        };

        const updatedParam: IParameters = { uuid: TEST_UUID, ...mockParam };

        (parametersRepository.update as jest.Mock).mockResolvedValue(
            updatedParam,
        );

        const result = await parametersService.update(
            { uuid: TEST_UUID },
            { configValue: 'newValue' },
        );
        expect(result).toEqual(updatedParam);
        expect(parametersRepository.update).toHaveBeenCalledWith(
            { uuid: TEST_UUID },
            { configValue: 'newValue' },
        );
    });

    it('should delete a parameter', async () => {
        (parametersRepository.delete as jest.Mock).mockResolvedValue(undefined);

        await parametersService.delete(TEST_UUID);
        expect(parametersRepository.delete).toHaveBeenCalledWith(TEST_UUID);
    });

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

    it('should find parameter by organization name', async () => {
        const mockParam: IParameters = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
        };
        (
            parametersRepository.findByOrganizationName as jest.Mock
        ).mockResolvedValue(mockParam);

        const result = await parametersService.findByOrganizationName('org1');
        expect(result).toEqual(mockParam);
        expect(
            parametersRepository.findByOrganizationName,
        ).toHaveBeenCalledWith('org1');
    });

    it('should find parameter by id', async () => {
        const mockParam: IParameters = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
        };
        (parametersRepository.findById as jest.Mock).mockResolvedValue(
            mockParam,
        );

        const result = await parametersService.findById(TEST_UUID);
        expect(result).toEqual(mockParam);
        expect(parametersRepository.findById).toHaveBeenCalledWith(TEST_UUID);
    });

    it('should find parameter by key', async () => {
        const mockParam: IParameters = {
            uuid: TEST_UUID,
            configKey: TEST_CONFIG_KEY,
            configValue: TEST_CONFIG_VALUE,
        };
        const organizationAndTeamData: OrganizationAndTeamData = {
            teamId: 'team1',
        };
        (parametersRepository.findByKey as jest.Mock).mockResolvedValue(
            mockParam,
        );

        const result = await parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
        expect(result).toEqual(mockParam);
        expect(parametersRepository.findByKey).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
    });
});
