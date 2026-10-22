import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import type {
    CustomAgentTryRun,
    CustomAgentTryTrace,
    ICustomAgentTryRunStore,
} from '@libs/code-review/domain/custom-agents/contracts';

import { CustomAgentTryRunModel } from './schemas/mongoose/customAgentTryRun.model';

/** How long a Try it run stays readable after it starts. */
export const CUSTOM_AGENT_TRY_RUN_TTL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class CustomAgentTryRunRepository implements ICustomAgentTryRunStore {
    constructor(
        @InjectModel(CustomAgentTryRunModel.name)
        private readonly model: Model<CustomAgentTryRunModel>,
    ) {}

    async create(run: Omit<CustomAgentTryRun, 'id'>): Promise<string> {
        const runId = uuidv4();
        await this.model.create({
            ...run,
            runId,
            expiresAt: new Date(
                run.startedAt.getTime() + CUSTOM_AGENT_TRY_RUN_TTL_MS,
            ),
        });
        return runId;
    }

    async finish(id: string, result: CustomAgentTryTrace): Promise<void> {
        await this.model
            .updateOne(
                { runId: id },
                { $set: { status: 'done', result, finishedAt: new Date() } },
            )
            .exec();
    }

    async find(id: string): Promise<CustomAgentTryRun | null> {
        const doc = await this.model
            .findOne({ runId: id })
            .lean<CustomAgentTryRunModel>()
            .exec();
        if (!doc) {
            return null;
        }
        return {
            id: doc.runId,
            organizationId: doc.organizationId,
            teamId: doc.teamId,
            repositoryId: doc.repositoryId,
            status: doc.status,
            result: doc.result,
            startedAt: doc.startedAt,
            finishedAt: doc.finishedAt,
        };
    }
}
