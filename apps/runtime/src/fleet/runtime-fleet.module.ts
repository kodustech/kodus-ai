import { DynamicModule, Inject, Injectable, Module, Optional, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import type { HostProvider } from '@libs/runtime/fleet/host-provider';
import { cellBaseOf } from '@libs/runtime/fleet/pool';

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
import { PgTemplateSetupStore } from '@libs/runtime/run/adapters/pg-template-setup.store';
import { SetupRecordBakeProbe } from './template/bake-probe';
import { BoatSetupHost, type HostSealer } from './template/boat-setup-host';
import { HubHostSealer } from './template/hub-host-sealer';
import { buildEnvironmentTemplate } from './template/build-template';
import { fleetTemplateTrigger } from './template/fleet-template-trigger';
import { RequestingSetupHost, type TemplateBuildTrigger, type TemplateSetupRequester, TriggeringTemplateResolver } from './template/template-trigger';
import { PgSetupCandidates } from './template/setup-candidates-store';
import { TemplateRebuildPass } from './template/template-rebuild';
import { PgTemplateSetupRequester } from './template/pg-template-setup-requester';
import { PgTemplateStore, StoreTemplateResolver } from './template/template-store';

// runtime-fleet (docs/runtime/host-providers.md §4.1): the reconcile loop and
// the host workflows. It holds the provider credentials and nothing else of
// value: no Git credential, no product data, no cell identity of its own.

/** How often the fleet looks for default-branch setups that ended with a fingerprint no template holds. */
const TEMPLATE_REBUILD_INTERVAL_MS = 60_000;

export const FLEET_LOGGER = Symbol('FLEET_LOGGER');
export const FLEET_TEMPLATES = Symbol('FLEET_TEMPLATES');
/** The `HostSealer` that makes a template host's disk safe to save (stops the cell, removes identity, token file and /tmp). Absent: the hub-to-cell seal adapter (HubHostSealer: cell.seal through the hub's fleet route) is used. */
export const FLEET_HOST_SEALER = Symbol('FLEET_HOST_SEALER');
/** The `TemplateSetupRequester` that asks the setup request path for an environment's setup on its template host. Absent: no template is built. */
export const FLEET_TEMPLATE_SETUP_REQUESTER = Symbol('FLEET_TEMPLATE_SETUP_REQUESTER');

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
    private rebuildTimer?: NodeJS.Timeout;
    /** Started by a Run's demand and by the rebuild pass (`TemplateRebuildPass`), which finds the setups that ended with a new fingerprint. */
    templateTrigger?: TemplateBuildTrigger;

    constructor(
        @Inject(RUNTIME_CONFIG) private readonly config: FleetConfig,
        @Inject(RUNTIME_PG_POOL) private readonly pool: Pool,
        @Inject(FLEET_LOGGER) private readonly logger: RuntimeLogger,
        @Inject(FLEET_TEMPLATES) private readonly templates: TemplateResolver | null,
        @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
        @Optional() @Inject(FLEET_HOST_SEALER) private readonly sealer?: HostSealer | null,
        @Optional() @Inject(FLEET_TEMPLATE_SETUP_REQUESTER) private readonly requester?: TemplateSetupRequester | null,
    ) {}

    async onApplicationBootstrap() {
        const c = this.config;
        await ensureDatabase(c.systemDatabaseUrl);
        const store = new PgFleetStore(this.pool);
        const tls = c.tls?.workerCert && c.tls.workerKey ? { cert: c.tls.workerCert, key: c.tls.workerKey, ca: c.tls.ca } : undefined;
        const hub = new HubFleetClient(c.hubUrl, fleetPost({ tls, testOnlyToken: c.testOnlyPlaintext?.fleetToken }));
        const log = (msg: string, fields: Record<string, unknown>) => this.logger.write('info', msg, fields);
        const templateStore = new PgTemplateStore(this.pool);
        let templates: TemplateResolver = this.templates ?? new StoreTemplateResolver(templateStore);
        // The environment template builder runs only where it can seal a host and ask for the setup on it.
        const boat = this.providers.get('boat');
        if (boat && this.requester && !this.templates) {
            // A template build's own setup record (runtime_template_setups, by setup key): only the bake probe reads it.
            const templateSetups = new PgTemplateSetupStore(this.pool);
            const allBoatPools = async () => (await store.controlledPools()).pools.filter((p) => p.pool.provider === 'boat' && p.pool.lifecycle === 'perRun').map((p) => ({ poolId: p.poolId, pool: p.pool }));
            const boatPoolsOf = async (organizationId: string) => (await allBoatPools()).filter((p) => !p.pool.admission || p.pool.admission.allowOrgs.includes(organizationId));
            const poll = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), attempts: 360, intervalMs: 10_000 };
            const setupHosts = new RequestingSetupHost(
                new BoatSetupHost({
                    provider: boat,
                    hub,
                    probe: new SetupRecordBakeProbe(templateSetups),
                    sealer: this.sealer ?? new HubHostSealer({ hub, poll: { sleep: poll.sleep, attempts: 40, intervalMs: 3_000 } }),
                    poolOf: async (poolId) => (await store.pool(poolId))?.pool,
                    installation: c.installation,
                    bootstrap: { hubUrl: c.hubPublicUrl, hubCa: c.hubCa },
                    poll,
                }),
                this.requester,
            );
            const trigger = fleetTemplateTrigger(this.pool, {
                store: templateStore,
                poolOf: async (poolId) => {
                    const p = await store.pool(poolId);
                    return p ? { poolId, pool: p.pool } : null;
                },
                boatPoolsOf,
                build: (req) => buildEnvironmentTemplate(req, { store: templateStore, provider: boat, setupHosts, cellBase: cellBaseOf(req.pool.hostClass) ?? '', poll, log }),
                log,
            });
            templates = new TriggeringTemplateResolver(templates, trigger);
            this.templateTrigger = trigger;
            const pass = new TemplateRebuildPass(new PgDistributedLocks(this.pool), { setups: new PgSetupCandidates(this.pool), templates: templateStore,
                boatPools: allBoatPools,
                // A setup host the provider lists as gone or failed (or does not list) belongs to no live build.
                liveSetupHosts: async () => {
                    try {
                        return new Set((await boat.list({ installation: c.installation })).filter((h) => h.state !== 'gone' && h.state !== 'failed').flatMap((h) => (h.tags.host ? [h.tags.host] : [])));
                    } catch {
                        return null;
                    }
                },
                trigger, now: () => Date.now(), log });
            this.rebuildTimer = setInterval(() => void pass.tick(), TEMPLATE_REBUILD_INTERVAL_MS);
            this.rebuildTimer.unref?.();
        }
        this.engine = new FleetEngine(c, {
            store,
            hub,
            providerFor: (k) => this.providers.get(k),
            // A Run host starts from its environment's ready template on its pool (runtime_env_templates).
            templates,
            installation: c.installation,
            bootstrap: { hubUrl: c.hubPublicUrl, hubCa: c.hubCa },
            sealKey: c.secretSealKey,
        });
        await this.engine.launch();
        const engine = this.engine;
        this.reconciler = new FleetReconciler(
            new PgDistributedLocks(this.pool),
            { store, start: (input) => engine.start(input), providerFor: (k) => this.providers.get(k), installation: c.installation, now: () => Date.now(), log, templateSetupHosts: () => templateStore.buildingSetupHosts() },
            c.reconcileIntervalMs,
            { prune: (now) => pruneFleetHistory(store, now) },
        );
        this.reconciler.start();
        this.logger.write('info', 'runtime-fleet started', { installation: c.installation, providers: this.providers.kinds() });
    }

    async onApplicationShutdown() {
        this.reconciler?.stop();
        if (this.rebuildTimer) clearInterval(this.rebuildTimer);
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
                { provide: FLEET_TEMPLATE_SETUP_REQUESTER, useFactory: (pool: Pool) => new PgTemplateSetupRequester(pool), inject: [RUNTIME_PG_POOL] },
                FleetRunner,
            ],
        };
    }
}
