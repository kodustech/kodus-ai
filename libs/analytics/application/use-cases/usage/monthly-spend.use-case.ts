import { Inject, Injectable } from '@nestjs/common';

import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import { TokenUsageBreakdown } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import { ManualPricingOverrides } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { buildSpendLimitStatus } from '@libs/analytics/domain/spend-limit/spend-limit-status';
import {
    CredentialSpend,
    ModelSpend,
    MonthlySpendResult,
    RunRateProjection,
    SpendLimitEvaluation,
    UNATTRIBUTED_CREDENTIAL,
} from '@libs/analytics/domain/spend-limit/spend-limit.types';
import { BYOKConfig, isByokConfig } from '@libs/llm/byok-config';

import { CostUsageRow, ModelCostCalculator } from './model-cost-calculator';

/**
 * Month-to-date BYOK spend tracker.
 *
 * Spend is computed live on every call — current usage priced at current
 * catalog rates, never snapshotted. Switching models or a catalog price
 * change therefore re-bases the whole month's figure, which is the intended
 * "always most up to date" behavior for the spend-alert feature.
 *
 * `getStatus` is the seam shared by the alert cron and a future blocking gate
 * (see SpendLimitEvaluation). This service only *computes* — it never sends
 * notifications or blocks.
 */
@Injectable()
export class MonthlySpendUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,
        private readonly modelCostCalculator: ModelCostCalculator,
    ) {}

    async getMonthToDateSpend(
        organizationId: string,
        now: Date = new Date(),
        overrides?: ManualPricingOverrides,
        // The org's v2 BYOK config is passed IN by the caller (the config
        // service already reads it) rather than fetched here — keeping this
        // use-case free of config/org-parameter concerns. Absent / non-v2 ⇒
        // every model rolls up to the `unattributed` credential bucket.
        byokConfig?: BYOKConfig | null,
    ): Promise<MonthlySpendResult> {
        const { start, end, periodKey, monthMs } = this.getMonthRange(now);

        const rows = await this.tokenUsageService.getDailyUsage({
            organizationId,
            start,
            end,
            byok: true,
        });

        const byModel = await this.modelCostCalculator.spendByModel(
            rows as CostUsageRow[],
            overrides,
        );
        const spentUsd = this.roundToCents(
            byModel.reduce((sum, m) => sum + m.spentUsd, 0),
        );

        // Usage-derived model→credential map: keys on the SAME `tu.model` the
        // spend rows use, so attribution no longer drifts against the config
        // model-NAME on versioned response models (the `unattributed` leak).
        const pairs = await this.tokenUsageService.getModelCredentialPairs({
            organizationId,
            start,
            end,
            byok: true,
        });
        const usageCredByModel = new Map<string, string>();
        for (const { model, credentialId } of pairs) {
            if (model && credentialId && !usageCredByModel.has(model)) {
                usageCredByModel.set(model, credentialId);
            }
        }

        return {
            organizationId,
            periodKey,
            spentUsd,
            tokenUsage: this.aggregateTokenUsage(rows),
            byModel,
            byCredential: this.rollupByCredential(
                byModel,
                byokConfig,
                usageCredByModel,
            ),
            runRate: this.computeRunRate(spentUsd, now, start, monthMs),
        };
    }

    /**
     * Per-credential scope, derived IN-APP: map each priced model-name back to
     * its `credentialId` via the config, then sum spend per credential. The
     * usage store has no credentialId dimension (it bakes only `tu.model`), so
     * this is the smaller change — no new pipeline, no backfill.
     *
     * A2 APPROXIMATION: model-name is NOT guaranteed unique across credentials.
     * `validateByokConfigRefs` only gates that each model's `credentialId`
     * resolves and routing refs resolve — it does not forbid two models sharing
     * a model-name string under different credentials. On such a collision the
     * name's whole spend is attributed to the FIRST matching credential
     * (first-wins), which is approximate but never throws. Exact per-credential
     * attribution would need a `credentialId` baked onto the usage span plus a
     * backfill — a deliberately-deferred follow-up, not this plan.
     *
     * Spend whose model-name matches no configured model lands in the
     * `unattributed` bucket rather than being silently dropped.
     */
    private rollupByCredential(
        byModel: ModelSpend[],
        byokConfig?: BYOKConfig | null,
        // Usage-derived `tu.model → credentialId` map (preferred): the usage
        // stamped the credential on the span, so it keys on the SAME model-name
        // the spend rows use. Falls back to the config name-map for spend from
        // legacy usage that predates the stamped credentialId.
        usageCredByModel: Map<string, string> = new Map(),
    ): CredentialSpend[] {
        const modelToCredential = new Map<string, string>();
        if (isByokConfig(byokConfig)) {
            for (const model of byokConfig.models ?? []) {
                const name = model?.model?.trim();
                // first-wins ⇒ approximate on a model-name collision (A2).
                if (name && !modelToCredential.has(name)) {
                    modelToCredential.set(name, model.credentialId);
                }
            }
        }

        const totals = new Map<string, number>();
        for (const { model, spentUsd } of byModel) {
            const credentialId =
                usageCredByModel.get(model) ??
                modelToCredential.get(model) ??
                UNATTRIBUTED_CREDENTIAL;
            totals.set(credentialId, (totals.get(credentialId) ?? 0) + spentUsd);
        }

        return [...totals.entries()].map(([credentialId, sum]) => ({
            credentialId,
            spentUsd: this.roundToCents(sum),
        }));
    }

    /**
     * Extrapolate month-to-date spend to a full month at the current pace:
     * `projectedMonthlyUsd = spentUsd / elapsedFraction`. A readout only — it
     * never gates anything (budget stays alert-only). Projects 0 while no month
     * time has elapsed (first instant of the month) to avoid a divide-by-zero.
     */
    private computeRunRate(
        spentUsd: number,
        now: Date,
        start: Date,
        monthMs: number,
    ): RunRateProjection {
        const elapsedMs = now.getTime() - start.getTime();
        const elapsedFraction = monthMs > 0 ? elapsedMs / monthMs : 0;
        const projectedMonthlyUsd =
            elapsedFraction > 0
                ? this.roundToCents(spentUsd / elapsedFraction)
                : 0;
        return { projectedMonthlyUsd, elapsedFraction };
    }

    /**
     * Evaluate month-to-date spend against a monthly limit. The limit is
     * supplied by the caller (it lives in org config, wired in a later phase)
     * to keep this service free of config concerns.
     */
    async getStatus(
        organizationId: string,
        limitUsd: number,
        now: Date = new Date(),
        overrides?: ManualPricingOverrides,
        byokConfig?: BYOKConfig | null,
    ): Promise<SpendLimitEvaluation> {
        const spend = await this.getMonthToDateSpend(
            organizationId,
            now,
            overrides,
            byokConfig,
        );
        const status = buildSpendLimitStatus(spend.spentUsd, limitUsd);

        return {
            ...status,
            organizationId,
            periodKey: spend.periodKey,
            byModel: spend.byModel,
            byCredential: spend.byCredential,
            runRate: spend.runRate,
        };
    }

    /** First instant of the current UTC month through `now` (month-to-date). */
    private getMonthRange(now: Date): {
        start: Date;
        end: Date;
        periodKey: string;
        /** Length of the whole calendar month in ms (drives the run-rate). */
        monthMs: number;
    } {
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();
        const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
        // First instant of the NEXT month — Date.UTC rolls month 12 → next year.
        const nextMonthStart = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
        const periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;
        return {
            start,
            end: now,
            periodKey,
            monthMs: nextMonthStart.getTime() - start.getTime(),
        };
    }

    private aggregateTokenUsage(rows: CostUsageRow[]): TokenUsageBreakdown {
        const totals: TokenUsageBreakdown = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        };

        for (const row of rows) {
            totals.inputTokens += row.input;
            totals.outputTokens += row.output;
            totals.reasoningTokens += row.outputReasoning;
            totals.cacheReadTokens =
                (totals.cacheReadTokens ?? 0) + (row.cacheRead ?? 0);
            totals.cacheWriteTokens =
                (totals.cacheWriteTokens ?? 0) + (row.cacheWrite ?? 0);
        }

        // outputTokens already includes reasoningTokens for every provider we
        // ship, so total is input + output to avoid double-counting.
        totals.totalTokens = totals.inputTokens + totals.outputTokens;
        return totals;
    }

    private roundToCents(value: number): number {
        return Math.round(value * 100) / 100;
    }
}
