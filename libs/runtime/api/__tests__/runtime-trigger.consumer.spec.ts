import { RuntimeTriggerConsumer } from '../infrastructure/runtime-trigger.consumer';

describe('the Runtime trigger queue consumer', () => {
    const make = () => {
        const trigger = { execute: jest.fn().mockResolvedValue({ action: 'skipped' }) };
        const pushSetup = { onPush: jest.fn().mockResolvedValue([]) };
        return { trigger, pushSetup, consumer: new RuntimeTriggerConsumer(trigger as never, pushSetup as never) };
    };

    it('hands a push to a branch to the push setup, not to the pull request trigger', async () => {
        const { consumer, trigger, pushSetup } = make();
        const message = { event_name: 'runtime.default_branch_push.observed', payload: {} };
        await consumer.handle(message);
        expect(pushSetup.onPush).toHaveBeenCalledWith(message);
        expect(trigger.execute).not.toHaveBeenCalled();
    });

    it('hands a pull request event to the trigger', async () => {
        const { consumer, trigger, pushSetup } = make();
        const message = { event_name: 'runtime.pull_request.observed', payload: {} };
        await consumer.handle(message);
        expect(trigger.execute).toHaveBeenCalledWith(message);
        expect(pushSetup.onPush).not.toHaveBeenCalled();
    });
});
