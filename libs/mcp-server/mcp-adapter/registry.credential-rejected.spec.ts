const connect = jest.fn();
jest.mock('./client', () => ({
    SpecCompliantMCPClient: jest.fn().mockImplementation(() => ({
        connect,
        disconnect: jest.fn().mockResolvedValue(undefined),
    })),
}));

import { isCredentialRejection, MCPRegistry } from './registry';

// Production 2026-11-20: Linear refused the stored token on 352 reviews a day
// and nobody was told, so every review sent it again.
class HttpError extends Error {
    constructor(
        readonly code: number,
        message: string,
    ) {
        super(`Streamable HTTP error: ${message}`);
    }
}

const linear = (onCredentialRejected?: () => void) => ({
    name: 'Linear',
    type: 'http' as const,
    url: 'https://mcp.linear.app/mcp',
    headers: { Authorization: 'Bearer revoked' },
    onCredentialRejected,
});

describe('MCPRegistry.register — a refused credential', () => {
    beforeEach(() => connect.mockReset());

    it('tells whoever issued the credential when the server refuses it', async () => {
        connect.mockRejectedValue(
            new HttpError(
                401,
                'Error POSTing to endpoint: {"error":"invalid_token","error_description":"Invalid access token"}',
            ),
        );
        const onCredentialRejected = jest.fn();

        await expect(
            new MCPRegistry().register(linear(onCredentialRejected)),
        ).rejects.toThrow('invalid_token');
        expect(onCredentialRejected).toHaveBeenCalledTimes(1);
    });

    it('says nothing about the credential when the server fails for another reason', async () => {
        connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
        const onCredentialRejected = jest.fn();

        await expect(
            new MCPRegistry().register(linear(onCredentialRejected)),
        ).rejects.toThrow('ECONNREFUSED');
        expect(onCredentialRejected).not.toHaveBeenCalled();
    });

    it('still fails the registration when the report itself throws', async () => {
        connect.mockRejectedValue(new HttpError(401, 'Unauthorized'));
        const onCredentialRejected = jest.fn(() => {
            throw new Error('report failed');
        });

        await expect(
            new MCPRegistry().register(linear(onCredentialRejected)),
        ).rejects.toThrow('Unauthorized');
        expect(onCredentialRejected).toHaveBeenCalledTimes(1);
    });
});

describe('isCredentialRejection', () => {
    it.each([
        ['HTTP 401', new HttpError(401, 'Unauthorized'), true],
        [
            'invalid_token in the body',
            new Error('Error POSTing: {"error": "invalid_token"}'),
            true,
        ],
        ['HTTP 403', new HttpError(403, 'Forbidden'), false],
        ['HTTP 500', new HttpError(500, 'boom'), false],
        ['a network error', new Error('connect ECONNREFUSED'), false],
    ])('%s → %s', (_label, error, expected) => {
        expect(isCredentialRejection(error)).toBe(expected);
    });
});
