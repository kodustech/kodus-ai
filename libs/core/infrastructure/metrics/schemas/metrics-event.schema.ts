import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({
    collection: 'observability_metrics',
    timestamps: false,
})
export class MetricsEventModel extends Document {
    @Prop({ type: String, required: true, index: true })
    name: string;

    @Prop({
        type: String,
        required: true,
        enum: ['counter', 'histogram', 'gauge'],
    })
    type: string;

    @Prop({ type: Number, required: true })
    value: number;

    @Prop({ type: Object, default: {} })
    labels: Record<string, string>;

    @Prop({
        type: Date,
        required: true,
        index: true,
    })
    recordedAt: Date;
}

export const MetricsEventSchema =
    SchemaFactory.createForClass(MetricsEventModel);

// Compound index for common query patterns
MetricsEventSchema.index({ name: 1, recordedAt: -1 });
MetricsEventSchema.index({
    'name': 1,
    'labels.component': 1,
    'recordedAt': -1,
});
