import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

@Schema({
    collection: 'interaction',
    timestamps: true,
    autoIndex: true,
})
export class InteractionModel {
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
