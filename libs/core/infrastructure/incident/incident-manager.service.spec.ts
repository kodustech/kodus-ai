import { ConfigService } from '@nestjs/config';
import { BetterStackClient } from './betterstack.client';
import { IncidentManagerService } from './incident-manager.service';

describe('IncidentManagerService', () => {
    let service: IncidentManagerService;
    let configService: { get: jest.Mock };
    let betterStackClient: {
        pingHeartbeat: jest.Mock;
        failHeartbeat: jest.Mock;
    };

    beforeEach(() => {
        configService = {
            get: jest.fn(),
        };
        betterStackClient = {
            pingHeartbeat: jest.fn().mockResolvedValue(undefined),
            failHeartbeat: jest.fn().mockResolvedValue(undefined),
        };

        service = new IncidentManagerService(
            betterStackClient as unknown as BetterStackClient,
            configService as unknown as ConfigService,
        );
    });

    afterEach(() => {
        service.onModuleDestroy();
    });

    it('pings the configured heartbeat url', async () => {
        configService.get.mockReturnValue('https://heartbeat.example');

        await service.pingHeartbeat('OUTBOX_HEARTBEAT');

        expect(betterStackClient.pingHeartbeat).toHaveBeenCalledWith(
            'https://heartbeat.example',
        );
    });

    it('fails the configured heartbeat url', async () => {
        configService.get.mockReturnValue('https://heartbeat.example');

        await service.failHeartbeat('OUTBOX_HEARTBEAT', 'failure payload');

        expect(betterStackClient.failHeartbeat).toHaveBeenCalledWith(
            'https://heartbeat.example',
            'failure payload',
            undefined,
        );
    });

    it('skips heartbeat reporting when no configured url exists', async () => {
        configService.get.mockReturnValue(undefined);

        await service.failHeartbeat('OUTBOX_HEARTBEAT', 'failure payload');
        await service.pingHeartbeat('OUTBOX_HEARTBEAT');

        expect(betterStackClient.failHeartbeat).not.toHaveBeenCalled();
        expect(betterStackClient.pingHeartbeat).not.toHaveBeenCalled();
    });
});
