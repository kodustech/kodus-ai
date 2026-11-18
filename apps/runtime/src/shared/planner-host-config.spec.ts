import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { loadWorkerConfig } from './config';

const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
const gateway = { RUNTIME_LLM_GATEWAY_URL: 'https://product.test' };

describe('RUNTIME_PLANNER_HOST', () => {
    it('plans on the product by default, under the release version exactly as given', () => {
        const config = loadWorkerConfig({ ...base, ...gateway, RUNTIME_RELEASE_VERSION: 'runtime-2026-11-14.1' });
        expect(config.plannerHost).toBe('product');
        expect(config.releaseVersion).toBe('runtime-2026-11-14.1');
    });

    it('reads an explicit product host the same as the default', () => {
        expect(loadWorkerConfig({ ...base, RUNTIME_PLANNER_HOST: 'product', RUNTIME_RELEASE_VERSION: 'r1' })).toMatchObject({ plannerHost: 'product', releaseVersion: 'r1' });
    });

    it('plans on the worker when asked, with a product gateway, under any release name', () => {
        expect(loadWorkerConfig({ ...base, ...gateway, RUNTIME_PLANNER_HOST: 'worker', RUNTIME_RELEASE_VERSION: 'runtime-2026-11-14.1' }).plannerHost).toBe('worker');
    });

    it('gives the worker host a DBOS version of its own, so a workflow never resumes on the other planner host', () => {
        const env = { ...base, ...gateway, RUNTIME_RELEASE_VERSION: 'runtime-2026-11-14.1' };
        const product = loadWorkerConfig({ ...env, RUNTIME_PLANNER_HOST: 'product' }).releaseVersion;
        const worker = loadWorkerConfig({ ...env, RUNTIME_PLANNER_HOST: 'worker' }).releaseVersion;
        expect(worker).toBe('runtime-2026-11-14.1+planner-worker');
        expect(worker).not.toBe(product);
    });

    it('refuses the worker host without a product gateway, instead of falling back to the product', () => {
        expect(() => loadWorkerConfig({ ...base, RUNTIME_PLANNER_HOST: 'worker', RUNTIME_RELEASE_VERSION: 'runtime-fixture-planner-worker-v1' })).toThrow(
            'RUNTIME_PLANNER_HOST=worker requires RUNTIME_LLM_GATEWAY_URL',
        );
    });

    it('refuses an unknown host instead of falling back to the product', () => {
        expect(() => loadWorkerConfig({ ...base, ...gateway, RUNTIME_PLANNER_HOST: 'unknown' })).toThrow();
    });
});
