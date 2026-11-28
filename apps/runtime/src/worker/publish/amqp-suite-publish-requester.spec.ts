import { RUNTIME_EXCHANGE, RUNTIME_PUBLISH_ROUTING_KEY, SUITE_PUBLISH_EVENT, suitePublishKey, type RuntimeSuitePublishRequested } from '@libs/runtime/run';

import { PUBLISH_CONFIRM_TIMEOUT_MS } from './amqp-publish-requester';
import { AmqpSuitePublishRequester } from './amqp-suite-publish-requester';

const ID = '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11';
const msg = (): RuntimeSuitePublishRequested => ({
    suiteRunId: ID, targetId: ID, attempt: 1, key: suitePublishKey(ID, 'final'), correlationId: `suite-${ID}`, check: { status: 'completed', conclusion: 'success' },
    report: { state: 'passed', mode: 'ci', mainSha: 'a'.repeat(40), selection: { mode: 'full', total: 1 }, totals: { passed: 1, failed: 0, skipped: 0, notRun: 0 }, classes: { regression: 0, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 }, annotations: [], annotationsOmitted: 0, requestedAt: '2026-11-23T12:00:00.000Z' },
});

describe('AmqpSuitePublishRequester', () => {
    it('publishes the suite publication on the Runtime publish route, keyed by its key, and waits for the broker to confirm', async () => {
        const publish = jest.fn(async () => true);
        await new AmqpSuitePublishRequester({ publish } as any).request(msg());
        expect(publish).toHaveBeenCalledWith(RUNTIME_EXCHANGE, RUNTIME_PUBLISH_ROUTING_KEY, expect.objectContaining({ event_name: SUITE_PUBLISH_EVENT, messageId: msg().key }), expect.objectContaining({ messageId: msg().key, persistent: true, timeout: PUBLISH_CONFIRM_TIMEOUT_MS }));
    });

    it('refuses a message that breaks the contract before it reaches the broker, and lets a broker that does not confirm fail the step', async () => {
        const publish = jest.fn(async () => Promise.reject(new Error('nack')));
        const requester = new AmqpSuitePublishRequester({ publish } as any);
        await expect(requester.request({ ...msg(), check: { status: 'completed' } } as any)).rejects.toThrow();
        expect(publish).not.toHaveBeenCalled();
        await expect(requester.request(msg())).rejects.toThrow('nack');
    });
});
