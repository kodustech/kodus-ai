import { NotFoundException, UnauthorizedException } from '@nestjs/common';

import { loadRuntimeConfig, RuntimeConfig } from '../config';
import { FleetAuthGuard, WorkerAuthGuard } from './internal-auth.guard';

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

// F-04 (docs/runtime/host-providers.md §12.2): the fleet routes take only the fleet's CN, and the
// worker routes never take it; internal-auth admits any listed worker CN, so the list is per route.
describe('FleetAuthGuard', () => {
    const config: RuntimeConfig = { ...loadRuntimeConfig({}), internalPort: 3411, workerAllowedCns: [], fleetAllowedCns: ['runtime-fleet'] };
    const at = (cn: string) => ctx({ socket: tls({ OU: 'worker', CN: cn }, true, 3411) });

    it("takes the fleet's CN on the internal listener, and no worker's", () => {
        const g = new FleetAuthGuard(config);
        expect(g.canActivate(at('runtime-fleet'))).toBe(true);
        expect(() => g.canActivate(at('runtime-worker'))).toThrow(UnauthorizedException);
        expect(() => g.canActivate(ctx({ socket: tls({ OU: 'worker', CN: 'runtime-fleet' }, true, 3410) }))).toThrow(NotFoundException);
    });

    it('with no fleet CN configured, refuses every caller', () => {
        expect(() => new FleetAuthGuard({ ...config, fleetAllowedCns: [] }).canActivate(at('runtime-fleet'))).toThrow(UnauthorizedException);
    });

    it("the worker routes refuse the fleet's CN, even with no worker allowlist", () => {
        expect(() => new WorkerAuthGuard(config).canActivate(at('runtime-fleet'))).toThrow(UnauthorizedException);
        expect(new WorkerAuthGuard(config).canActivate(at('runtime-worker'))).toBe(true);
    });

    it('a CN in both lists stops the process at boot', () => {
        expect(() => loadRuntimeConfig({ RUNTIME_WORKER_ALLOWED_CNS: 'runtime-worker,runtime-fleet', RUNTIME_FLEET_ALLOWED_CNS: 'runtime-fleet' })).toThrow(/RUNTIME_FLEET_ALLOWED_CNS/);
        expect(loadRuntimeConfig({ RUNTIME_FLEET_ALLOWED_CNS: ' runtime-fleet ' }).fleetAllowedCns).toEqual(['runtime-fleet']);
    });

    it('in plaintext test mode, only the fleet bearer token', () => {
        const req = (t: string) => ctx({ socket: { localPort: 3411 }, headers: { authorization: `Bearer ${t}` } });
        const plain = { ...config, testOnlyPlaintext: { internalToken: 'worker-token-long-enough', fleetToken: 'fleet-token-long-enough', cellTokens: {} } };
        expect(new FleetAuthGuard(plain).canActivate(req('fleet-token-long-enough'))).toBe(true);
        expect(() => new FleetAuthGuard(plain).canActivate(req('worker-token-long-enough'))).toThrow(UnauthorizedException);
    });
});
