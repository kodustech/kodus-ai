/**
 * Metering sweep for "Kodus as the provider".
 *
 * Every LLM call routed by the `kodus` provider leaves a usage span in
 * `observability_telemetry` (`gen_ai.response.model` = `kodus:<catalog id>`,
 * `attributes.tu` with the token split). This service turns those spans into
 * money: it journals each one as a charge at the catalog's list price
 * (`kodus_credit_charges`, unique per span) and debits the batch from the
 * org's prepaid balance in the billing service, idempotently (`usageKey` =
 * `span:<id>`).
 *
 * Why per SPAN, not per review: a review runs for minutes and its spans land
 * as they finish, so billing "per correlationId once" would either wait for a
 * run to end (which the sweep cannot know) or miss the tail. Per span, every
 * record is final the moment it exists; completeness is then a matter of
 * re-reading an overlapping window, and the unique span index makes the
 * overlap free.
 *
 * Why a sweep, not an inline debit at the end of the review: conversation,
 * kody-rules generation and summaries also spend on the provider outside the
 * review pipeline; one path bills them all the same way, and a billing outage
 * costs a retry on the next tick, never a lost charge.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { createLogger } from '@libs/core/log/logger';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { isByokConfig } from '@libs/llm/byok-config';
import { isPlatformFundedProvider } from '@libs/llm/platform-funded-provider';
import { KODUS_CATALOG_PRICES_AS_OF } from '@libs/llm/providers/kodus/catalog';
import { kodusModelUsageCostUsd } from '@libs/llm/providers/kodus/usage-cost';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
    DebitCreditsEntry,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { ObservabilityTelemetryModel } from '@libs/analytics/infrastructure/adapters/repositories/schemas/observabilityTelemetry.model';
import {
    KodusCreditChargeModel,
    KodusCreditSweepStateModel,
} from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';

/** A span is considered settled this long after its timestamp (flush lag). */
export const SWEEP_SETTLE_MS = 2 * 60 * 1000;
/** Re-read this far behind the cursor so late-flushed spans are still caught. */
export const SWEEP_OVERLAP_MS = 15 * 60 * 1000;
/** First sweep for an org looks back this far (older usage is never billed). */
export const SWEEP_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Max spans journaled per org per tick, and max entries per debit call. */
export const SWEEP_SPAN_CAP = 2000;
export const DEBIT_BATCH_SIZE = 500;

/**
 * The usage span stores the model under the literal key `gen_ai.response.model`
 * INSIDE `attributes` — a key that contains dots. Mongo dot-notation cannot
 * address such a key (`attributes.gen_ai.response.model` walks nested docs
 * and matches nothing), so the filter reads it with `$getField` under `$expr`.
 * Verified live on 2026-09-09: the dot path matched 0 of 10 Kodus spans.
 */
const KODUS_ROUTED_SPAN_EXPR = {
    $regexMatch: {
        input: {
            $ifNull: [
                { $getField: { field: 'gen_ai.response.model', input: '$attributes' } },
                '',
            ],
        },
        regex: '^kodus:',
    },
};

export interface SweepSummary {
    organizationId: string;
    spansSeen: number;
    journaled: number;
    debited: number;
    debitedUsd: number;
    unpriced: number;
    failed: number;
    balanceUsd?: number;
}

type TelemetrySpan = {
    _id: unknown;
    correlationId?: string;
    timestamp?: Date;
    attributes?: Record<string, any>;
};

@Injectable()
export class KodusCreditsMeteringService {
    private readonly logger = createLogger(KodusCreditsMeteringService.name);

    constructor(
        @InjectModel(ObservabilityTelemetryModel.name)
        private readonly telemetryModel: Model<ObservabilityTelemetryModel>,
        @InjectModel(KodusCreditChargeModel.name)
        private readonly chargeModel: Model<KodusCreditChargeModel>,
        @InjectModel(KodusCreditSweepStateModel.name)
        private readonly sweepStateModel: Model<KodusCreditSweepStateModel>,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    /** Orgs whose stored BYOK config carries a `kodus` credential. */
    async listOrganizationsWithKodusCredential(): Promise<string[]> {
        const params = await this.organizationParametersService
            .find({ configKey: OrganizationParametersKey.BYOK_CONFIG })
            .catch(() => []);
        const out: string[] = [];
        for (const parameter of params ?? []) {
            const organizationId = parameter.organization?.uuid;
            const config = parameter.configValue;
            if (!organizationId || !isByokConfig(config)) continue;
            const hasKodus = (config.credentials ?? []).some(
                (c) => c && isPlatformFundedProvider(c.provider),
            );
            if (hasKodus) out.push(organizationId);
        }
        return out;
    }

    /** One tick for one org: journal new spans, then debit what is pending. */
    async sweepOrganization(
        organizationId: string,
        now: Date = new Date(),
    ): Promise<SweepSummary> {
        const summary: SweepSummary = {
            organizationId,
            spansSeen: 0,
            journaled: 0,
            debited: 0,
            debitedUsd: 0,
            unpriced: 0,
            failed: 0,
        };

        const upper = new Date(now.getTime() - SWEEP_SETTLE_MS);
        const state = await this.sweepStateModel
            .findOne({ organizationId })
            .lean<{ cursor?: Date }>()
            .exec();
        const cursor = state?.cursor
            ? new Date(new Date(state.cursor).getTime() - SWEEP_OVERLAP_MS)
            : new Date(now.getTime() - SWEEP_INITIAL_LOOKBACK_MS);

        if (cursor >= upper) {
            await this.debitPending(organizationId, summary);
            return summary;
        }

        const spans = (await this.telemetryModel
            .find(
                {
                    'attributes.organizationId': organizationId,
                    'timestamp': { $gt: cursor, $lte: upper },
                    'attributes.tu.total': { $gt: 0 },
                    '$expr': KODUS_ROUTED_SPAN_EXPR,
                },
                {
                    '_id': 1,
                    'correlationId': 1,
                    'timestamp': 1,
                    'attributes.teamId': 1,
                    'attributes.prNumber': 1,
                    'attributes.tu': 1,
                },
            )
            .sort({ timestamp: 1 })
            .limit(SWEEP_SPAN_CAP)
            .lean()
            .exec()) as TelemetrySpan[];

        summary.spansSeen = spans.length;
        let maxTimestamp = cursor;

        for (const span of spans) {
            const tu = span.attributes?.tu;
            const ts = span.timestamp ? new Date(span.timestamp) : null;
            if (!tu || !ts) continue;
            if (ts > maxTimestamp) maxTimestamp = ts;

            const model = String(tu.model ?? '');
            const tokens = {
                input: Number(tu.input ?? 0),
                output: Number(tu.output ?? 0),
                reasoning: Number(tu.reasoning ?? 0),
                cacheRead: Number(tu.cacheRead ?? 0),
                cacheWrite: Number(tu.cacheWrite ?? 0),
            };
            const amountUsd = kodusModelUsageCostUsd(model, tokens);

            try {
                const res = await this.chargeModel.updateOne(
                    { spanId: String(span._id) },
                    {
                        $setOnInsert: {
                            spanId: String(span._id),
                            organizationId,
                            teamId: span.attributes?.teamId ?? undefined,
                            correlationId: span.correlationId,
                            prNumber:
                                typeof span.attributes?.prNumber === 'number'
                                    ? span.attributes.prNumber
                                    : undefined,
                            modelId: model,
                            area: tu.area,
                            route: tu.route,
                            tokens,
                            amountUsd: amountUsd ?? 0,
                            pricingAsOf: KODUS_CATALOG_PRICES_AS_OF,
                            status:
                                amountUsd === null ? 'unpriced' : 'pending',
                            spanAt: ts,
                        },
                    },
                    { upsert: true },
                );
                if ((res as { upsertedCount?: number }).upsertedCount > 0) {
                    summary.journaled += 1;
                    if (amountUsd === null) summary.unpriced += 1;
                }
            } catch (error) {
                summary.failed += 1;
                this.logger.error({
                    message: 'Failed to journal Kodus credit charge',
                    context: KodusCreditsMeteringService.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: { organizationId, spanId: String(span._id) },
                });
            }
        }

        if (summary.unpriced > 0) {
            this.logger.error({
                message:
                    'Kodus-routed usage on a model missing from the price list — journaled as unpriced, NOT debited',
                context: KodusCreditsMeteringService.name,
                metadata: { organizationId, unpriced: summary.unpriced },
            });
        }

        // Advance the cursor only when the window was fully read; a capped read
        // stops at the last span seen so the next tick resumes from there.
        const nextCursor =
            spans.length >= SWEEP_SPAN_CAP ? maxTimestamp : upper;
        await this.sweepStateModel.updateOne(
            { organizationId },
            { $set: { cursor: nextCursor, lastSweepAt: now } },
            { upsert: true },
        );

        await this.debitPending(organizationId, summary);
        return summary;
    }

    /** Debit every `pending` charge, in batches, grouped by team (the license
     *  is per org+team). A batch that fails stays pending for the next tick. */
    private async debitPending(
        organizationId: string,
        summary: SweepSummary,
    ): Promise<void> {
        const pending = (await this.chargeModel
            .find({ organizationId, status: 'pending' })
            .sort({ spanAt: 1 })
            .limit(DEBIT_BATCH_SIZE * 4)
            .lean()
            .exec()) as Array<KodusCreditChargeModel & { _id: unknown }>;
        if (pending.length === 0) return;

        const byTeam = new Map<string, typeof pending>();
        for (const charge of pending) {
            const key = charge.teamId ?? '';
            const list = byTeam.get(key) ?? [];
            list.push(charge);
            byTeam.set(key, list);
        }

        for (const [teamKey, charges] of byTeam) {
            for (let i = 0; i < charges.length; i += DEBIT_BATCH_SIZE) {
                const batch = charges.slice(i, i + DEBIT_BATCH_SIZE);
                const entries: DebitCreditsEntry[] = batch.map((c) => ({
                    usageKey: `span:${c.spanId}`,
                    amountUsd: c.amountUsd,
                    metadata: {
                        model: c.modelId,
                        correlationId: c.correlationId,
                        prNumber: c.prNumber,
                        area: c.area,
                        tokens: c.tokens,
                        spanAt: c.spanAt,
                    },
                }));
                try {
                    const result = await this.licenseService.debitCredits(
                        {
                            organizationId,
                            teamId: teamKey || undefined,
                        } as any,
                        entries,
                    );
                    const debitedAt = new Date();
                    await this.chargeModel.updateMany(
                        { spanId: { $in: batch.map((c) => c.spanId) } },
                        { $set: { status: 'debited', debitedAt } },
                    );
                    summary.debited += batch.length;
                    summary.debitedUsd += batch.reduce(
                        (s, c) => s + (c.amountUsd ?? 0),
                        0,
                    );
                    summary.balanceUsd = result?.balanceUsd;
                } catch (error) {
                    summary.failed += batch.length;
                    const message =
                        error instanceof Error ? error.message : String(error);
                    await this.chargeModel.updateMany(
                        { spanId: { $in: batch.map((c) => c.spanId) } },
                        { $set: { lastError: message } },
                    );
                    this.logger.error({
                        message:
                            'Kodus credit debit failed — charges stay pending for the next sweep',
                        context: KodusCreditsMeteringService.name,
                        error: error instanceof Error ? error : undefined,
                        metadata: {
                            organizationId,
                            teamId: teamKey || undefined,
                            entries: batch.length,
                        },
                    });
                }
            }
        }
    }

    /** Journal read for the UI: recent charges, newest first. */
    async listCharges(
        organizationId: string,
        options: { limit?: number; before?: Date; prNumber?: number } = {},
    ): Promise<KodusCreditChargeModel[]> {
        const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
        const filter: Record<string, unknown> = { organizationId };
        if (options.before) filter.spanAt = { $lt: options.before };
        if (typeof options.prNumber === 'number')
            filter.prNumber = options.prNumber;
        return (await this.chargeModel
            .find(filter)
            .sort({ spanAt: -1 })
            .limit(limit)
            .lean()
            .exec()) as KodusCreditChargeModel[];
    }
}
