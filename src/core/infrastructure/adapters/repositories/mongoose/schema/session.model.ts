import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

@Schema({
    collection: 'session',
    timestamps: true,
    autoIndex: true,
})
export class SessionModel extends CoreDocument {
    @Prop({ type: Number })
    public date: number;

    @Prop({ type: String })
    public platformUserId: string;

    @Prop({ type: String, default: '', required: false })
    public platformName: string;

    @Prop({ type: String })
    public route: string;

    @Prop({ type: String, default: null, required: false })
    public organizationId: string;

    @Prop({ type: String, default: null, required: false })
    public teamId: string;
}

const SessionSchema = SchemaFactory.createForClass(SessionModel);

export { SessionSchema };
