import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
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

export { CodeReviewFeedbackSchema };
