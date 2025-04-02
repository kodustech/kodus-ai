import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

@Schema({
    collection: 'log',
    timestamps: true,
    autoIndex: true,
})
export class LogModel extends CoreDocument {
    @Prop({ type: String })
    public timestamp: string;

    @Prop({
        type: String,
        enum: ['info', 'error', 'warn', 'debug', 'verbose'],
        required: true,
    })
    public level: string;

    @Prop({ type: String, required: true })
    public message: string;

    @Prop({ type: String, required: false })
    public stack: string;

    @Prop({ type: Object })
    public metadata: Record<string, any>;

    @Prop({ type: String, required: false })
    public requestId: string;

    @Prop({ type: String, required: false })
    public executionId: string;

    @Prop({ type: String, required: false })
    public serviceName: string;

    @Prop({ type: String, required: false })
    public traceId: string;

    @Prop({ type: String, required: false })
    public spanId: string;

    @Prop({ type: String, required: false })
    public environment: string;
}

const LogSchema = SchemaFactory.createForClass(LogModel);

export { LogSchema };
