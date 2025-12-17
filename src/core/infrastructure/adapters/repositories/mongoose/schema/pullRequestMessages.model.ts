import {
    ConfigLevel,
    PullRequestMessageStatus,
    PullRequestMessageType,
} from '@/config/types/general/pullRequestMessages.type';
import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'pullRequestMessages',
    timestamps: true,
    autoIndex: true,
})
export class PullRequestMessagesModel extends CoreDocument {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true, enum: ConfigLevel })
    configLevel: ConfigLevel;

    @Prop({ type: String, required: false })
    repositoryId: string;

    @Prop({
        type: {
            content: { type: String, required: false },
            status: {
                type: String,
                required: true,
                enum: PullRequestMessageStatus,
            },
        },
        _id: false,
        required: false,
    })
    startReviewMessage: {
        content: string;
        status: PullRequestMessageStatus;
    };

    @Prop({
        type: {
            content: { type: String, required: false },
            status: {
                type: String,
                required: true,
                enum: PullRequestMessageStatus,
            },
        },
        _id: false,
        required: false,
    })
    endReviewMessage: {
        content: string;
        status: PullRequestMessageStatus;
    };

    @Prop({ type: String, required: false })
    directoryId: string;

    @Prop({
        type: {
            hideComments: {
                type: Boolean,
                default: false,
                required: false,
            },
            suggestionCopyPrompt: {
                type: Boolean,
                default: true,
                required: false,
            },
        },
        _id: false,
        required: false,
        default: { hideComments: false, suggestionCopyPrompt: true },
    })
    globalSettings: {
        hideComments: boolean;
        suggestionCopyPrompt: boolean;
    };
}

export const PullRequestMessagesSchema = SchemaFactory.createForClass(
    PullRequestMessagesModel,
);

// Composite indexes for common query patterns
PullRequestMessagesSchema.index(
    { organizationId: 1, configLevel: 1 },
    { name: 'idx_org_config_level', background: true },
);

PullRequestMessagesSchema.index(
    { organizationId: 1, repositoryId: 1, configLevel: 1 },
    { name: 'idx_org_repo_config_level', background: true },
);

PullRequestMessagesSchema.index(
    { organizationId: 1, repositoryId: 1, directoryId: 1, configLevel: 1 },
    { name: 'idx_org_repo_dir_config_level', background: true },
);
