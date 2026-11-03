import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

/**
 * How a custom agent run on a pull request ended: status and reason, never a
 * finding or a provider message. Read by the agent's page to say it is
 * failing and why.
 */
@Schema({
    collection: 'customAgentRuns',
    timestamps: false,
    autoIndex: true,
})
export class CustomAgentRunModel extends CoreDocument {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true })
    repositoryId: string;

    @Prop({ type: Number, required: true })
    prNumber: number;

    @Prop({ type: String, required: true })
    agentId: string;

    @Prop({ type: String, required: true })
    status: 'ran' | 'failed' | 'incomplete';

    @Prop({ type: String })
    reason?: string;

    @Prop({ type: Date, required: true })
    at: Date;

    @Prop({ type: Date, required: true })
    expiresAt: Date;
}

export const CustomAgentRunSchema =
    SchemaFactory.createForClass(CustomAgentRunModel);

// The agent page reads one repository's runs over a window, newest first.
CustomAgentRunSchema.index(
    { organizationId: 1, repositoryId: 1, at: -1 },
    { name: 'idx_custom_agent_run_repository_at', background: true },
);

// MongoDB deletes a run once expiresAt is reached.
CustomAgentRunSchema.index(
    { expiresAt: 1 },
    {
        expireAfterSeconds: 0,
        name: 'idx_custom_agent_run_ttl',
        background: true,
    },
);

export const CustomAgentRunModelInstance = {
    name: CustomAgentRunModel.name,
    schema: CustomAgentRunSchema,
};
