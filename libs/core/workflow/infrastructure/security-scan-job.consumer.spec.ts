import { RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';

import { SecurityScanJobConsumer } from './security-scan-job.consumer';
import {
    WorkflowJobConsumer,
    WorkflowJobConsumerBase,
} from './workflow-job-consumer.service';

/** The queues a consumer class subscribes to, as RabbitMQ discovery sees them. */
function queuesOf(type: { prototype: object }): string[] {
    const queues: string[] = [];
    for (
        let proto = type.prototype;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto)
    ) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            const handler = Reflect.getMetadata(
                RABBIT_HANDLER,
                (proto as any)[name],
            );
            if (handler?.queue) queues.push(handler.queue);
        }
    }
    return queues.sort();
}

describe('workflow job consumers', () => {
    it('subscribes the code-review worker to every queue but the deep scan', () => {
        const queues = queuesOf(WorkflowJobConsumer);

        expect(queues).not.toContain('workflow.jobs.security_scan.queue');
        expect(queues).toEqual([
            'workflow.jobs.ast_graph_build.queue',
            'workflow.jobs.ast_graph_incremental.queue',
            'workflow.jobs.check_implementation.queue',
            'workflow.jobs.cli_code_review.queue',
            'workflow.jobs.code_review.queue',
            'workflow.jobs.webhook.queue',
        ]);
    });

    it('subscribes the security-scan worker to the deep scan queue only', () => {
        expect(queuesOf(SecurityScanJobConsumer)).toEqual([
            'workflow.jobs.security_scan.queue',
        ]);
    });

    it('keeps the shared handling free of subscriptions', () => {
        expect(queuesOf(WorkflowJobConsumerBase)).toEqual([]);
    });
});
