import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { BeforeApplicationShutdown, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { WorkerDrainService } from './worker-drain.service';

/**
 * Proves the order on a real Nest app: WorkerDrainService sits in the root
 * module and the job consumer in a child module, like WorkerModule and the
 * workflow module. Nest runs each phase root first, so the drain service's
 * onApplicationShutdown would run BEFORE a child's onApplicationShutdown;
 * the job drain therefore has to live in beforeApplicationShutdown.
 */
const order: string[] = [];

@Injectable()
class FakeJobConsumer implements BeforeApplicationShutdown {
    async beforeApplicationShutdown(): Promise<void> {
        order.push('drain-jobs-and-release-inbox');
    }
}

@Module({ providers: [FakeJobConsumer] })
class FakeWorkflowModule {}

describe('worker shutdown order', () => {
    it('cancels consumers, then drains jobs, then closes the connection', async () => {
        const amqpConnection = {
            consumerTags: ['tag-code-review'],
            cancelConsumer: jest.fn(async (tag: string) => {
                // The real client knows only registered tags
                if (tag !== 'tag-code-review') {
                    throw new Error(`unknown consumer tag ${tag}`);
                }
                order.push('cancel-consumers');
            }),
            close: jest.fn(async () => {
                order.push('close-connection');
            }),
        };

        @Module({
            imports: [FakeWorkflowModule],
            providers: [
                WorkerDrainService,
                { provide: AmqpConnection, useValue: amqpConnection },
            ],
        })
        class FakeWorkerModule {}

        const moduleRef = await Test.createTestingModule({
            imports: [FakeWorkerModule],
        }).compile();
        const app = moduleRef.createNestApplication();
        await app.init();

        await app.close();

        expect(amqpConnection.cancelConsumer).toHaveBeenCalledWith(
            'tag-code-review',
        );
        expect(order).toEqual([
            'cancel-consumers',
            'drain-jobs-and-release-inbox',
            'close-connection',
        ]);
    });
});
