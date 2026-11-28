import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { RUNTIME_CONTROL_ROUTING_KEY } from '@libs/runtime/run';

import { SuiteBaselineSkippedHandler } from './suite-baseline-skipped.handler';

// docs/runtime/e2e-suites.md section 2.1: the product finds a queued baseline request cannot run and tells the owner of the
// table, which ends the request with the reason the environment page shows.

const SHA = 'a'.repeat(40);
const body = (over: Record<string, unknown> = {}) => ({ organizationId: 'org-a', environmentId: 'env-1', mainSha: SHA, reason: 'no_suite', requestedAt: '2026-11-27T10:00:00.000Z', key: 'baseline-skipped:1', ...over });

describe('SuiteBaselineSkippedHandler', () => {
    it('ends the organization\'s request of that environment and commit as skipped with the reason it was given', async () => {
        const requests = { markSkipped: jest.fn(async () => undefined) };
        expect(await new SuiteBaselineSkippedHandler(requests).handle(body())).toBeUndefined();
        expect(requests.markSkipped).toHaveBeenCalledWith('org-a', 'env-1', SHA, 'no_suite');
    });

    it('refuses a command with a reason it does not know, or a commit that is not a sha, without touching the request', async () => {
        const requests = { markSkipped: jest.fn(async () => undefined) };
        const handler = new SuiteBaselineSkippedHandler(requests);
        expect(await handler.handle(body({ reason: 'because' }))).toMatchObject({ invalid: 'invalid baseline skip' });
        expect(await handler.handle(body({ mainSha: 'main' }))).toMatchObject({ invalid: 'invalid baseline skip' });
        expect(requests.markSkipped).not.toHaveBeenCalled();
    });

    it('rides the control lane, so a skip never waits behind queued Runs', () => {
        const row = runtimeCommandOutboxMessage(RuntimeCommandName.SuiteBaselineSkipped, body() as any, 'm-1');
        expect(row.routingKey).toBe(RUNTIME_CONTROL_ROUTING_KEY);
    });
});
