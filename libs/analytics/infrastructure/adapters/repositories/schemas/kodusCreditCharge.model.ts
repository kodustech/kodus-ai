import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

export type KodusCreditChargeStatus =
    | 'pending'
    | 'debited'
    | 'unpriced'
    | 'failed';

/**
 * The metering journal for "Kodus as the provider": one row per LLM-usage span
 * routed by the `kodus` provider, priced at the catalog's list rate. The
 * billing service's ledger is the money truth; this collection records WHAT
 * was billed and WHY (which span, model, tokens, PR), so the ledger's
 * `usageKey` (`span:<id>`) can always be traced back, and the UI can show
 * per-PR / per-review cost without a round-trip to billing.
 *
 * `spanId` is unique: the sweep re-reads an overlapping window on purpose (late
 * spans), and the unique index makes a re-read a no-op instead of a double
 * charge — the same idempotency the ledger enforces on its side.
 */
@Schema({
    collection: 'kodus_credit_charges',
    timestamps: true,
})
export class KodusCreditChargeModel extends CoreDocument {
    @Prop({ type: String, required: true, unique: true })
    spanId: string;

    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String })
    teamId?: string;

    @Prop({ type: String })
    correlationId?: string;

    @Prop({ type: Number })
    prNumber?: number;

    /** Catalog id (`anthropic/claude-sonnet-5`) — also the price-list key.
     *  Named `modelId` because `model` is taken by the mongoose Document. */
    @Prop({ type: String, required: true })
    modelId: string;

    @Prop({ type: String })
    area?: string;

    @Prop({ type: String })
    route?: string;

    @Prop({ type: Object, required: true })
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
    };

    /** List-price cost of this span, USD (6 decimals). */
    @Prop({ type: Number, required: true })
    amountUsd: number;

    /** Which price list produced `amountUsd` (KODUS_CATALOG_PRICES_AS_OF). */
    @Prop({ type: String })
    pricingAsOf?: string;

    @Prop({ type: String, required: true, default: 'pending' })
    status: KodusCreditChargeStatus;

    /** When the span happened (the telemetry `timestamp`), not when we saw it. */
    @Prop({ type: Date, required: true })
    spanAt: Date;

    @Prop({ type: Date })
    debitedAt?: Date;

    @Prop({ type: String })
    lastError?: string;
}

export const KodusCreditChargeModelSchema = SchemaFactory.createForClass(
    KodusCreditChargeModel,
);

KodusCreditChargeModelSchema.index(
    { organizationId: 1, status: 1, spanAt: 1 },
    { background: true },
);
KodusCreditChargeModelSchema.index(
    { organizationId: 1, spanAt: -1 },
    { background: true },
);

/**
 * Per-org sweep cursor: the `timestamp` up to which spans have been journaled.
 * The sweep re-reads from `cursor - overlap` so a span flushed late is still
 * caught; the unique `spanId` above absorbs the overlap.
 */
@Schema({
    collection: 'kodus_credit_sweep_state',
    timestamps: true,
})
export class KodusCreditSweepStateModel extends CoreDocument {
    @Prop({ type: String, required: true, unique: true })
    organizationId: string;

    @Prop({ type: Date, required: true })
    cursor: Date;

    @Prop({ type: Date })
    lastSweepAt?: Date;
}

export const KodusCreditSweepStateModelSchema = SchemaFactory.createForClass(
    KodusCreditSweepStateModel,
);
