import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HistoricalAreaPullRequest } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';

@Schema({ collection: 'codeAreaHistoryPrs', timestamps: true })
export class CodeAreaHistoryPrModel implements HistoricalAreaPullRequest {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true })
    repositoryId: string;

    @Prop({ type: Number, required: true })
    number: number;

    @Prop({ type: String, required: true })
    url: string;

    @Prop({ type: String, required: true })
    title: string;

    @Prop({ type: String, required: true })
    mergedAt: string;

    @Prop({ type: [String], default: null })
    linkedBugIssues: string[] | null;

    @Prop({ type: [String], required: true })
    files: string[];

    @Prop({ type: Boolean, required: true })
    filesComplete: boolean;
}

export const CodeAreaHistoryPrSchema = SchemaFactory.createForClass(
    CodeAreaHistoryPrModel,
);

CodeAreaHistoryPrSchema.index(
    { organizationId: 1, repositoryId: 1, number: 1 },
    { unique: true, name: 'organization_repository_history_pr' },
);

@Schema({ collection: 'codeAreaHistorySync', timestamps: true })
export class CodeAreaHistorySyncModel {
    @Prop({ type: Number, default: 3 })
    version: number;

    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true })
    repositoryId: string;

    @Prop({ type: String, required: true })
    source: string;

    @Prop({ type: String, required: true })
    windowStart: string;

    @Prop({ type: String, required: true })
    windowEnd: string;

    @Prop({ type: String, required: true })
    cursorEnd: string;

    @Prop({ type: String, required: true })
    scanFloor: string;

    @Prop({ type: Number, default: 0 })
    offset: number;

    @Prop({ type: [Number], default: null })
    windowPrNumbers: number[] | null;

    @Prop({ type: Number, default: 0 })
    discoveredMergedPrs: number;

    @Prop({ type: Boolean, default: false })
    sampled: boolean;

    @Prop({ type: Boolean, default: false })
    complete: boolean;
}

export const CodeAreaHistorySyncSchema = SchemaFactory.createForClass(
    CodeAreaHistorySyncModel,
);

CodeAreaHistorySyncSchema.index(
    { organizationId: 1, repositoryId: 1 },
    { unique: true, name: 'organization_repository_area_sync' },
);
