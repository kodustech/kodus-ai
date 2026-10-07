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

    /** `validated`, `task_too_thin`, `task_missing` or `skipped`. */
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
