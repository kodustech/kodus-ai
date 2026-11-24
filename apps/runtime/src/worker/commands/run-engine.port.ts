import type { ForkApprovalTokens, RuntimeEnvironmentSetupRequested, RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import type { RuntimeRunRequested } from '@libs/runtime/run';

import type { StoppedRun, StopState } from '../dbos/run-engine.service';

/** What the command handlers ask of the workflow engine (RunEngineService in production). */
export interface RunEngine {
    start(req: RuntimeRunRequested): Promise<string>;
    startSetup(cmd: RuntimeEnvironmentSetupRequested): Promise<string | false>;
    /** Enqueues an e2e suite run and returns; false when this worker has no suite service. */
    startSuite?(cmd: RuntimeSuiteRequested): Promise<string | false>;
    /** Cancels the workflow of a suite run (CI mode): the engine sees the cancel, stops its commands and releases what it holds. No such workflow: nothing happens. */
    cancelSuite?(suiteRunId: string): Promise<void>;
    /** `tokens`: fresh sealed repo and Run tokens from the approval, replacing the expired ones. */
    approve(runId: string, headSha: string, key: string, tokens?: ForkApprovalTokens): Promise<void>;
    /** Starts the finalization and returns; never waits for the Run to end. */
    stop(run: StoppedRun, state: StopState, reason: string): Promise<unknown>;
}
