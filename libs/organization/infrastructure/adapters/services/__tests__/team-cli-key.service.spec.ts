import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

import { TeamCliKeyEntity } from '@libs/organization/domain/team-cli-key/entities/team-cli-key.entity';
import { TeamCliKeyService } from '../team-cli-key.service';

describe('TeamCliKeyService', () => {
    let service: TeamCliKeyService;
    let repository: {
        create: jest.Mock;
        update: jest.Mock;
    };

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
        };

        service = new TeamCliKeyService(repository as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('stores default config when generating a CLI key without explicit config', async () => {
        jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('seed'));
        jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashed-secret' as never);
        repository.create.mockResolvedValue(
            TeamCliKeyEntity.create({
                uuid: 'key-1',
                name: 'CI Key',
                keyHash: 'hashed-secret',
                active: true,
                config: {
                    capabilities: [],
                },
                team: { uuid: 'team-1' },
                createdBy: { uuid: 'user-1' },
            }),
        );

        await service.generateKey('team-1', 'CI Key', 'user-1');

        expect(repository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'CI Key',
                active: true,
                config: {
                    capabilities: [],
                },
                team: { uuid: 'team-1' },
                createdBy: { uuid: 'user-1' },
            }),
        );
    });

    it('preserves the existing config when a partial update does not provide config', async () => {
        repository.update.mockResolvedValue(
            TeamCliKeyEntity.create({
                uuid: 'key-1',
                name: 'Updated Key',
                keyHash: 'hashed-secret',
                active: true,
                config: {
                    capabilities: ['config:repo:manage'],
                },
                team: { uuid: 'team-1' },
                createdBy: { uuid: 'user-1' },
            }),
        );

        await service.update(
            { uuid: 'key-1' },
            {
                name: 'Updated Key',
            },
        );

        const [, updatePayload] = repository.update.mock.calls[0];

        expect(repository.update).toHaveBeenCalledWith(
            { uuid: 'key-1' },
            expect.objectContaining({
                name: 'Updated Key',
            }),
        );
        expect(updatePayload).not.toHaveProperty('config');
    });
});
