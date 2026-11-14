import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { RuntimeRunRequested } from '@libs/runtime/run';

import type { StoppedRun, StopState } from '../dbos/run-engine.service';

/** What the command handlers ask of the workflow engine (RunEngineService in production). */
export interface RunEngine {
    start(req: RuntimeRunRequested): Promise<string>;
    startSetup(cmd: RuntimeEnvironmentSetupRequested): Promise<string | false>;
    /** `tokens`: fresh sealed repo and Run tokens from the approval, replacing the expired ones. */
    approve(runId: string, headSha: string, key: string, tokens?: { repoToken: string; prRepoToken?: string; runToken: string }): Promise<void>;
    /** Starts the finalization and returns; never waits for the Run to end. */
    stop(run: StoppedRun, state: StopState, reason: string): Promise<unknown>;
}
