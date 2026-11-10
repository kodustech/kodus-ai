import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { loadWorkerConfig } from './config';
const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
it('retains the product host by default and accepts a worker only with the explicit versioned release and product gateway', () => {
    expect(loadWorkerConfig(base).plannerHost).toBe('product');
    expect(
        loadWorkerConfig({
            ...base,
            RUNTIME_PLANNER_HOST: 'worker',
            RUNTIME_RELEASE_VERSION: 'runtime-fixture-planner-worker-v1',
            RUNTIME_LLM_GATEWAY_URL: 'https://product.test',
        }).plannerHost,
    ).toBe('worker');
});
it.each([
    { RUNTIME_PLANNER_HOST: 'worker' },
    {
        RUNTIME_PLANNER_HOST: 'worker',
        RUNTIME_LLM_GATEWAY_URL: 'https://product.test',
    },
    {
        RUNTIME_PLANNER_HOST: 'worker',
        RUNTIME_RELEASE_VERSION: 'runtime-fixture-planner-worker-v1',
    },
    { RUNTIME_PLANNER_HOST: 'unknown' },
])(
    'refuses an incomplete migration host configuration without silently falling back',
    (env) => {
        expect(() => loadWorkerConfig({ ...base, ...env })).toThrow();
    },
);
