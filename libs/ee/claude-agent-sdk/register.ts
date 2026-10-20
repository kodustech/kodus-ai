/**
 * Registers the Claude Agent SDK executors in the core's registry. Kept free of
 * NestJS so the evals register them exactly as production does.
 */
import { setClaudeSdkExecutors, type ClaudeSdkExecutors } from '@libs/llm/sdk-executor-registry';

import { ClaudeSdkInfraError } from './errors';
import { createClaudeSdkExecutors } from './executors';
import { SdkGateway } from './gateway/server';
import { SdkProcessPool } from './process-pool';
import { loadSdkRuntime } from './sdk-runtime';

export type LicenseCheck = (organizationId: string | undefined) => Promise<boolean>;

/** Executors that stand down (today's path, no warning) for an unlicensed organization. */
export function licensedExecutors(base: ClaudeSdkExecutors, licensed: LicenseCheck): ClaudeSdkExecutors {
    const gate = async (organizationId: string | undefined) => {
        if (!(await licensed(organizationId))) throw new ClaudeSdkInfraError('unlicensed', 'no EE license for this organization');
    };
    return {
        ...base,
        runLoop: async (call) => {
            await gate(call.organizationId);
            return base.runLoop(call);
        },
        runOneShot: async (call) => {
            await gate(call.organizationId);
            return base.runOneShot(call);
        },
        probe: async (params) => ((await licensed(params.organizationId)) ? (base.probe?.(params) ?? null) : null),
    };
}

export interface ClaudeSdkRuntimeParts {
    gateway: SdkGateway;
    pool: SdkProcessPool;
}

/** Builds and registers the executors; returns what shutdown must close. */
export function registerClaudeSdk(opts: { cloud: boolean; licensed: LicenseCheck; parts?: ClaudeSdkRuntimeParts }): ClaudeSdkRuntimeParts {
    const gateway = opts.parts?.gateway ?? new SdkGateway();
    const pool = opts.parts?.pool ?? new SdkProcessPool(gateway);
    const base = createClaudeSdkExecutors({ pool, runtime: loadSdkRuntime });
    setClaudeSdkExecutors(opts.cloud ? base : licensedExecutors(base, opts.licensed));
    return { gateway, pool };
}

export async function unregisterClaudeSdk(parts: ClaudeSdkRuntimeParts): Promise<void> {
    setClaudeSdkExecutors(undefined);
    await parts.pool.shutdown();
    await parts.gateway.close();
}

