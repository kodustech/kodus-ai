import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { getMcpPrincipal } from '../auth/mcp-principal';
import { KODUS_MCP_TOKEN_AUDIENCE } from '../utils/mcp-auth.constants';
import { McpAuthGuard } from './mcp-auth.guard';

const SECRET = 'test-secret';
const jwt = new JwtService();

const sign = (
    payload: Record<string, unknown>,
    options: Record<string, unknown> = {},
) =>
    jwt.sign(payload, {
        secret: SECRET,
        algorithm: 'HS256',
        expiresIn: '1h',
        issuer: KODUS_MCP_TOKEN_AUDIENCE,
        audience: KODUS_MCP_TOKEN_AUDIENCE,
        ...options,
    });

describe('McpAuthGuard', () => {
    const validateKey = jest.fn();
    const guard = new McpAuthGuard(
        jwt,
        { get: () => ({ secret: SECRET }) } as any,
        { validateKey } as any,
    );

    const toolCall = { jsonrpc: '2.0', method: 'tools/call' };
    const run = async (
        headers: Record<string, string>,
        body: unknown = toolCall,
    ) => {
        const req: any = { headers, body };
        await guard.canActivate({
            switchToHttp: () => ({ getRequest: () => req }),
        } as any);
        return getMcpPrincipal({ authInfo: req.auth });
    };

    beforeEach(() => validateKey.mockReset());

    it('takes the organization from a first-party service token', async () => {
        await expect(
            run({
                authorization: `Bearer ${sign({ organizationId: 'org-1' })}`,
            }),
        ).resolves.toEqual({ kind: 'service', organizationId: 'org-1' });
    });

    it.each([
        ['no credential', {}],
        [
            'a user session JWT',
            {
                authorization: `Bearer ${sign({ organizationId: 'org-1' }, { issuer: 'kodus', audience: 'kodus' })}`,
            },
        ],
        [
            'a token signed with another secret',
            {
                authorization: `Bearer ${jwt.sign({ organizationId: 'org-1' }, { secret: 'other', issuer: KODUS_MCP_TOKEN_AUDIENCE, audience: KODUS_MCP_TOKEN_AUDIENCE })}`,
            },
        ],
        [
            'an expired token',
            {
                authorization: `Bearer ${sign({ organizationId: 'org-1' }, { expiresIn: -10 })}`,
            },
        ],
        [
            'a token without organization',
            { authorization: `Bearer ${sign({})}` },
        ],
        ['a malformed header', { authorization: 'Basic abc' }],
    ])('rejects %s', async (_label, headers) => {
        await expect(run(headers)).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
    });

    it.each([
        ['x-team-key', { 'x-team-key': 'kodus_abc' }],
        ['Bearer kodus_', { authorization: 'Bearer kodus_abc' }],
    ])('binds a team key sent as %s to its team', async (_label, headers) => {
        validateKey.mockResolvedValue({
            organization: { uuid: 'org-1' },
            team: { uuid: 'team-1' },
            config: { capabilities: [] },
        });
        await expect(run(headers)).resolves.toEqual({
            kind: 'team-key',
            organizationId: 'org-1',
            teamId: 'team-1',
            config: { capabilities: [] },
        });
        expect(validateKey).toHaveBeenCalledWith('kodus_abc');
    });

    it('rejects a revoked team key', async () => {
        validateKey.mockResolvedValue(null);
        await expect(
            run({ 'x-team-key': 'kodus_gone' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
        ['initialize', { method: 'initialize' }],
        ['tools/list', { method: 'tools/list' }],
        [
            'a discovery batch',
            [{ method: 'initialize' }, { method: 'tools/list' }],
        ],
    ])(
        'lets %s through without a credential or principal',
        async (_l, body) => {
            await expect(run({}, body)).resolves.toBeUndefined();
        },
    );

    it.each([
        ['tools/call', { method: 'tools/call' }],
        [
            'a batch hiding a tools/call',
            [{ method: 'tools/list' }, { method: 'tools/call' }],
        ],
        ['an empty batch', []],
        ['an unknown method', { method: 'resources/read' }],
    ])('still requires a credential for %s', async (_l, body) => {
        await expect(run({}, body)).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
    });

    it('validates a credential that is sent, even for discovery', async () => {
        await expect(
            run({ authorization: 'Bearer forged' }, { method: 'tools/list' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });
});
