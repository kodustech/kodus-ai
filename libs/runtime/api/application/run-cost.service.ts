import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import type { RuntimeLlmSpendRow } from '../domain/llm-spend';
import {
    type Clock,
    RUNTIME_API_CONFIG,
    RUNTIME_CLAIM_USAGE_READER,
    RUNTIME_CLOCK,
    RUNTIME_LLM_SPEND_READER,
    type RuntimeApiConfig,
    type RuntimeClaimUsageReader,
    type RuntimeLlmSpendReader,
} from '../domain/ports';
import { estimateRunCost, type RunClaimUsage, type RuntimeRunCost } from '../domain/run-cost';

/** Spans are stamped when a call ends: the window around the Runs reaches every call of theirs. */
const SPAN_WINDOW_MARGIN_MS = 60 * 60_000;

export type RunCostInput = Pick<RuntimeRunProjection, 'runId' | 'organizationId' | 'requestedAt' | 'bootingAt' | 'startedAt' | 'finishedAt' | 'cellOwner'>;

/**
 * The cost of Runs (§13 PR 5) for the Run page, the Run list and the usage
 * report: one read of the Runs' usage spans and one of their claims per org
 * for the whole page. A part that cannot be read leaves that part null
 * ("not measured" / "not priced"); the Run still loads.
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
    ) {}

    /** `known.claims`: the Runs' claims the caller already read (the usage report), instead of reading them again. */
    async forRuns(runs: RunCostInput[], known: { claims?: ReadonlyMap<string, RunClaimUsage[]> } = {}): Promise<Map<string, RuntimeRunCost>> {
        const now = this.now();
        const [spend, claims] = await Promise.all([this.spendOf(runs, now), known.claims ?? this.claimsOf(runs)]);
        const cellPrices = this.config?.cellPrices ?? {};
        const cellPriceOf = (cellId: string) => cellPrices[cellId] ?? null;
        return new Map(
            runs.map((run) => [run.runId, estimateRunCost({ run, spend: spend ? (spend.get(run.runId) ?? []) : undefined, claims: claims.get(run.runId), cellPriceOf, now })]),
        );
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
