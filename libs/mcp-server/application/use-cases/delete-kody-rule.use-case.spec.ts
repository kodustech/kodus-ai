import { JwtService } from '@nestjs/jwt';
import { DeleteKodyRuleFromMcpUseCase } from './delete-kody-rule.use-case';
import { KODUS_MCP_TOKEN_AUDIENCE } from '../../utils/mcp-auth.constants';
import { KodyRulesTools } from '../../tools/kodyRules.tools';

const secret = 'mcp-test-secret-only';
const jwt = new JwtService();
const sign = (claims = { organizationId: 'org-1' }, options = {}) =>
    jwt.sign(claims, {
        secret,
        algorithm: 'HS256',
        expiresIn: '1h',
        issuer: KODUS_MCP_TOKEN_AUDIENCE,
        audience: KODUS_MCP_TOKEN_AUDIENCE,
        ...options,
    });

describe('MCP rule deletion authentication', () => {
    const teams = { findOneOrganizationIdByTeamId: jest.fn() };
    const deletion = { execute: jest.fn() };
    const useCase = new DeleteKodyRuleFromMcpUseCase(
        jwt,
        {
            get: () => ({ secret }),
        } as any,
        teams as any,
        deletion as any,
    );
    const tools = new KodyRulesTools({} as any, {} as any, useCase);
    const args = {
        organizationId: 'org-1',
        teamId: 'team-1',
        ruleId: 'rule-1',
    };
    const call = (token?: string, overrides = {}) =>
        tools.deleteKodyRule().execute({ ...args, ...overrides } as any, {
            requestInfo: {
                headers: {
                    authorization: token ? `Bearer ${token}` : undefined,
                },
            },
        });

    beforeEach(() => {
        jest.clearAllMocks();
        teams.findOneOrganizationIdByTeamId.mockResolvedValue('org-1');
        deletion.execute.mockResolvedValue(true);
    });

    it('uses the verified credential organization through the tool wrapper', async () => {
        const result = await call(sign());
        expect((result.structuredContent as { success: boolean }).success).toBe(
            true,
        );
        expect(deletion.execute).toHaveBeenCalledWith(
            'rule-1',
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
            }),
        );
    });

    it.each([
        ['missing', () => undefined],
        ['forged', () => sign(undefined, { secret: 'wrong-secret' })],
        ['expired', () => sign(undefined, { expiresIn: -1 })],
        ['wrong audience', () => sign(undefined, { audience: 'web' })],
        ['wrong issuer', () => sign(undefined, { issuer: 'web' })],
        ['missing organization', () => sign({} as any)],
    ])('rejects %s credentials before touching data', async (_name, token) => {
        const result = await call(token());
        expect(result.isError).toBe(true);
        expect(teams.findOneOrganizationIdByTeamId).not.toHaveBeenCalled();
        expect(deletion.execute).not.toHaveBeenCalled();
    });

    it('rejects a victim organization supplied as an argument', async () => {
        const result = await call(sign(), { organizationId: 'victim-org' });
        expect(result.isError).toBe(true);
        expect(deletion.execute).not.toHaveBeenCalled();
    });

    it('rejects a foreign team even when the organization argument matches', async () => {
        teams.findOneOrganizationIdByTeamId.mockResolvedValue('victim-org');
        const result = await call(sign());
        expect(result.isError).toBe(true);
        expect(deletion.execute).not.toHaveBeenCalled();
    });

    it('does not authenticate from a credential embedded in tool arguments', async () => {
        const result = await call(undefined, {
            authorization: `Bearer ${sign()}`,
        });
        expect(result.isError).toBe(true);
        expect(deletion.execute).not.toHaveBeenCalled();
    });
});
