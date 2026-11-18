import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

@Schema({
    collection: 'interaction',
    timestamps: true,
})
export class InteractionModel extends CoreDocument {
    @Prop({ type: Date, default: Date.now })
    public interactionDate: Date;

    @Prop({
        type: String,
    })
    public platformUserId: string;

    @Prop({ type: String })
    public teamId: string;

    @Prop({ type: String })
    public organizationId: string;

    @Prop({ type: String })
    public interactionType: string; // 'chat' or 'button'

    @Prop({ type: String, default: '', required: false })
    public interactionCommand: string; // Command typed for chat interactions

    @Prop({ type: String, default: '', required: false })
    public buttonLabel: string; // Button text for button interactions
}

const InteractionSchema = SchemaFactory.createForClass(InteractionModel);

export { InteractionSchema };
