import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import type { RuntimeLlmSpendRow } from '../../domain/llm-spend';
import {
    type Clock,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_LLM_SPEND_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_SETTINGS_STORE,
    RUNTIME_USAGE_REPORT_READER,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeLlmSpendReader,
    type RuntimeSettingsStore,
    type RuntimeUsageReportReader,
} from '../../domain/ports';
import { buildRuntimeHealth, type RuntimeHealth } from '../../domain/runtime-health';
import { RUNTIME_HEALTH_READER, type RuntimeHealthReader } from '../../infrastructure/pg-runtime-health.reader';
import { orgOf } from './environment-view';

const DAY = 86_400_000;

/**
 * GET /runtime/settings/health — owner only (docs/runtime/observability.md,
 * "The Health screen"): setups, Runs and boot times, what is stuck past the
 * hang detector's bounds, errors by blocker signature, the org's own cells,
 * and today's cost (the org's own cells at the price per host-hour it set).
 * Every part reads on its own: one that fails is "not measured" with its
 * reason, the others still answer.
 */
@Injectable()
export class GetRuntimeHealthUseCase {
    private readonly logger = createLogger(GetRuntimeHealthUseCase.name);

    constructor(
        @Inject(RUNTIME_HEALTH_READER) private readonly reader: RuntimeHealthReader,
        @Inject(RUNTIME_USAGE_REPORT_READER) private readonly usage: RuntimeUsageReportReader,
        @Inject(RUNTIME_API_CONFIG) private readonly config: Pick<RuntimeApiConfig, 'machineUnitPrices'>,
        @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
        @Optional() @Inject(RUNTIME_LLM_SPEND_READER) private readonly spend?: RuntimeLlmSpendReader,
        @Optional() @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments?: Pick<ProductEnvironmentStore, 'listByOrganization'>,
        @Optional() @Inject(RUNTIME_SETTINGS_STORE) private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeHealth> {
        const organizationId = orgOf(input.user);
        const now = this.clock();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const part = async <T>(name: string, f: () => Promise<T>): Promise<T | undefined> => {
            try {
                return await f();
            } catch (e) {
                this.logger.warn({ message: `Runtime health: ${name} could not be read`, context: GetRuntimeHealthUseCase.name, error: e instanceof Error ? e : undefined, metadata: { organizationId } });
                return undefined;
            }
        };
        const [allSetups, runs, liveRuns, openClaims, allBlockers, cells, sessions, claimsToday, spendToday, environments, orgSettings] = await Promise.all([
            part('setups', () => this.reader.setups(organizationId)),
            part('runs', () => this.reader.runs(organizationId, new Date(now.getTime() - 14 * DAY))),
            part('live runs', () => this.reader.liveRuns(organizationId)),
            part('open claims', () => this.reader.openClaims(organizationId)),
            part('blockers', () => this.reader.blockers(organizationId, new Date(now.getTime() - 7 * DAY))),
            part('cells', () => this.reader.cells(organizationId)),
            part('cell sessions', () => this.reader.sessions(organizationId)),
            part('claims of today', async () => (await this.usage.claimsOfMonth(organizationId, { start: today, end: now }, {}, 20_000)).claims),
            part('usage spans of today', async (): Promise<RuntimeLlmSpendRow[] | undefined> => (this.spend ? this.spend.spendOf({ organizationId, start: today, end: now }) : undefined)),
            part('environments', async () => (this.environments ? new Set((await this.environments.listByOrganization(organizationId)).map((e) => e.environmentId)) : undefined)),
            part('Runtime settings', async () => this.settings?.getOrganization(organizationId)),
        ]);
        // The Runtime keeps the setups of every environment it ever set up, a deleted one's included: count and link only
        // the environments the product still has (the Environments screen's), when that list can be read.
        const known = (environmentId: string | null | undefined) => !environments || !environmentId || environments.has(environmentId);
        const setups = allSetups?.filter((s) => known(s.environmentId));
        const blockers = allBlockers?.filter((b) => b.source !== 'setup' || known(b.environmentId));
        return buildRuntimeHealth({
            organizationId,
            now,
            setups,
            runs,
            liveRuns,
            openClaims,
            blockers,
            cells,
            sessions,
            claimsToday,
            spendToday,
            unitPrices: this.config.machineUnitPrices ?? null,
            ownHostUsdPerHour: orgSettings?.machineUsdPerHostHour ?? null,
        });
    }
}
