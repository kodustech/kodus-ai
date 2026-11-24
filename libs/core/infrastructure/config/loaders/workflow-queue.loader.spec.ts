import { WorkflowQueueLoader } from './workflow-queue.loader';

describe('security scan queue prefetch', () => {
    const name = 'WORKFLOW_QUEUE_SECURITY_SCAN_PREFETCH';
    const original = process.env[name];
    afterAll(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    });

    it.each(['0', '-1', '', ' ', '1.5', '5tasks', 'Infinity'])(
        'keeps a bounded default for invalid configuration %j',
        (value) => {
            process.env[name] = value;
            expect(WorkflowQueueLoader()[name]).toBe(1);
        },
    );

    it('honors an explicitly configured positive whole number', () => {
        process.env[name] = '2';
        expect(WorkflowQueueLoader()[name]).toBe(2);
    });
});
