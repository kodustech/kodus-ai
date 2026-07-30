import { Test, TestingModule } from '@nestjs/testing';

import { SaveMarketingSurveyUseCase } from '@libs/identity/application/use-cases/profile/save-marketing-survey.use-case';
import { PROFILE_SERVICE_TOKEN } from '@libs/identity/domain/profile/contracts/profile.service.contract';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const mockProfileService = {
    update: jest.fn(),
};

describe('SaveMarketingSurveyUseCase', () => {
    let useCase: SaveMarketingSurveyUseCase;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SaveMarketingSurveyUseCase,
                {
                    provide: PROFILE_SERVICE_TOKEN,
                    useValue: mockProfileService,
                },
            ],
        }).compile();

        useCase = module.get<SaveMarketingSurveyUseCase>(
            SaveMarketingSurveyUseCase,
        );

        jest.clearAllMocks();
    });

    it('should call profileService.update with the correct filter and data', async () => {
        const userId = 'user-uuid-123';
        mockProfileService.update.mockResolvedValue(undefined);

        await useCase.execute(userId, {
            referralSource: 'search',
            primaryGoal: 'speed',
        });

        expect(mockProfileService.update).toHaveBeenCalledTimes(1);
        expect(mockProfileService.update).toHaveBeenCalledWith(
            { user: { uuid: userId } },
            { referralSource: 'search', primaryGoal: 'speed' },
        );
    });

    it('should persist only referralSource when only it is provided', async () => {
        const userId = 'user-uuid-123';
        mockProfileService.update.mockResolvedValue(undefined);

        await useCase.execute(userId, { referralSource: 'social' });

        expect(mockProfileService.update).toHaveBeenCalledWith(
            { user: { uuid: userId } },
            { referralSource: 'social' },
        );
    });

    it('should persist only primaryGoal when only it is provided', async () => {
        const userId = 'user-uuid-123';
        mockProfileService.update.mockResolvedValue(undefined);

        await useCase.execute(userId, { primaryGoal: 'quality' });

        expect(mockProfileService.update).toHaveBeenCalledWith(
            { user: { uuid: userId } },
            { primaryGoal: 'quality' },
        );
    });

    it('should skip update when neither field is provided', async () => {
        const userId = 'user-uuid-123';
        mockProfileService.update.mockResolvedValue(undefined);

        await useCase.execute(userId, {});

        expect(mockProfileService.update).not.toHaveBeenCalled();
    });

    it('should propagate error when profileService.update throws', async () => {
        const userId = 'user-uuid-123';
        mockProfileService.update.mockRejectedValue(new Error('DB error'));

        await expect(
            useCase.execute(userId, { referralSource: 'search' }),
        ).rejects.toThrow('DB error');
    });
});
