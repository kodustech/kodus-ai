import { BadRequestException, NotFoundException } from '@nestjs/common';

import { UpdateConnectionUseCase } from '../update-connection.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (exists = true) => {
    const integrationService = {
        findOne: jest
            .fn()
            .mockResolvedValue(exists ? { uuid: 'conn-1' } : undefined),
        update: jest.fn().mockResolvedValue(undefined),
    };
    const useCase = new UpdateConnectionUseCase(
        integrationService as any,
        { user: { uuid: 'user-1', organization: { uuid: ORG } } } as any,
    );
    return { useCase, integrationService };
};

describe('UpdateConnectionUseCase', () => {
    it('renames a connection and turns its reviews off', async () => {
        const { useCase, integrationService } = build();

        await useCase.execute({
            teamId: TEAM,
            connectionId: 'conn-1',
            name: '  Clients  ',
            reviewEnabled: false,
        });

        expect(integrationService.update).toHaveBeenCalledWith(
            {
                uuid: 'conn-1',
                organization: { uuid: ORG },
                team: { uuid: TEAM },
            },
            { name: 'Clients', reviewEnabled: false },
        );
    });

    it('clears the name when given an empty one', async () => {
        const { useCase, integrationService } = build();

        await useCase.execute({
            teamId: TEAM,
            connectionId: 'conn-1',
            name: ' ',
        });

        expect(integrationService.update).toHaveBeenCalledWith(
            expect.anything(),
            { name: null },
        );
    });

    it('refuses a connection outside the caller’s organization or workspace', async () => {
        const { useCase, integrationService } = build(false);

        await expect(
            useCase.execute({
                teamId: TEAM,
                connectionId: 'elsewhere',
                reviewEnabled: true,
            }),
        ).rejects.toThrow(NotFoundException);
        expect(integrationService.update).not.toHaveBeenCalled();
    });

    it('refuses an update that changes nothing', async () => {
        const { useCase } = build();

        await expect(
            useCase.execute({ teamId: TEAM, connectionId: 'conn-1' }),
        ).rejects.toThrow(BadRequestException);
    });
});
