import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import type { RuntimeLlmSpendRow } from '../domain/llm-spend';
import {
    type Clock,
    RUNTIME_API_CONFIG,
    RUNTIME_CELL_READER,
    RUNTIME_CLAIM_USAGE_READER,
    RUNTIME_CLOCK,
    RUNTIME_LLM_SPEND_READER,
    RUNTIME_SETTINGS_STORE,
    type RuntimeApiConfig,
    type RuntimeCellReader,
    type RuntimeClaimUsageReader,
    type RuntimeLlmSpendReader,
    type RuntimeSettingsStore,
} from '../domain/ports';
import { estimateRunCost, type OwnHostPrice, type RunClaimUsage, type RuntimeRunCost } from '../domain/run-cost';

/** Spans are stamped when a call ends: the window around the Runs reaches every call of theirs. */
const SPAN_WINDOW_MARGIN_MS = 60 * 60_000;

export type RunCostInput = Pick<RuntimeRunProjection, 'runId' | 'organizationId' | 'requestedAt' | 'bootingAt' | 'startedAt' | 'finishedAt' | 'cellOwner'>;

/**
 * The cost of Runs (§13 PR 5) for the Run page, the Run list and the usage
 * report: one read of the Runs' usage spans and one of their claims per org
 * for the whole page. A part that cannot be read leaves that part null
 * ("not measured" / "not priced"); the Run still loads. A Run on the org's
 * own cells is priced at the price per host-hour the org set (Runtime
 * settings), read once per org that has such a Run on the page.
 */
@Injectable()
export class RuntimeRunCostService {
    private readonly logger = createLogger(RuntimeRunCostService.name);

    constructor(
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional()
        @Inject(RUNTIME_LLM_SPEND_READER)
        private readonly spend?: RuntimeLlmSpendReader,
        @Optional()
        @Inject(RUNTIME_CLAIM_USAGE_READER)
        private readonly claims?: RuntimeClaimUsageReader,
        @Optional()
        @Inject(RUNTIME_API_CONFIG)
        private readonly config?: Pick<RuntimeApiConfig, 'cellPrices'>,
        @Optional()
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
        @Optional()
        @Inject(RUNTIME_CELL_READER)
        private readonly cells?: Pick<RuntimeCellReader, 'listByOrganization'>,
    ) {}

    /**
     * `known.claims`: the Runs' claims the caller already read (the usage report), instead of reading them again;
     * `known.ownHostPrices`: each org's own host price the caller already read (undefined: none).
     */
    async forRuns(
        runs: RunCostInput[],
        known: { claims?: ReadonlyMap<string, RunClaimUsage[]>; ownHostPrices?: ReadonlyMap<string, OwnHostPrice | undefined> } = {},
    ): Promise<Map<string, RuntimeRunCost>> {
        const now = this.now();
        const [spend, claims, ownHostPrices] = await Promise.all([this.spendOf(runs, now), known.claims ?? this.claimsOf(runs), known.ownHostPrices ?? this.ownHostPricesOf(runs)]);
        const cellPrices = this.config?.cellPrices ?? {};
        const cellPriceOf = (cellId: string) => cellPrices[cellId] ?? null;
        return new Map(
            runs.map((run) => {
                const ownHostPrice = ownHostPrices.get(run.organizationId);
                return [
                    run.runId,
                    estimateRunCost({ run, spend: spend ? (spend.get(run.runId) ?? []) : undefined, claims: claims.get(run.runId), cellPriceOf, ...(ownHostPrice ? { ownHostPrice } : {}), now }),
                ];
            }),
        );
    }

    /**
     * The org's own hosts at the price per host-hour it set: the price, then the cells it registered (a revoked one
     * still prices the Runs it served). None set, or a part that cannot be read: undefined, its machines stay unpriced.
     */
    async ownHostPriceOf(organizationId: string): Promise<OwnHostPrice | undefined> {
        if (!this.settings || !this.cells) return undefined;
        try {
            const usdPerHour = (await this.settings.getOrganization(organizationId))?.machineUsdPerHostHour;
            if (!usdPerHour) return undefined;
            const cells = await this.cells.listByOrganization(organizationId);
            return { usdPerHour, cellIds: new Set(cells.filter((c) => c.owner === 'customer').map((c) => c.cellId)) };
        } catch (e) {
            this.logger.warn({
                message: "Runtime Run cost: the org's price per host-hour or its cells could not be read; its own machines stay unpriced",
                context: RuntimeRunCostService.name,
                error: e instanceof Error ? e : undefined,
                metadata: { organizationId },
            });
            return undefined;
        }
    }

    /** One read per org with a Run on its own cells; the others need none. */
    private async ownHostPricesOf(runs: RunCostInput[]): Promise<Map<string, OwnHostPrice | undefined>> {
        const orgs = [...new Set(runs.filter((r) => r.cellOwner === 'customer').map((r) => r.organizationId))];
        return new Map(await Promise.all(orgs.map(async (org) => [org, await this.ownHostPriceOf(org)] as const)));
    }

    /** The Runs' priced spans, one read per org on the page; unreadable: undefined (the LLM part says "not measured"). */
    private async spendOf(runs: RunCostInput[], now: Date): Promise<Map<string, RuntimeLlmSpendRow[]> | undefined> {
        if (!this.spend) return undefined;
        const out = new Map<string, RuntimeLlmSpendRow[]>();
        if (!runs.length) return out;
        const byOrg = new Map<string, RunCostInput[]>();
        for (const r of runs) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r]);
        try {
            for (const [organizationId, list] of byOrg) {
                const starts = list.map((r) => Date.parse(r.requestedAt ?? r.bootingAt ?? r.startedAt ?? '')).filter(Number.isFinite);
                const ends = list.map((r) => (r.finishedAt ? Date.parse(r.finishedAt) : now.getTime())).filter(Number.isFinite);
                const start = new Date((starts.length ? Math.min(...starts) : now.getTime()) - SPAN_WINDOW_MARGIN_MS);
                const end = new Date((ends.length ? Math.max(...ends) : now.getTime()) + SPAN_WINDOW_MARGIN_MS);
                const rows = await this.spend.spendOf({ organizationId, start, end, runIds: list.map((r) => r.runId) });
                if (!rows) return undefined;
                for (const row of rows) if (row.runId) out.set(row.runId, [...(out.get(row.runId) ?? []), row]);
            }
        } catch (e) {
            this.logger.warn({
                message: 'Runtime Run cost: the usage spans could not be read; the LLM cost is not measured',
                context: RuntimeRunCostService.name,
                error: e instanceof Error ? e : undefined,
            });
            return undefined;
        }
        return out;
    }

    /** The Runs' claim rounds, one read per org on the page; unreadable: none (the machine part says "not priced"). */
    private async claimsOf(runs: Array<Pick<RuntimeRunProjection, 'runId' | 'organizationId'>>): Promise<Map<string, RunClaimUsage[]>> {
        const out = new Map<string, RunClaimUsage[]>();
        if (!this.claims || !runs.length) return out;
        const byOrg = new Map<string, string[]>();
        for (const r of runs) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r.runId]);
        try {
            for (const [org, ids] of byOrg) for (const [runId, list] of await this.claims.claimsOfRuns(org, ids)) out.set(runId, list);
        } catch (e) {
            this.logger.warn({
                message: 'Runtime Run cost: the claims could not be read; the machine cost stays unpriced',
                context: RuntimeRunCostService.name,
                error: e instanceof Error ? e : undefined,
            });
            return new Map();
        }
        return out;
    }
}
