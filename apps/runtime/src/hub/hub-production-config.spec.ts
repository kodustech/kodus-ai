import { assertSafeForProduction, type RuntimeConfig } from '../shared/config';

const config = (patch: Partial<RuntimeConfig>): RuntimeConfig =>
    ({ productionImage: true, envDriver: 'hub', workerAllowedCns: ['runtime-worker'], tls: { ca: 'cells-ca', caKey: 'k', cert: 'hub-cert', key: 'hub-key', workerCa: 'worker-ca' }, ...patch }) as RuntimeConfig;

describe('the production image and the internal listener', () => {
    it('starts with its own worker CA and named worker CNs', () => {
        expect(() => assertSafeForProduction(config({}))).not.toThrow();
    });

    it('refuses a missing RUNTIME_TLS_WORKER_CA: worker certificates would be checked against the cells CA', () => {
        expect(() => assertSafeForProduction(config({ tls: { ca: 'cells-ca', cert: 'hub-cert', key: 'hub-key' } }))).toThrow(/RUNTIME_TLS_WORKER_CA/);
    });

    it('refuses an empty RUNTIME_WORKER_ALLOWED_CNS: any worker certificate would get in', () => {
        expect(() => assertSafeForProduction(config({ workerAllowedCns: [] }))).toThrow(/RUNTIME_WORKER_ALLOWED_CNS/);
    });

    it('outside the production image, or in a process that serves no TLS, asks for neither', () => {
        expect(() => assertSafeForProduction(config({ productionImage: false, workerAllowedCns: [], tls: { ca: 'cells-ca', cert: 'c', key: 'k' } }))).not.toThrow();
        expect(() => assertSafeForProduction(config({ tls: undefined, workerAllowedCns: [] }))).not.toThrow();
    });
});
