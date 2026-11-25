import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({
    collection: 'ruleLikes',
    timestamps: true,
})
export class RuleLikeModel extends CoreDocument {
    @Prop({ type: String, required: true, index: true })
    public ruleId: string;

    @Prop({ type: String, required: false, index: true })
    public userId?: string;

    @Prop({
        type: String,
        required: true,
        enum: ['positive', 'negative'],
        index: true,
    })
    public feedback: 'positive' | 'negative';
}

export type RuleLikeDocument = RuleLikeModel & Document;
export const RuleLikeSchema = SchemaFactory.createForClass(RuleLikeModel);

RuleLikeSchema.index({ ruleId: 1, userId: 1 }, { unique: true, sparse: true });
