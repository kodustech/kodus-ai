import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type {
    CustomAgentRunRecord,
    ICustomAgentRunLog,
} from '@libs/code-review/domain/custom-agents/contracts';

import { CustomAgentRunModel } from './schemas/mongoose/customAgentRun.model';

/** How long a run outcome is kept: longer than the page's 30-day window. */
export const CUSTOM_AGENT_RUN_TTL_MS = 45 * 24 * 60 * 60 * 1000;

/** At most this many runs are read for one repository's page. */
const MAX_RUNS_READ = 2000;

@Injectable()
export class CustomAgentRunRepository implements ICustomAgentRunLog {
    constructor(
        @InjectModel(CustomAgentRunModel.name)
        private readonly model: Model<CustomAgentRunModel>,
    ) {}

    async record(runs: CustomAgentRunRecord[]): Promise<void> {
        if (!runs.length) return;
        await this.model.insertMany(
            runs.map((run) => ({
                ...run,
                expiresAt: new Date(run.at.getTime() + CUSTOM_AGENT_RUN_TTL_MS),
            })),
            { ordered: false },
        );
    }

    async listSince(params: {
        organizationId: string;
        repositoryId: string;
        since: Date;
    }): Promise<CustomAgentRunRecord[]> {
        const docs = await this.model
            .find(
                {
                    organizationId: params.organizationId,
                    repositoryId: params.repositoryId,
                    at: { $gte: params.since },
                },
                {
                    _id: 0,
                    organizationId: 1,
                    repositoryId: 1,
                    prNumber: 1,
                    agentId: 1,
                    status: 1,
                    reason: 1,
                    at: 1,
                },
            )
            // `_id` breaks ties so the capped cut is the same on every read.
            .sort({ at: -1, _id: -1 })
            .limit(MAX_RUNS_READ)
            .lean<CustomAgentRunRecord[]>()
            .exec();
        return docs;
    }
}
