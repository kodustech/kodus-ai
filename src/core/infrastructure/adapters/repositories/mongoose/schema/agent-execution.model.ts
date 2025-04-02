import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';
import { SessionModel } from './session.model';

@Schema({
    collection: 'agentExecution',
    timestamps: true,
    autoIndex: true,
})
export class AgentExecutionModel {
    @Prop({ type: String })
    public agentName: string;

    @Prop({ type: String })
    public teamId: string;

    @Prop({ type: String, default: '', required: false })
    public platformUserId: string;

    @Prop({ type: String, default: '', required: false })
    public platformName: string;

    @Prop({ type: String, default: '', required: false })
    public message: string;

    @Prop({ type: Object, default: {}, required: false })
    public responseMessage: any;

    @Prop({ type: Object, default: {}, required: false })
    public metaData: Record<string, any>;

    @Prop({ type: String, ref: SessionModel.name, required: false })
    public sessionId: string;
}

const AgentExecutionSchema = SchemaFactory.createForClass(AgentExecutionModel);

export { AgentExecutionSchema };
