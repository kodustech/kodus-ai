import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

@Schema({
    collection: 'observability_telemetry',
    timestamps: true,
})
export class ObservabilityTelemetryModel extends CoreDocument {
    @Prop({ type: String, required: true })
    name: string;

    @Prop({ type: String, required: true })
    correlationId: string;

    @Prop({ type: Number, required: true })
    duration: number;

    @Prop({ type: Object, required: true })
    attributes: Record<string, any>;
}

export const ObservabilityTelemetryModelSchema = SchemaFactory.createForClass(
    ObservabilityTelemetryModel,
);

// Indexes for token usage / analytics queries. These MUST be keyed on
// `timestamp` (the span's event time, written by the @kodus/flow exporter) —
// NOT the Mongoose `timestamps: true` `createdAt`. Every read filters on
// `timestamp`, so a `createdAt` index is dead weight the planner never uses.
// (The index-covered Token Usage path uses the `tu_cover_*` indexes built by
// the TokenUsageTuMongo migration; these support the count/fallback path and
// other org+time analytics.)
ObservabilityTelemetryModelSchema.index(
    { 'attributes.organizationId': 1, timestamp: -1 },
    { background: true },
);
ObservabilityTelemetryModelSchema.index(
    {
        'attributes.organizationId': 1,
        'attributes.prNumber': 1,
        timestamp: -1,
    },
    { background: true },
);
