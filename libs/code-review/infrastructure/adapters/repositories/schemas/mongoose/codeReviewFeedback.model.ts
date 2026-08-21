import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'codeReviewFeedback',
    timestamps: true,
    autoIndex: true,
})
export class CodeReviewFeedbackModel extends CoreDocument {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: Object, required: true })
    reactions: {
        thumbsUp: number;
        thumbsDown: number;
    };

    @Prop({ type: Object, required: true })
    comment: {
        id: number;
        pullRequestReviewId?: string;
    };

    @Prop({ type: Object, required: true })
    pullRequest: {
        id: string;
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    };

    @Prop({ type: String, required: true })
    suggestionId: string;

    @Prop({ type: Boolean, required: false })
    syncedEmbeddedSuggestions: boolean;
}

const CodeReviewFeedbackSchema = SchemaFactory.createForClass(
    CodeReviewFeedbackModel,
);

// Serves the reaction sync on both sides: the read that loads an org's
// feedbacks, and the per-suggestion upsert filter that refreshes counts.
//
// Deliberately NOT unique. It should be — the tuple identifies one feedback,
// and uniqueness is what would close the race where two teams of the same org
// sync the same PR at once. But `autoIndex` builds this on startup, and a
// unique build fails if the collection already carries duplicates from that
// very race. Promoting it needs a dedup check against real data first.
CodeReviewFeedbackSchema.index(
    { organizationId: 1, suggestionId: 1 },
    { name: 'idx_org_suggestion', background: true },
);

export { CodeReviewFeedbackSchema };
