import { RECIPE_AUTHOR_CLIENT_TIMEOUT_MS } from '../agent/http-recipe-author';
import { PUBLISH_STEP_RETRY } from '../dbos/run-engine.service';
import { QUEUE_TIMEOUT_MS, RUN_TIMEOUT_MS } from '../run/run-orchestrator';
import { SETUP_CAPACITY_WAIT_MS } from '../setup/environment-setup.service';
import { ADMISSION_APPROVAL_MS, ADMISSION_WAIT_MS } from '../../shared/admission/admission-contract';
import { CELL_SILENCE_MS } from '../../hub/cell-hub';
import { SILENCE_TICK_MS } from '../../hub/cell-gateway.service';
import { RUNTIME_LIMITS } from '@libs/runtime/health/stuck';

// The hang detector's bounds are the code's own limits: a limit changed in
// the worker or the hub without the detector would make it alarm too early or
// never. This keeps libs/runtime/health/stuck.ts equal to them.
describe('the hang bounds follow the code’s limits', () => {
    it('match the worker’s and the hub’s constants', () => {
        const publishRetriesMs = Array.from({ length: PUBLISH_STEP_RETRY.maxAttempts - 1 }, (_, i) => PUBLISH_STEP_RETRY.intervalSeconds * PUBLISH_STEP_RETRY.backoffRate ** i * 1_000).reduce((a, b) => a + b, 0);
        expect(RUNTIME_LIMITS).toMatchObject({
            queueTimeoutMs: QUEUE_TIMEOUT_MS,
            runTimeoutMs: RUN_TIMEOUT_MS,
            approvalWaitMs: ADMISSION_APPROVAL_MS,
            admissionWaitMs: ADMISSION_WAIT_MS,
            setupCapacityWaitMs: SETUP_CAPACITY_WAIT_MS,
            recipeAuthorMs: RECIPE_AUTHOR_CLIENT_TIMEOUT_MS,
            publishRetriesMs,
            cellSilenceMs: CELL_SILENCE_MS,
            silenceTickMs: SILENCE_TICK_MS,
        });
    });
});
