import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AuthGuard } from './auth.guard';

/**
 * GHSA-x89q-mgqp-xhpw — the guard used `jwtService.decode()`, which parses the
 * payload without checking the signature, so any forged JWT carrying an
 * `organizationId` bypassed auth on every MCP endpoint. It must `verifyAsync`
 * against the orchestrator secret instead.
 */
describe('mcp-manager AuthGuard — verifies signatures (GHSA-x89q)', () => {
    const secret = 'orchestrator-secret';
    const jwt = new JwtService({ secret });
    const guard = new AuthGuard(jwt);

    const ctxWith = (authorization?: string) =>
        ({
            switchToHttp: () => ({
                getRequest: () => ({ headers: { authorization } }),
            }),
        }) as any;

    it('rejects a forged token with an unsigned/fake signature', async () => {
        const header = Buffer.from(
            JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
        ).toString('base64url');
        const payload = Buffer.from(
            JSON.stringify({ organizationId: 'victim-org-12345' }),
        ).toString('base64url');
        const forged = `${header}.${payload}.fake_signature_aaaaaaaaaaaaaaaa`;

        await expect(
            guard.canActivate(ctxWith(`Bearer ${forged}`)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a token signed with a different secret', async () => {
        const token = await new JwtService({ secret: 'wrong' }).signAsync(
            { organizationId: 'org-1' },
            { secret: 'wrong' },
        );
        await expect(
            guard.canActivate(ctxWith(`Bearer ${token}`)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts a properly signed token and binds organizationId', async () => {
        const token = await jwt.signAsync(
            { organizationId: 'org-1', sub: 'u1' },
            { secret },
        );
        const request: any = {
            headers: { authorization: `Bearer ${token}` },
        };
        const ctx = {
            switchToHttp: () => ({ getRequest: () => request }),
        } as any;

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(request.organizationId).toBe('org-1');
    });

    it('rejects a validly signed token with no organizationId', async () => {
        const token = await jwt.signAsync({ sub: 'u1' }, { secret });
        await expect(
            guard.canActivate(ctxWith(`Bearer ${token}`)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when no Bearer token is present', async () => {
        await expect(
            guard.canActivate(ctxWith(undefined)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });
});
