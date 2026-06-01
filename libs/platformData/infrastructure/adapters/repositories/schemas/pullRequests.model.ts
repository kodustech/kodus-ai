import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ICommit } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { ReviewModeResponse } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'pullRequests',
    timestamps: true,
    autoIndex: true,
})
export class PullRequestsModel extends CoreDocument {
    @Prop({ type: String, required: true })
    public title: string;

    @Prop({ type: String, required: false })
    public status: string;

    @Prop({ type: Number, required: true })
    public number: number;

    @Prop({ type: Boolean, required: false })
    public merged: boolean;

    @Prop({ type: String, required: false })
    public url: string;

    @Prop({ type: String, required: false })
    public baseBranchRef: string;

    @Prop({ type: String, required: false })
    public headBranchRef: string;

    @Prop({ type: String, required: false })
    public openedAt: string;

    @Prop({ type: String, required: false })
    public closedAt: string;

    @Prop({ type: Object, required: false })
    public repository: {
        id: string;
        name: string;
        fullName: string;
        language: string;
        url: string;
        createdAt: string;
        updatedAt: string;
    };

    // files is optional with a default of [] so partial updates
    // (e.g. bumping status/merged without re-sending the full payload)
    // do not crash with "Path 'files' is required" validation errors.
    @Prop({ type: Array, required: false, default: [] })
    public files: Array<{
        id: string;
        sha?: string;
        path: string;
        filename: string;
        previousName: string;
        status: string;
        createdAt: string;
        updatedAt: string;
        added?: number;
        deleted?: number;
        changes?: number;
        reviewMode: ReviewModeResponse;
        codeReviewModelUsed: {
            generateSuggestions: string;
            safeguard: string;
        };
        suggestions: Array<{
            id: string;
            relevantFile: string;
            language: string;
            suggestionContent: string;
            existingCode: string;
            improvedCode: string;
            oneSentenceSummary: string;
            relevantLinesStart: number;
            relevantLinesEnd: number;
            label: string;
            severity: string;
            rankScore: number;
            priorityStatus: PriorityStatus;
            deliveryStatus: DeliveryStatus;
            implementationStatus: {
                type: string;
                default: 'not_implemented';
                enum: [
                    'implemented',
                    'partially_implemented',
                    'not_implemented',
                ];
            };
            comment: {
                id: number;
                pullRequestReviewId: number;
            };
            createdAt: string;
            updatedAt: string;
        }>;
    }>;

    @Prop({ type: Number, required: false })
    public totalAdded: number;

    @Prop({ type: Number, required: false })
    public totalDeleted: number;

    @Prop({ type: Number, required: false })
    public totalChanges: number;

    @Prop({ type: String, required: false })
    public provider: string;

    @Prop({ type: Object, required: false })
    public user: {
        id: string;
        username: string;
    };

    @Prop({ type: Array, required: false })
    public reviewers: Array<{
        id: string;
        username: string;
    }>;

    @Prop({ type: Array, required: false })
    public assignees: Array<{
        id: string;
        username: string;
    }>;

    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: Array, required: false })
    public commits: Array<ICommit>;

    @Prop({ type: Boolean, required: false })
    public syncedEmbeddedSuggestions: boolean;

    @Prop({ type: Boolean, required: false })
    public syncedWithIssues: boolean;

    @Prop({ type: Array, required: false })
    public prLevelSuggestions: Array<{
        id: string;
        suggestionContent: string;
        oneSentenceSummary: string;
        label: LabelType;
        severity?: SeverityLevel;
        brokenKodyRulesIds?: string[];
        priorityStatus?: PriorityStatus;
        deliveryStatus: DeliveryStatus;
        comment?: {
            id: number;
            pullRequestReviewId: number;
        };
        createdAt?: string;
        updatedAt?: string;
    }>;

    @Prop({ type: Boolean, required: true, default: false })
    public isDraft: boolean;
}

export const PullRequestsSchema =
    SchemaFactory.createForClass(PullRequestsModel);

// Índice único para prevenir duplicação de PRs
// Garante que não haverá dois PRs com mesmo número + repositório + organização
// Usa repository.id (imutável) ao invés de name (pode ser renomeado)
PullRequestsSchema.index(
    { 'number': 1, 'repository.id': 1, 'organizationId': 1 },
    {
        unique: true,
        sparse: false,
        name: 'number_1_repository.id_1_organizationId_1',
    },
);

// Índice de busca por repository.name (para queries que usam nome)
PullRequestsSchema.index(
    { 'number': 1, 'repository.name': 1, 'organizationId': 1 },
    { name: 'idx_number_repo_name_org' },
);

// Watermark da ingestão analítica varre por `(updatedAt, _id)` ASC como
// tupla — ver `PullRequestIngestionService.readWatermark` pra racional.
// Compound `{ updatedAt: 1, _id: 1 }` serve tanto o filtro range quanto
// o sort sem in-memory sort.
// Em prod criar `{ background: true }` antes de virar a flag do cockpit
// (autoIndex pode travar startup em coleções grandes).
PullRequestsSchema.index(
    { updatedAt: 1, _id: 1 },
    { name: 'idx_updatedAt_for_analytics_ingestion' },
);

// Backfill chunked walks `createdAt` ASC in fixed windows (each PR lands
// in exactly one window). Without this index the per-window query falls
// back to in-memory sort and risks blowing memory on large collections.
PullRequestsSchema.index(
    { createdAt: 1 },
    { name: 'idx_createdAt_for_analytics_backfill' },
);
