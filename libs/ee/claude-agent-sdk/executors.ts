/**
 * The Claude Agent SDK executors, in the shape the core registry takes
 * (`libs/llm/sdk-executor-registry.ts`).
 */
import type { ClaudeSdkExecutors } from '@libs/llm/sdk-executor-registry';

import { resolveClaudeSdkRoute } from './eligibility';
import { isClaudeSdkInfraError } from './errors';
import { runClaudeSdkLoopCall, type ClaudeSdkDeps } from './sdk-loop-call';
import { runClaudeSdkOneShot } from './sdk-one-shot';
import { probeClaudeSdk } from './sdk-probe';

export function createClaudeSdkExecutors(deps: ClaudeSdkDeps): ClaudeSdkExecutors {
    return {
        eligible: (slot) => resolveClaudeSdkRoute(slot) !== null,
        runLoop: (call) => runClaudeSdkLoopCall(deps, call),
        runOneShot: (call) => runClaudeSdkOneShot(deps, call),
        isInfraFailure: isClaudeSdkInfraError,
        probe: (params) => probeClaudeSdk(deps, params),
    };
}
