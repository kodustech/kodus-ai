import { ReviewModeResponse } from '@/config/types/general/codeReview.type';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { ICommit } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
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

    @Prop({ type: Array, required: true })
    public files: Array<{
        id: string;
        sha?: string;
        path: string;
        filename: string;
        previousName: string;
        status: string;
        createdAt: string;
        updatedAt: string;
        added: number;
        deleted: number;
        changes: number;
        reviewMode: ReviewModeResponse,
        codeReviewModelUsed: {
            generateSuggestions: string;
            safeguard: string;
        }
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
                type: String;
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
}

export const PullRequestsSchema =
    SchemaFactory.createForClass(PullRequestsModel);

