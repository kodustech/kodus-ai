import { RuntimeEventName, runtimeEnvelope } from '@libs/runtime/run';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryCommandStore } from '../../shared/persistence/testing';
import { consumerWith } from './testing';

// A cancel of a PR's Runs (a new head, the PR closed) cancels its running suites too (docs/runtime/e2e-suites.md section 11).

const asMessage = (payload: unknown) => runtimeEnvelope(RuntimeEventName.RunCancelRequested, { ...(payload as object), workflowType: 'RUNTIME_RUN' }, 'm1') as any;

function setup() {
    const engine = { start: jest.fn(async (r) => r.runId), stop: jest.fn(async () => true), approve: jest.fn(), startSetup: jest.fn() };
    const suiteCancel = { cancelPullRequest: jest.fn(async () => 1) };
    const consumer = consumerWith({ engine: engine as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), suiteCancel });
    return { engine, suiteCancel, consumer };
}
const req = shopRunRequest();
const pr = { organizationId: req.organizationId, repositoryId: req.repository.id, prNumber: req.pullRequest.number };

describe('the cancel of a PR reaches its suites', () => {
    it('a new head cancels the suites of the older heads and keeps the new head\'s, with or without a live Run', async () => {
        const { suiteCancel, consumer } = setup();
        await consumer.handle(asMessage({ ...pr, reason: 'superseded', headSha: 'c'.repeat(40) }), { messageId: 'm-1', redelivered: false });
        expect(suiteCancel.cancelPullRequest).toHaveBeenCalledWith({ ...pr, keepHead: 'c'.repeat(40) });
    });

    it('a closed PR cancels every suite of it', async () => {
        const { suiteCancel, consumer } = setup();
        await consumer.handle(asMessage({ ...pr, reason: 'pr_closed' }), { messageId: 'm-2', redelivered: false });
        expect(suiteCancel.cancelPullRequest).toHaveBeenCalledWith(pr);
    });

    it('a suite that cannot be cancelled never fails the cancel of the Runs: the message is acked and the failure is told', async () => {
        const { suiteCancel, consumer } = setup();
        suiteCancel.cancelPullRequest.mockRejectedValueOnce(new Error('dbos down'));
        const out = await consumer.handle(asMessage({ ...pr, reason: 'pr_closed' }), { messageId: 'm-3', redelivered: false });
        expect(out).toBeUndefined();
        expect(suiteCancel.cancelPullRequest).toHaveBeenCalledTimes(1);
    });
});
