import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

import type {
    ReferenceIntent,
    ResolutionAttempt,
    ValidationDoor,
} from '../business-validation.types';
import type {
    OutOfScopeChange,
    RequirementVerdict,
} from '../judge/validation.types';

export interface RunReference {
    kind: string;
    id: string;
    raw: string;
    source: string;
    intent: ReferenceIntent;
}

export interface RunTask {
    tracker: string;
    id: string;
    title?: string;
    url?: string;
    readAt: string;
    updatedAt?: string;
    intent?: ReferenceIntent;
    passed: boolean;
    scopeMismatch?: boolean;
    requirements: RequirementVerdict[];
    outOfScope: OutOfScopeChange[];
    /** The task's text as judged, hashed: a re-check carries acceptances by likeness only onto the same text. */
    textHash?: string;
}

/** The PR comment a run wrote, with the ids each platform needs to edit it. */
export interface RunComment {
    id: number | string;
    /** GitLab: the note inside the discussion. */
    noteId?: number | string;
    /** Azure Repos: the thread the comment opened. */
    threadId?: number | string;
}

/** Who wrote the PR's code, from its commits (UC-42). */
export interface RunAuthor {
    login?: string;
    /** `person`, or the coding agent named in Co-Authored-By trailers. */
    kind: 'person' | 'agent' | 'unknown';
    agent?: string;
}

/**
 * One business-logic validation, whatever door asked for it. What support
 * reads to answer "why didn't it validate?" (UC-43), what the settings card
 * counts (UC-06, UC-07), and what the Cockpit aggregates (UC-42).
 */
@Schema({
    collection: 'businessValidationRuns',
    timestamps: true,
    autoIndex: true,
})
export class BusinessValidationRunModel extends CoreDocument {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: false })
    teamId?: string;

    @Prop({ type: String, required: false })
    repositoryId?: string;

    @Prop({ type: String, required: false })
    repositoryName?: string;

    @Prop({ type: Number, required: false })
    pullRequestNumber?: number;

    @Prop({ type: String, required: false })
    platformType?: string;

    @Prop({ type: String, required: true })
    door: ValidationDoor;

    @Prop({ type: String, required: false })
    trigger?: string;

    @Prop({ type: String, required: false })
    headSha?: string;

    /** `validated`, `task_too_thin`, `task_missing`, `task_required` or `skipped`. */
    @Prop({ type: String, required: true })
    outcome: string;

    /** Why nothing was judged, for `skipped`. */
    @Prop({ type: String, required: false })
    skipReason?: string;

    /** For `validated`: whether the check passed. */
    @Prop({ type: Boolean, required: false })
    passed?: boolean;

    @Prop({ type: [Object], default: [] })
    references: RunReference[];

    @Prop({ type: [Object], default: [] })
    attempts: ResolutionAttempt[];

    @Prop({ type: [String], default: [] })
    trackers: string[];

    @Prop({ type: [Object], default: [] })
    tasks: RunTask[];

    @Prop({ type: [String], default: [] })
    unseenFiles: string[];

    @Prop({ type: Object, required: false })
    author?: RunAuthor;

    /** The PR comment this run wrote or edited. */
    @Prop({ type: Object, required: false })
    comment?: RunComment;

    @Prop({ type: String, required: false })
    checkRunId?: string;

    /** A run skipped because the tracker was down, waiting to be re-checked (UC-22). */
    @Prop({ type: Boolean, required: false })
    pendingRecheck?: boolean;

    /**
     * When the PR was first skipped for a tracker that was down. Each re-check
     * that finds it still down carries this on, so the 24h window closes.
     */
    @Prop({ type: Date, required: false })
    pendingSince?: Date;

    /** The "Test on a pull request" preview this run posted: each one posts once. */
    @Prop({ type: String, required: false })
    previewId?: string;

    /** Set by `timestamps`. */
    createdAt?: Date;
}

export const BusinessValidationRunSchema = SchemaFactory.createForClass(
    BusinessValidationRunModel,
);

BusinessValidationRunSchema.index(
    { organizationId: 1, repositoryId: 1, pullRequestNumber: 1, createdAt: -1 },
    { name: 'idx_pull_request', background: true },
);
BusinessValidationRunSchema.index(
    { organizationId: 1, createdAt: -1 },
    { name: 'idx_org_time', background: true },
);
// Runs are history for the card, the Cockpit and support: a year of it.
BusinessValidationRunSchema.index(
    { createdAt: 1 },
    { name: 'ttl_created_at', expireAfterSeconds: 365 * 24 * 60 * 60 },
);
BusinessValidationRunSchema.index(
    { pendingRecheck: 1, createdAt: -1 },
    {
        name: 'idx_pending_recheck',
        background: true,
        partialFilterExpression: { pendingRecheck: true },
    },
);

export const BusinessValidationRunModelInstance = {
    name: BusinessValidationRunModel.name,
    schema: BusinessValidationRunSchema,
};
// One run per posted preview: a second post of the same seal is refused.
BusinessValidationRunSchema.index(
    { previewId: 1 },
    {
        name: 'uniq_preview_id',
        unique: true,
        partialFilterExpression: { previewId: { $exists: true } },
    },
);
