import type { Repository } from 'typeorm';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersRepository } from './organizationParameters.repository';
import { OrganizationParametersModel } from './schemas/organizationParameters.model';

describe('OrganizationParametersRepository.compareAndSwapConfigValue', () => {
    it('updates only when uuid and the complete expected JSON value still match', async () => {
        const expected = { version: 2, credentials: [{ id: 'credential-id' }] };
        const replacement = {
            version: 2,
            credentials: [{ id: 'credential-id', rotated: true }],
        };
        const execute = jest.fn().mockResolvedValue({ affected: 1 });
        const queryBuilder = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute,
        };
        const typeormRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };
        const repository = new OrganizationParametersRepository(
            typeormRepository as unknown as Repository<OrganizationParametersModel>,
        );

        await expect(
            repository.compareAndSwapConfigValue(
                'parameter-id',
                expected,
                replacement,
            ),
        ).resolves.toBe(true);

        expect(queryBuilder.update).toHaveBeenCalledWith(
            OrganizationParametersModel,
        );
        expect(queryBuilder.set).toHaveBeenCalledWith({
            configValue: replacement,
        });
        expect(queryBuilder.where).toHaveBeenCalledWith('"uuid" = :uuid', {
            uuid: 'parameter-id',
        });
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            '"configValue" = :expected::jsonb',
            { expected: JSON.stringify(expected) },
        );
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('reports a lost comparison when no row was updated', async () => {
        const queryBuilder = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 0 }),
        };
        const repository = new OrganizationParametersRepository({
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as unknown as Repository<OrganizationParametersModel>);

        await expect(
            repository.compareAndSwapConfigValue('parameter-id', {}, {}),
        ).resolves.toBe(false);
    });
});

describe('OrganizationParametersRepository.findByKeyAndValue', () => {
    it('propagates query failures to the token-rotation retry path', async () => {
        const failure = new Error('database unavailable');
        const queryBuilder = {
            leftJoinAndSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockRejectedValue(failure),
        };
        const repository = new OrganizationParametersRepository({
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as unknown as Repository<OrganizationParametersModel>);

        await expect(
            repository.findByKeyAndValue({
                configKey: OrganizationParametersKey.BYOK_CONFIG,
                configValue: { version: 2 },
                fuzzy: true,
            }),
        ).rejects.toBe(failure);
    });
});
