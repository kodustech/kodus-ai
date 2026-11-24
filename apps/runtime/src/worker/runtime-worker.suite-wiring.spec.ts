import { loadWorkerConfig } from '../shared/config';
import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { RuntimeWorkerModule } from './runtime-worker.module';
import { SUITE_RUNS, SUITE_SERVICE, SuiteService } from './suite/suite-service';
import { PgSuiteRuns } from './suite/pg-suite-runs';

// The production wiring of the suite (docs/runtime/e2e-suites.md section 11): the service the workflow runs, the run store the
// retry reads, and the queue the engine registers. No database is opened by building the providers.
const config = loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_SUITE_MAX_HOSTS: '5' });
const providers = RuntimeWorkerModule.forConfig(config).providers as any[];
const provider = (token: unknown) => providers.find((p) => p?.provide === token);

describe('the suite in the worker module', () => {
    it('provides the run store of the suites and the service the workflow runs', () => {
        const pool = { query: jest.fn() } as any;
        expect(provider(SUITE_RUNS).useFactory(pool)).toBeInstanceOf(PgSuiteRuns);
        const service = provider(SUITE_SERVICE).useFactory(pool, { envForSuite: jest.fn() }, { get: jest.fn() }, provider(SUITE_RUNS).useFactory(pool), { publish: jest.fn() });
        expect(service).toBeInstanceOf(SuiteService);
        expect((service as any).d.publisher).toBeDefined();
    });
});
