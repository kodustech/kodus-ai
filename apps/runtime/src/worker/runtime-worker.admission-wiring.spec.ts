import { MODULE_METADATA } from '@nestjs/common/constants';

import { RuntimeHubModule } from '../hub/runtime-hub.module';
import { CellHub } from '../hub/cell-hub';
import { loadWorkerConfig } from '../shared/config';
import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { ADMISSION_COORDINATOR, AdmissionCoordinator } from './dbos/admission-coordinator';
import { RuntimeWorkerModule } from './runtime-worker.module';

describe('durable admission production wiring', () => {
    afterEach(() => jest.restoreAllMocks());
    it.each([false, true])('provides the coordinator only when enabled: %s', (enabled) => {
        const config = loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_DURABLE_ADMISSION: enabled ? '1' : '0' });
        const provider = RuntimeWorkerModule.forConfig(config).providers!.find((p: any) => p.provide === ADMISSION_COORDINATOR) as any;
        expect(provider).toBeDefined();
        const coordinator = provider.useFactory({}, {});
        if (enabled) expect(coordinator).toBeInstanceOf(AdmissionCoordinator);
        else expect(coordinator).toBeUndefined();
    });

    it('uses the same shared-org claim limit in the hub and worker', async () => {
        const config = loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_ORG_SHARED_CLAIM_CAP: '3', RUNTIME_DURABLE_ADMISSION: '1' });
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RuntimeHubModule) as any[];
        const provider = providers.find((p) => p.provide === CellHub);
        // No database connection or network is opened by module construction.
        expect(provider).toBeDefined();
        expect(config.orgSharedClaimCap).toBe(3);
        const { loadRuntimeConfig } = await import('../shared/config');
        expect(loadRuntimeConfig({ RUNTIME_ORG_SHARED_CLAIM_CAP: '3' }).orgSharedClaimCap).toBe(3);
        jest.spyOn(CellHub.prototype, 'ensureManagedCells').mockResolvedValue(undefined);
        jest.spyOn(CellHub.prototype, 'refreshPins').mockResolvedValue(undefined);
        const hub = await provider.useFactory({ ...config, testOnlyPlaintext: { internalToken: 'synthetic-token-only', cellTokens: {} } }, {}, { child: () => ({ write: jest.fn() }) });
        expect(hub.tickets).toBeDefined();
    });
});
