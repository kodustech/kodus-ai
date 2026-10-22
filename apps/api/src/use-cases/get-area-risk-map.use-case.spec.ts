import { ForbiddenException } from '@nestjs/common';
import { GetAreaRiskMapUseCase } from './get-area-risk-map.use-case';

describe('GetAreaRiskMapUseCase', () => {
    it('denies history before reading the map when access is unavailable', async () => {
        const access = { isEnabled: jest.fn().mockResolvedValue(false) };
        const maps = { read: jest.fn() };
        const refresh = { readStatus: jest.fn() };
        const useCase = new GetAreaRiskMapUseCase(
            access as never,
            maps as never,
            refresh as never,
        );

        await expect(
            useCase.execute({
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(maps.read).not.toHaveBeenCalled();
        expect(refresh.readStatus).not.toHaveBeenCalled();
    });
});
