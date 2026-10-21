import {
    ChangedData,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'codeReviewSettingsLog',
    timestamps: true,
    autoIndex: true,
})
export class CodeReviewSettingsLogModel extends CoreDocument {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: false })
    teamId: string;

    @Prop({ type: String, required: true, enum: ActionType })
    action: ActionType;

    @Prop({ type: Object, required: true })
    userInfo: {
        userId: string;
        userEmail: string;
    };

    @Prop({ type: String, required: false, enum: ConfigLevel })
    configLevel: ConfigLevel;

    @Prop({ type: Object, required: false })
    repository: {
        id: string;
        name?: string;
    };

    @Prop({ type: Object, required: false })
    directory: {
        id: string;
        path?: string;
    };

    @Prop({ type: [Object], required: true })
    changedData: ChangedData[];
}

export const CodeReviewSettingsLogSchema = SchemaFactory.createForClass(
    CodeReviewSettingsLogModel,
);

// The activity log reads `find({ organizationId, ... }).sort({ createdAt: -1 })`
// (CodeReviewSettingsLogRepository.find). Without this the collection had only
// `_id`, so every read was a full collection scan plus an in-memory sort.
CodeReviewSettingsLogSchema.index(
    { organizationId: 1, createdAt: -1 },
    { name: 'idx_org_createdAt', background: true },
);
