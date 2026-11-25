import { JwtService } from '@nestjs/jwt';

import { MCPManagerService } from '../mcp-manager.service';
import { credentialFingerprint } from '../../credential-fingerprint';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Production 2026-11-20: Linear refused the token the MCP Manager issued on
// 352 reviews a day. The manager refreshes by the stated expiry only, so it
// never learned the token was dead and handed it out again on every review.
function serviceWithLinear(post: jest.Mock) {
    const service = new MCPManagerService(
        {
            sign: jest.fn().mockReturnValue('signed-token'),
        } as unknown as JwtService,
        { shouldLimitResources: jest.fn().mockResolvedValue(false) } as any,
        {} as any,
    );
    const get = jest.fn().mockImplementation((path: string) => {
        if (path === 'mcp/connections') {
            return Promise.resolve({
                items: [
                    {
                        id: 'connection-1',
                        organizationId: 'org-123',
                        integrationId: 'linear-default',
                        provider: 'kodusmcp',
                        status: 'ACTIVE',
                        appName: 'Linear',
                        mcpUrl: 'https://mcp.linear.app/mcp',
                        allowedTools: ['list_issues'],
                        metadata: {},
                    },
                ],
            });
        }
        if (
            path === 'mcp/integration/kodusmcp/linear-default/connection-config'
        ) {
            return Promise.resolve({
                headers: { Authorization: 'Bearer revoked-token' },
            });
        }
        return Promise.resolve(undefined);
    });
    (service as any).axiosMCPManagerService = { get, post };
    return service;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('MCPManagerService — a refused kodusmcp credential', () => {
    it('reports the refused credential to the MCP Manager, named by its fingerprint', async () => {
        const post = jest.fn().mockResolvedValue({ outcome: 'grant_lost' });
        const [linear] = await serviceWithLinear(post).getConnections(
            { organizationId: 'org-123' },
            true,
        );

        linear.onCredentialRejected!();
        await settle();

        expect(post).toHaveBeenCalledWith(
            'mcp/integration/kodusmcp/linear-default/credential-rejected',
            {
                fingerprint: credentialFingerprint({
                    Authorization: 'Bearer revoked-token',
                }),
            },
            expect.objectContaining({
                headers: { Authorization: 'Bearer signed-token' },
            }),
        );
        // The token itself never leaves in the report.
        expect(JSON.stringify(post.mock.calls)).not.toContain('revoked-token');
    });

    it('reports a credential once per window, not once per review', async () => {
        const post = jest.fn().mockResolvedValue({ outcome: 'kept' });
        const service = serviceWithLinear(post);

        for (let review = 0; review < 3; review++) {
            const [linear] = await service.getConnections(
                { organizationId: 'org-123' },
                true,
            );
            linear.onCredentialRejected!();
            await settle();
        }

        expect(post).toHaveBeenCalledTimes(1);
    });

    it('tries again on the next review when the report was not delivered', async () => {
        const post = jest
            .fn()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue({ outcome: 'refreshed' });
        const service = serviceWithLinear(post);

        for (let review = 0; review < 2; review++) {
            const [linear] = await service.getConnections(
                { organizationId: 'org-123' },
                true,
            );
            linear.onCredentialRejected!();
            await settle();
        }

        expect(post).toHaveBeenCalledTimes(2);
    });
});
