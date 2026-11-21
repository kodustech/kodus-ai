import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
    MetricsEventModel,
    MetricsEventSchema,
} from './schemas/metrics-event.schema';
import { MetricsCollectorService } from './metrics-collector.service';

@Global()
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: MetricsEventModel.name, schema: MetricsEventSchema },
        ]),
    ],
    providers: [MetricsCollectorService],
    exports: [MetricsCollectorService, MongooseModule],
})
export class MetricsModule {}
