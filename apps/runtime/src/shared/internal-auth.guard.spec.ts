import { NotFoundException, UnauthorizedException } from '@nestjs/common';

import { loadRuntimeConfig, RuntimeConfig } from './config';
import { WorkerAuthGuard } from './internal-auth.guard';

const ctx = (req: unknown) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
const tls = (subject: Record<string, string> | undefined, authorized: boolean, localPort: number) => ({
    localPort,
    authorized,
    getPeerCertificate: () => (subject ? { subject } : {}),
});

describe('WorkerAuthGuard', () => {
    const config: RuntimeConfig = { ...loadRuntimeConfig({}), internalPort: 3411, workerAllowedCns: [] };
    const guard = (over: Partial<RuntimeConfig> = {}) => new WorkerAuthGuard({ ...config, ...over });

    it('an internal route on the public listener is 404, even with a worker certificate', () => {
        expect(() => guard().canActivate(ctx({ socket: tls({ OU: 'worker', CN: 'runtime-worker' }, true, 3410) }))).toThrow(NotFoundException);
    });

    it('takes a verified OU=worker certificate on the internal listener, and nothing else', () => {
        expect(guard().canActivate(ctx({ socket: tls({ OU: 'worker', CN: 'runtime-worker' }, true, 3411) }))).toBe(true);
        expect(() => guard().canActivate(ctx({ socket: tls({ OU: 'cell', CN: 'cell-1' }, true, 3411) }))).toThrow(UnauthorizedException);
        expect(() => guard().canActivate(ctx({ socket: tls({ OU: 'worker' }, false, 3411) }))).toThrow(UnauthorizedException);
        // Two OUs is ambiguous: no identity.
        expect(() => guard().canActivate(ctx({ socket: tls({ OU: ['worker', 'cell'] as any, CN: 'x' }, true, 3411) }))).toThrow(UnauthorizedException);
    });

    it('with an allowlist, only the named worker CNs', () => {
        const g = guard({ workerAllowedCns: ['runtime-worker'] });
        expect(g.canActivate(ctx({ socket: tls({ OU: 'worker', CN: 'runtime-worker' }, true, 3411) }))).toBe(true);
        expect(() => g.canActivate(ctx({ socket: tls({ OU: 'worker', CN: 'someone-else' }, true, 3411) }))).toThrow(UnauthorizedException);
    });

    it('the bearer token only in plaintext test mode', () => {
        const plain = { localPort: 3411 };
        const req = { socket: plain, headers: { authorization: 'Bearer a-long-enough-token' } };
        expect(() => guard().canActivate(ctx(req))).toThrow(UnauthorizedException);
        expect(guard({ testOnlyPlaintext: { internalToken: 'a-long-enough-token', cellTokens: {} } }).canActivate(ctx(req))).toBe(true);
    });
});
