import { Model } from 'mongoose';

import type {
    CapacityNumbers,
    SandboxCapacityStore,
} from './sandbox-capacity-gate';

const STATE_ID = 'slots';

/**
 * Tickets and slots in Mongo (schemas in sandbox-capacity.model.ts). Admission
 * is ONE update on the single state document, which Mongo applies atomically:
 * it drops dead slots, and appends this ticket only while fewer than `cap`
 * live slots remain.
 */
export class MongoCapacityStore implements SandboxCapacityStore {
    constructor(
        private readonly tickets: Model<any>,
        private readonly state: Model<any>,
    ) {}

    async enqueue(
        t: { id: string; prKey: string; workerId: string },
        now: Date,
    ): Promise<void> {
        await this.tickets.create({
            _id: t.id,
            prKey: t.prKey,
            workerId: t.workerId,
            createdAt: now,
            heartbeatAt: now,
        });
    }

    async touch(id: string, now: Date): Promise<boolean> {
        const r = await this.tickets.updateOne(
            { _id: id },
            { $set: { heartbeatAt: now } },
        );
        return r.matchedCount > 0;
    }

    async isHead(id: string, deadBefore: Date): Promise<boolean> {
        const head = await this.tickets
            .findOne({ heartbeatAt: { $gte: deadBefore } })
            .sort({ createdAt: 1, _id: 1 })
            .select('_id')
            .lean<{ _id: string }>();
        return head?._id === id;
    }

    async tryAdmit(
        id: string,
        cap: number,
        now: Date,
        deadBefore: Date,
    ): Promise<boolean> {
        const run = () =>
            this.state
                .findOneAndUpdate(
                    { _id: STATE_ID },
                    [
                        {
                            $set: {
                                slots: {
                                    $filter: {
                                        input: { $ifNull: ['$slots', []] },
                                        cond: {
                                            $gte: [
                                                '$$this.heartbeatAt',
                                                deadBefore,
                                            ],
                                        },
                                    },
                                },
                            },
                        },
                        {
                            $set: {
                                slots: {
                                    $cond: [
                                        {
                                            $lt: [
                                                { $size: '$slots' },
                                                cap,
                                            ],
                                        },
                                        {
                                            $concatArrays: [
                                                '$slots',
                                                [
                                                    {
                                                        ticketId: id,
                                                        heartbeatAt: now,
                                                    },
                                                ],
                                            ],
                                        },
                                        '$slots',
                                    ],
                                },
                            },
                        },
                    ],
                    { upsert: true, new: true },
                )
                .lean<{ slots: { ticketId: string }[] }>();
        let doc;
        try {
            doc = await run();
        } catch (e: any) {
            if (e?.code !== 11000) throw e; // two first-ever upserts raced
            doc = await run();
        }
        const admitted = !!doc?.slots?.some((s) => s.ticketId === id);
        if (admitted) await this.tickets.deleteOne({ _id: id });
        return admitted;
    }

    async heartbeatSlot(id: string, now: Date): Promise<void> {
        await this.state.updateOne(
            { _id: STATE_ID, 'slots.ticketId': id },
            { $set: { 'slots.$.heartbeatAt': now } },
        );
    }

    async releaseSlot(id: string): Promise<void> {
        await this.state.updateOne(
            { _id: STATE_ID },
            { $pull: { slots: { ticketId: id } } },
        );
    }

    async removeTicket(id: string): Promise<void> {
        await this.tickets.deleteOne({ _id: id });
    }

    async removeTicketsByPrKey(prKey: string): Promise<number> {
        const r = await this.tickets.deleteMany({ prKey });
        return r.deletedCount ?? 0;
    }

    async numbers(deadBefore: Date): Promise<CapacityNumbers> {
        const [state, queued, oldest] = await Promise.all([
            this.state.findOne({ _id: STATE_ID }).lean<{
                slots?: { heartbeatAt: Date }[];
            }>(),
            this.tickets.countDocuments({ heartbeatAt: { $gte: deadBefore } }),
            this.tickets
                .findOne({ heartbeatAt: { $gte: deadBefore } })
                .sort({ createdAt: 1, _id: 1 })
                .select('createdAt')
                .lean<{ createdAt: Date }>(),
        ]);
        return {
            inUse: (state?.slots ?? []).filter(
                (s) => s.heartbeatAt >= deadBefore,
            ).length,
            queued,
            oldestCreatedAt: oldest?.createdAt ?? null,
        };
    }
}
