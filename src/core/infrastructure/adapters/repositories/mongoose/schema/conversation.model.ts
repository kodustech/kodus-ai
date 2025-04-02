import { SenderType } from '@/core/domain/conversation/enum/SenderType';
import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { SessionModel } from './session.model';

@Schema({
    collection: 'conversations',
    timestamps: true,
    autoIndex: true,
})
export class ConversationModel extends CoreDocument {
    @Prop({ required: true, type: String })
    public title: string;

    @Prop({ type: String, ref: SessionModel.name, required: true })
    public sessionId: string;

    @Prop({ required: true, enum: SenderType })
    public type: SenderType;

    @Prop({ type: Date })
    public createdAt?: Date;

    @Prop({ type: Date })
    public updatedAt?: Date;
}

export type ConversationDocument = ConversationModel & Document;

export const ConversationSchema = SchemaFactory.createForClass(ConversationModel);
