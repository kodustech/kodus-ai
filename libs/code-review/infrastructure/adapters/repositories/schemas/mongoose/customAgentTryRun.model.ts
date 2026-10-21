import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { CustomAgentTryTrace } from '@libs/code-review/domain/custom-agents/contracts';
import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

/** A Try it run, kept while the settings page polls for it (#2172). */
@Schema({
    collection: 'customAgentTryRuns',
    timestamps: true,
    autoIndex: true,
})
export class CustomAgentTryRunModel extends CoreDocument {
    @Prop({ type: String, required: true, unique: true })
    runId: string;

    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true })
    teamId: string;

    @Prop({ type: String, required: true })
    repositoryId: string;

    @Prop({ type: String, required: true })
    status: 'running' | 'done';

    @Prop({ type: Object })
    result?: CustomAgentTryTrace;

    @Prop({ type: Date, required: true })
    startedAt: Date;

    @Prop({ type: Date })
    finishedAt?: Date;

    @Prop({ type: Date, required: true })
    expiresAt: Date;
}

export const CustomAgentTryRunSchema = SchemaFactory.createForClass(
    CustomAgentTryRunModel,
);

// MongoDB deletes a run once expiresAt is reached.
CustomAgentTryRunSchema.index(
    { expiresAt: 1 },
    {
        expireAfterSeconds: 0,
        name: 'idx_custom_agent_try_run_ttl',
        background: true,
    },
);

export const CustomAgentTryRunModelInstance = {
    name: CustomAgentTryRunModel.name,
    schema: CustomAgentTryRunSchema,
};
