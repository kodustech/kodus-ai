import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { CliSessionDecisionType } from '@libs/cli-review/domain/types/cli-session-capture.types';

export enum CliSessionClassificationStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    SKIPPED = 'SKIPPED',
}

@Schema({ _id: false })
class CliSessionToolUseModel {
    @Prop({ type: String, required: true })
    tool: string;

    @Prop({ type: String, required: false })
    filePath?: string;

    @Prop({ type: String, required: false })
    summary?: string;
}

@Schema({ _id: false })
class CliSessionSignalsModel {
    @Prop({ type: String, required: false })
    sessionId?: string;

    @Prop({ type: String, required: false })
    turnId?: string;

    @Prop({ type: String, required: false })
    prompt?: string;

    @Prop({ type: String, required: false })
    assistantMessage?: string;

    @Prop({ type: [String], required: true, default: [] })
    modifiedFiles: string[];

    @Prop({
        type: [SchemaFactory.createForClass(CliSessionToolUseModel)],
        required: true,
        default: [],
    })
    toolUses: CliSessionToolUseModel[];
}

@Schema({ _id: false })
class CliSessionDecisionModel {
    @Prop({
        type: String,
        required: true,
        enum: [
            'architectural_decision',
            'convention',
            'tradeoff',
            'implementation_detail',
            'tooling',
            'other',
        ],
    })
    type: CliSessionDecisionType;

    @Prop({ type: String, required: true })
    decision: string;

    @Prop({ type: String, required: false })
    rationale?: string;

    @Prop({ type: Number, required: false })
    confidence?: number;

    @Prop({ type: [String], required: false, default: [] })
    evidence?: string[];

    @Prop({ type: Boolean, required: false, default: false })
    autoPromoteCandidate?: boolean;
}

@Schema({
    collection: 'cliSessionCaptures',
    timestamps: true,
    autoIndex: true,
})
export class CliSessionCaptureModel extends CoreDocument {
    @Prop({ type: String, required: true })
    captureId: string;

    @Prop({ type: String, required: true })
    dedupKey: string;

    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true })
    teamId: string;

    @Prop({ type: String, required: true })
    branch: string;

    @Prop({ type: String, required: false, default: null })
    sha: string | null;

    @Prop({ type: String, required: false, default: null })
    orgRepo: string | null;

    @Prop({ type: String, required: true })
    agent: string;

    @Prop({ type: String, required: true })
    event: string;

    @Prop({
        type: SchemaFactory.createForClass(CliSessionSignalsModel),
        required: true,
    })
    signals: CliSessionSignalsModel;

    @Prop({ type: String, required: false })
    summary?: string;

    @Prop({ type: Date, required: true })
    capturedAt: Date;

    @Prop({ type: MongooseSchema.Types.Mixed, required: true })
    rawPayload: Record<string, unknown>;

    @Prop({
        type: String,
        enum: Object.values(CliSessionClassificationStatus),
        default: CliSessionClassificationStatus.PENDING,
        required: true,
    })
    classificationStatus: CliSessionClassificationStatus;

    @Prop({
        type: [SchemaFactory.createForClass(CliSessionDecisionModel)],
        required: true,
        default: [],
    })
    decisions: CliSessionDecisionModel[];

    @Prop({ type: String, required: false, default: null })
    classificationError?: string | null;

    @Prop({ type: Date, required: false, default: null })
    classifiedAt?: Date | null;

    @Prop({ type: String, required: false, default: null })
    classificationSource?: string | null;
}

export const CliSessionCaptureSchema = SchemaFactory.createForClass(
    CliSessionCaptureModel,
);

CliSessionCaptureSchema.index(
    { dedupKey: 1 },
    { unique: true, name: 'uniq_cli_session_capture_dedup' },
);

CliSessionCaptureSchema.index(
    { captureId: 1 },
    { unique: true, name: 'uniq_cli_session_capture_id' },
);

CliSessionCaptureSchema.index(
    { organizationId: 1, orgRepo: 1, branch: 1, capturedAt: -1 },
    { name: 'idx_cli_session_capture_org_repo_branch_capturedAt' },
);
