import { HttpException, HttpStatus } from '@nestjs/common';

import { TeamCliKeyController } from '../team-cli-key.controller';

describe('TeamCliKeyController', () => {
    let controller: TeamCliKeyController;
    let teamCliKeyService: {
        generateKey: jest.Mock;
        findByTeamId: jest.Mock;
        findById: jest.Mock;
        revokeKey: jest.Mock;
        update: jest.Mock;
    };
    let request: { user?: { uuid?: string } };
    let eventEmitter: { emit: jest.Mock };

    const cliKeyConfig = {
        capabilities: ['config:repo:manage'],
    };

    beforeEach(() => {
        teamCliKeyService = {
            generateKey: jest.fn().mockResolvedValue('kodus_secret'),
            findByTeamId: jest.fn().mockResolvedValue([
                {
                    uuid: 'key-1',
                    name: 'CI Key',
                    active: true,
                    lastUsedAt: new Date('2026-03-10T10:00:00.000Z'),
                    createdAt: new Date('2026-03-10T09:00:00.000Z'),
                    createdBy: {
                        uuid: 'user-1',
                        name: 'Wellington',
                        email: 'wellington@example.com',
                    },
                    config: cliKeyConfig,
                },
            ]),
            findById: jest.fn(),
            revokeKey: jest.fn().mockResolvedValue(undefined),
            update: jest.fn(),
        };

        request = {
            user: {
                uuid: 'user-1',
                email: 'wellington@example.com',
                organization: {
                    uuid: 'org-1',
                },
            },
        } as any;

        eventEmitter = {
            emit: jest.fn(),
        };

        controller = new TeamCliKeyController(
            teamCliKeyService as any,
            request as any,
            eventEmitter as any,
        );
    });

    it('forwards config when generating a CLI key', async () => {
        const result = await controller.generateKey('team-1', {
            name: 'CI Key',
            config: cliKeyConfig,
        });

        expect(teamCliKeyService.generateKey).toHaveBeenCalledWith(
            'team-1',
            'CI Key',
            'user-1',
            cliKeyConfig,
        );
        expect(result).toEqual({
            key: 'kodus_secret',
            message: 'Save this key securely. It will not be shown again.',
        });
        expect(eventEmitter.emit).toHaveBeenCalled();
    });

    it('returns config when listing CLI keys', async () => {
        const result = await controller.listKeys('team-1');

        expect(teamCliKeyService.findByTeamId).toHaveBeenCalledWith('team-1');
        expect(result).toEqual([
            {
                uuid: 'key-1',
                name: 'CI Key',
                active: true,
                lastUsedAt: new Date('2026-03-10T10:00:00.000Z'),
                createdAt: new Date('2026-03-10T09:00:00.000Z'),
                createdBy: {
                    uuid: 'user-1',
                },
                config: cliKeyConfig,
            },
        ]);
    });

    it('updates the CLI key config for the requested team', async () => {
        teamCliKeyService.findById.mockResolvedValue({
            uuid: 'key-1',
            team: { uuid: 'team-1' },
            config: {
                capabilities: [],
            },
        });
        teamCliKeyService.update.mockResolvedValue({
            uuid: 'key-1',
            name: 'CI Key',
            active: true,
            config: cliKeyConfig,
            createdAt: new Date('2026-03-10T09:00:00.000Z'),
            createdBy: {
                uuid: 'user-1',
            },
        });

        const result = await controller.updateKeyConfig('team-1', 'key-1', {
            config: cliKeyConfig,
        });

        expect(teamCliKeyService.update).toHaveBeenCalledWith(
            { uuid: 'key-1' },
            { config: cliKeyConfig },
        );
        expect(result).toEqual({
            uuid: 'key-1',
            name: 'CI Key',
            active: true,
            config: cliKeyConfig,
            createdAt: new Date('2026-03-10T09:00:00.000Z'),
            createdBy: {
                uuid: 'user-1',
            },
            lastUsedAt: undefined,
        });
    });

    it('rejects updates for keys from another team', async () => {
        teamCliKeyService.findById.mockResolvedValue({
            uuid: 'key-1',
            team: { uuid: 'team-2' },
        });

        await expect(
            controller.updateKeyConfig('team-1', 'key-1', {
                config: cliKeyConfig,
            }),
        ).rejects.toMatchObject({
            status: HttpStatus.NOT_FOUND,
        } as HttpException);
    });
});
