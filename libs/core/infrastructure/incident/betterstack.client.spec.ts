import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { BetterStackClient } from './betterstack.client';

const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: jest.fn(() => logger),
}));

jest.mock('axios', () => ({
    __esModule: true,
    default: {
        create: jest.fn(() => ({ post: jest.fn() })),
        get: jest.fn(),
        post: jest.fn(),
    },
}));

describe('BetterStackClient', () => {
    const heartbeatUrl =
        'https://uptime.betterstack.com/api/v1/heartbeat/secret-token';

    let client: BetterStackClient;

    beforeEach(() => {
        jest.clearAllMocks();

        client = new BetterStackClient({
            get: jest.fn().mockReturnValue('api-token'),
        } as unknown as ConfigService);
    });

    it('does not log the raw heartbeat url when ping succeeds', async () => {
        (axios.get as jest.Mock).mockResolvedValue({});

        await client.pingHeartbeat(heartbeatUrl);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Heartbeat ping sent',
                metadata: expect.objectContaining({
                    heartbeatTarget: expect.any(String),
                }),
            }),
        );

        expect(logger.debug).not.toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    heartbeatUrl,
                }),
            }),
        );
    });

    it('does not log the raw heartbeat url when fail succeeds', async () => {
        (axios.post as jest.Mock).mockResolvedValue({});

        await client.failHeartbeat(heartbeatUrl, 'failure payload');

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Heartbeat fail reported',
                metadata: expect.objectContaining({
                    heartbeatTarget: expect.any(String),
                    failMessage: 'failure payload',
                }),
            }),
        );

        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    heartbeatUrl,
                }),
            }),
        );
    });
});
