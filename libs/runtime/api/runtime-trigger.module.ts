import { Module } from '@nestjs/common';

import { RuntimeTriggerConsumer } from './infrastructure/runtime-trigger.consumer';
import { RuntimeApiModule } from './runtime-api.module';

/**
 * The product worker's side of the PR trigger (PR 2): consumes the pull
 * request events the webhook handler wrote and enqueues Runs. Only the worker
 * imports it, so the API never subscribes to the queue.
 */
@Module({
    imports: [RuntimeApiModule],
    providers: [RuntimeTriggerConsumer],
})
export class RuntimeTriggerModule {}
