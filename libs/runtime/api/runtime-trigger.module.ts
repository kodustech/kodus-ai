import { Module } from '@nestjs/common';

import { RuntimeTriggerConsumer } from './infrastructure/runtime-trigger.consumer';
import { RuntimeWebhookReconcilerCron } from './infrastructure/runtime-webhook-reconciler.cron';
import { RuntimeApiModule } from './runtime-api.module';

/**
 * The product worker's side of the PR trigger (PR 2): consumes the pull
 * request events the webhook handler wrote and enqueues Runs. Only the worker
 * imports it, so the API never subscribes to the queue. The lost-webhook
 * reconciler is scheduled here too (off unless RUNTIME_WEBHOOK_RECONCILER_ENABLED=true).
 */
@Module({
    imports: [RuntimeApiModule],
    providers: [RuntimeTriggerConsumer, RuntimeWebhookReconcilerCron],
})
export class RuntimeTriggerModule {}
