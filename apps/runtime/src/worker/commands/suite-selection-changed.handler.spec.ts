import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { RUNTIME_CONTROL_ROUTING_KEY } from '@libs/runtime/run';

import { InMemorySuiteSelectionState } from '../suite/testing';
import { SuiteSelectionChangedHandler } from './suite-selection-changed.handler';

// docs/runtime/e2e-suites.md section 6.1 and D14: a person turns spec selection on or off for an environment, or resumes it after the
// shadow check braked it. The product asks through the outbox; the selection state is the Runtime's.

const body = (over: Record<string, unknown> = {}) => ({
    organizationId: 'org-a',
    environmentId: 'env-1',
    selection: 'on',
    requestedBy: { userId: 'user-1' },
    requestedAt: '2026-11-24T10:00:00.000Z',
    key: 'selection-1',
    ...over,
});

describe('SuiteSelectionChangedHandler', () => {
    it('turning selection on clears a brake the shadow check set, and starts the shadow window afresh at the time of the request', async () => {
        const state = new InMemorySuiteSelectionState();
        await state.applyMiss('org-a', 'env-1', { fullPrs: 8, off: true });
        expect(await new SuiteSelectionChangedHandler(state).handle(body())).toBeUndefined();
        expect(await state.read('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 0, reenabledAt: new Date('2026-11-24T10:00:00.000Z') });
    });

    it('turning selection off makes every PR run the whole suite until a person turns it on', async () => {
        const state = new InMemorySuiteSelectionState();
        expect(await new SuiteSelectionChangedHandler(state).handle(body({ selection: 'off' }))).toBeUndefined();
        expect(await state.read('org-a', 'env-1')).toMatchObject({ off: true, offBy: 'person' });
    });

    it('never changes the selection of an environment of another organization', async () => {
        const state = new InMemorySuiteSelectionState();
        await state.applyMiss('org-b', 'env-1', { fullPrs: 8, off: true });
        await new SuiteSelectionChangedHandler(state).handle(body());
        expect((await state.read('org-b', 'env-1')).off).toBe(true);
    });

    it('refuses a payload that is not a selection change, naming why', async () => {
        const state = new InMemorySuiteSelectionState();
        expect(await new SuiteSelectionChangedHandler(state).handle(body({ selection: 'maybe' }))).toMatchObject({ invalid: 'invalid suite selection change' });
    });

    it('is a control command: it never waits behind the suites in the Run lane', () => {
        const msg = runtimeCommandOutboxMessage(RuntimeCommandName.SuiteSelectionChanged, body() as any, 'm-1');
        expect(msg.routingKey).toBe(RUNTIME_CONTROL_ROUTING_KEY);
    });
});
