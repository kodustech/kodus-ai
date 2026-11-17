import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type {
    EgressProbeClaim,
    EgressProbeRecord,
    EgressProbeStore,
} from '../services/egress-probe/sandbox-egress-probe.service';
import { SandboxEgressProbeModel } from './schemas/sandbox-egress-probe.model';

const DUPLICATE_KEY = 11000;

@Injectable()
export class SandboxEgressProbeRepository implements EgressProbeStore {
    constructor(
        @InjectModel(SandboxEgressProbeModel.name)
        private readonly model: Model<SandboxEgressProbeModel>,
    ) {}

    /**
     * Atomic across workers: the update matches only a document never claimed
     * or claimed before the interval; when it exists but was claimed recently
     * the upsert collides on `_id` and the claim is refused.
     */
    async claim(
        claim: EgressProbeClaim,
        now: Date,
        minIntervalMs: number,
    ): Promise<boolean> {
        const cutoff = new Date(now.getTime() - minIntervalMs);
        try {
            const result = await this.model.updateOne(
                {
                    _id: claim.key,
                    $or: [
                        { lastClaimedAt: { $exists: false } },
                        { lastClaimedAt: { $lt: cutoff } },
                    ],
                },
                {
                    $set: { lastClaimedAt: now },
                    $setOnInsert: {
                        organizationId: claim.organizationId,
                        host: claim.host,
                        platform: claim.platform,
                    },
                },
                { upsert: true },
            );
            return result.modifiedCount + result.upsertedCount > 0;
        } catch (error) {
            if ((error as { code?: number })?.code === DUPLICATE_KEY) {
                return false;
            }
            throw error;
        }
    }

    async record(record: EgressProbeRecord): Promise<void> {
        await this.model.updateOne(
            { _id: record.key },
            {
                $set: {
                    organizationId: record.organizationId,
                    host: record.host,
                    platform: record.platform,
                    ...(record.teamId && { teamId: record.teamId }),
                    lastProbedAt: record.probedAt,
                    lastOutcome: record.outcome,
                    lastReason: record.reason ?? null,
                    lastDetail: record.detail ?? null,
                    lastExitCode: record.exitCode,
                },
                $inc:
                    record.outcome === 'direct_ok'
                        ? { okCount: 1 }
                        : { blockedCount: 1 },
            },
            { upsert: true },
        );
    }
}
