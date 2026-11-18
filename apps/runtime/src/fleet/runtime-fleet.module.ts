import { DynamicModule, Inject, Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import type { HostProvider } from '@libs/runtime/fleet/host-provider';

import { type FleetConfig, RUNTIME_CONFIG, RUNTIME_PG_POOL } from '../shared/config';
import { RuntimeLogger } from '../shared/observability/logger';
import { PgDistributedLocks } from '../shared/persistence/locks';
import { ensureDatabase, ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { FleetEngine, pruneFleetHistory } from './fleet-engine';
import { FleetReconciler } from './fleet-reconciler';
import { PgFleetStore } from './fleet-store';
import { fleetPost, HubFleetClient } from './hub-fleet-client';
import type { TemplateResolver } from './per-run-host';
import { BoatHostProvider } from './providers/boat/boat-provider';
import { ProviderRegistry } from './providers/registry';
import { PgTemplateStore, StoreTemplateResolver } from './template/template-store';

// runtime-fleet (docs/runtime/host-providers.md §4.1): the reconcile loop and
// the host workflows. It holds the provider credentials and nothing else of
// value: no Git credential, no product data, no cell identity of its own.

export const FLEET_LOGGER = Symbol('FLEET_LOGGER');
export const FLEET_TEMPLATES = Symbol('FLEET_TEMPLATES');

/** The providers this config holds: boat when its key is configured, the fake one only in dev. */
export function providersOf(config: FleetConfig, extra: HostProvider[] = []): ProviderRegistry {
    return new ProviderRegistry([
        ...(config.boat ? [new BoatHostProvider({ apiUrl: config.boat.apiUrl, apiKey: config.boat.apiKey, installation: config.installation })] : []),
        ...(config.fakeProvider ? [new FakeHostProvider({ installation: config.installation, startState: 'running' })] : []),
        ...extra,
    ]);
}

@Injectable()
class FleetRunner implements OnApplicationBootstrap, OnApplicationShutdown {
    private engine?: FleetEngine;
    private reconciler?: FleetReconciler;

    constructor(
        @Inject(RUNTIME_CONFIG) private readonly config: FleetConfig,
        @Inject(RUNTIME_PG_POOL) private readonly pool: Pool,
        @Inject(FLEET_LOGGER) private readonly logger: RuntimeLogger,
        @Inject(FLEET_TEMPLATES) private readonly templates: TemplateResolver | null,
        @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    ) {}

    async onApplicationBootstrap() {
        const c = this.config;
        await ensureDatabase(c.systemDatabaseUrl);
        const store = new PgFleetStore(this.pool);
        const tls = c.tls?.workerCert && c.tls.workerKey ? { cert: c.tls.workerCert, key: c.tls.workerKey, ca: c.tls.ca } : undefined;
        const hub = new HubFleetClient(c.hubUrl, fleetPost({ tls, testOnlyToken: c.testOnlyPlaintext?.fleetToken }));
        const log = (msg: string, fields: Record<string, unknown>) => this.logger.write('info', msg, fields);
        this.engine = new FleetEngine(c, {
            store,
            hub,
            providerFor: (k) => this.providers.get(k),
            // A Run host starts from its environment's ready template on its pool (runtime_env_templates).
            templates: this.templates ?? new StoreTemplateResolver(new PgTemplateStore(this.pool)),
            installation: c.installation,
            bootstrap: { hubUrl: c.hubPublicUrl, hubCa: c.hubCa },
            sealKey: c.secretSealKey,
        });
        await this.engine.launch();
        const engine = this.engine;
        this.reconciler = new FleetReconciler(
            new PgDistributedLocks(this.pool),
            { store, start: (input) => engine.start(input), providerFor: (k) => this.providers.get(k), installation: c.installation, now: () => Date.now(), log },
            c.reconcileIntervalMs,
            { prune: (now) => pruneFleetHistory(store, now) },
        );
        this.reconciler.start();
        this.logger.write('info', 'runtime-fleet started', { installation: c.installation, providers: this.providers.kinds() });
    }

    async onApplicationShutdown() {
        this.reconciler?.stop();
        await this.engine?.shutdown();
        await this.pool.end().catch(() => undefined);
    }
}

@Module({})
export class RuntimeFleetModule {
    static forConfig(config: FleetConfig, opts: { templates?: TemplateResolver; providers?: HostProvider[] } = {}): DynamicModule {
        return {
            module: RuntimeFleetModule,
            providers: [
                { provide: RUNTIME_CONFIG, useValue: config },
                { provide: FLEET_LOGGER, useFactory: () => new RuntimeLogger('runtime-fleet') },
                { provide: FLEET_TEMPLATES, useValue: opts.templates ?? null },
                { provide: ProviderRegistry, useValue: providersOf(config, opts.providers) },
                {
                    provide: RUNTIME_PG_POOL,
                    useFactory: async () => {
                        await ensureDatabase(config.databaseUrl);
                        const pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
                        await ensureRuntimeSchema(pool);
                        return pool;
                    },
                },
                FleetRunner,
            ],
        };
    }
}
