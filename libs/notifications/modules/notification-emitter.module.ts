import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { NotificationService } from '../application/notification.service';

/**
 * Lightweight emit-only module. Import this when you only need to emit
 * notifications (e.g. from libs that don't need the full module).
 *
 * Requires MESSAGE_BROKER_SERVICE_TOKEN and OUTBOX_MESSAGE_REPOSITORY_TOKEN
 * to already be available in the DI graph (provided by WorkflowModule).
 */
@Module({
    imports: [ConfigModule],
    providers: [NotificationService],
    exports: [NotificationService],
})
export class NotificationEmitterModule {}
