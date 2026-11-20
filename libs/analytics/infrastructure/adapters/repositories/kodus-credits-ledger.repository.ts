import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    IKodusCreditsLedgerRepository,
    JournalResult,
    KodusCreditChargeEntry,
    KodusRoutedSpan,
} from '@libs/analytics/domain/credits/contracts/kodus-credits-ledger.repository.contract';
import { MONGO_LONG_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';

import {
    KodusCreditChargeModel,
    KodusCreditSweepStateModel,
} from './schemas/kodusCreditCharge.model';
import { ObservabilityTelemetryModel } from './schemas/observabilityTelemetry.model';

/** A span whose response model is a Kodus one (`kodus:<model>`). */
const KODUS_ROUTED_SPAN_EXPR = {
    $regexMatch: {
        input: {
            $ifNull: [
                {
                    $getField: {
                        field: 'gen_ai.response.model',
                        input: '$attributes',
                    },
                },
                '',
            ],
        },
        regex: '^kodus:',
    },
};

@Injectable()
export class KodusCreditsLedgerRepository implements IKodusCreditsLedgerRepository {
    constructor(
        @InjectModel(ObservabilityTelemetryModel.name)
        private readonly telemetryModel: Model<ObservabilityTelemetryModel>,
        @InjectModel(KodusCreditChargeModel.name)
        private readonly chargeModel: Model<KodusCreditChargeModel>,
        @InjectModel(KodusCreditSweepStateModel.name)
        private readonly sweepStateModel: Model<KodusCreditSweepStateModel>,
    ) {}

    async getSweepCursor(organizationId: string): Promise<Date | undefined> {
        const state = await this.sweepStateModel
            .findOne({ organizationId })
            .lean<{ cursor?: Date }>()
            .exec();
        return state?.cursor ? new Date(state.cursor) : undefined;
    }

    async saveSweepCursor(
        organizationId: string,
        cursor: Date,
        sweptAt: Date,
    ): Promise<void> {
        await this.sweepStateModel.updateOne(
            { organizationId },
            { $set: { cursor, lastSweepAt: sweptAt } },
            { upsert: true },
        );
    }

    async findKodusRoutedSpans(params: {
        organizationId: string;
        after: Date;
        upTo: Date;
        limit: number;
    }): Promise<KodusRoutedSpan[]> {
        // An aggregation, not `find()`: the pipeline is handed to the driver
        // untouched (no schema casting of `$expr` / the undeclared
        // `timestamp` path), as every other telemetry read in libs/analytics.
        return (await this.telemetryModel
            .aggregate([
                {
                    $match: {
                        'attributes.organizationId': params.organizationId,
                        'timestamp': { $gt: params.after, $lte: params.upTo },
                        'attributes.tu.total': { $gt: 0 },
                        '$expr': KODUS_ROUTED_SPAN_EXPR,
                    },
                },
                { $sort: { timestamp: 1 } },
                { $limit: params.limit },
                {
                    $project: {
                        '_id': 1,
                        'correlationId': 1,
                        'timestamp': 1,
                        'attributes.teamId': 1,
                        'attributes.prNumber': 1,
                        'attributes.tu': 1,
                    },
                },
            ])
            .option({ maxTimeMS: MONGO_LONG_QUERY_MAX_TIME_MS })
            .exec()) as KodusRoutedSpan[];
    }

    async journalCharges(
        entries: KodusCreditChargeEntry[],
    ): Promise<JournalResult> {
        // Unordered, one upsert per span: the journal is idempotent on
        // spanId, so a re-read of an overlap window inserts nothing.
        return (await this.chargeModel.bulkWrite(
            entries.map((entry) => ({
                updateOne: {
                    filter: { spanId: entry.spanId },
                    update: { $setOnInsert: entry },
                    upsert: true,
                },
            })) as Parameters<typeof this.chargeModel.bulkWrite>[0],
            { ordered: false },
        )) as JournalResult;
    }

    async findPendingCharges(
        organizationId: string,
        limit: number,
    ): Promise<Array<KodusCreditChargeModel & { _id: unknown }>> {
        return (await this.chargeModel
            .find({ organizationId, status: 'pending' })
            .sort({ spanAt: 1 })
            .limit(limit)
            .lean()
            .exec()) as Array<KodusCreditChargeModel & { _id: unknown }>;
    }

    async markChargesDebited(
        spanIds: string[],
        debitedAt: Date,
    ): Promise<void> {
        // Only a pending charge moves to debited: one another pass already
        // settled keeps its own debitedAt.
        await this.chargeModel.updateMany(
            { spanId: { $in: spanIds }, status: 'pending' },
            { $set: { status: 'debited', debitedAt } },
        );
    }

    async recordChargeError(spanIds: string[], message: string): Promise<void> {
        await this.chargeModel.updateMany(
            { spanId: { $in: spanIds }, status: 'pending' },
            { $set: { lastError: message } },
        );
    }

    async listCharges(
        organizationId: string,
        options: { limit: number; before?: Date; prNumber?: number },
    ): Promise<KodusCreditChargeModel[]> {
        const filter: Record<string, unknown> = { organizationId };
        if (options.before) filter.spanAt = { $lt: options.before };
        if (typeof options.prNumber === 'number')
            filter.prNumber = options.prNumber;
        return (await this.chargeModel
            .find(filter)
            .sort({ spanAt: -1 })
            .limit(options.limit)
            .lean()
            .exec()) as KodusCreditChargeModel[];
    }
}
