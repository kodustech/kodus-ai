import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { WebhookEnqueueModule } from './webhook-enqueue.module';

@Module({
    imports: [
        // Cascade: .env.local (per-dev overrides) wins, .env (team
        // baseline from `yarn env:pull`) provides the rest. See
        // libs/shared/infrastructure/shared-config.module.ts.
        ConfigModule.forRoot({ envFilePath: ['.env.local', '.env'] }),
        EventEmitterModule.forRoot(),
        WebhookEnqueueModule,
    ],
})
export class WebhookHandlerBaseModule {}
