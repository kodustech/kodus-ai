import { spawn, type ChildProcess } from 'child_process';

import { createLogger } from '@libs/core/log/logger';

import {
    SECURITY_SCAN_PARENT_WAIT_MS,
    SECURITY_SCAN_SLICE_JOB_ID_ENV,
} from './security-scan-runtime';

const logger = createLogger('SecurityScanSliceRunner');

export type SpawnSliceChild = (
    command: string,
    args: readonly string[],
    options: {
        env: NodeJS.ProcessEnv;
        stdio: 'inherit';
    },
) => ChildProcess;

export interface RunSecurityScanSliceChildOptions {
    spawn?: SpawnSliceChild;
    env?: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
    parentWaitMs?: number;
    execPath?: string;
    scriptPath?: string;
}

function workerScriptPath(): string {
    const script = process.argv[1];
    if (!script) {
        throw new Error(
            'Cannot spawn a security-scan slice child: process.argv[1] is empty',
        );
    }
    return script;
}

function killChild(child: ChildProcess): void {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
        // `subprocess.killed` is true as soon as SIGTERM was *sent*, even
        // if the child ignored it. Escalate off exit state only.
        if (child.exitCode === null) {
            child.kill('SIGKILL');
        }
    }, 5_000);
    killTimer.unref();
}

/**
 * Run one security-scan slice in a child process of the same worker
 * entry. The parent keeps the AMQP consumer and the ECS health probe on
 * its own event loop; the child boots Nest without those listeners.
 */
export async function runSecurityScanSliceChild(
    jobId: string,
    options: RunSecurityScanSliceChildOptions = {},
): Promise<void> {
    const spawnImpl: SpawnSliceChild =
        options.spawn ?? (spawn as SpawnSliceChild);
    const env: NodeJS.ProcessEnv = {
        ...(options.env ?? process.env),
        [SECURITY_SCAN_SLICE_JOB_ID_ENV]: jobId,
    };
    const execPath = options.execPath ?? process.execPath;
    const scriptPath = options.scriptPath ?? workerScriptPath();
    const requestedWaitMs = options.parentWaitMs ?? 0;
    const parentWaitMs =
        requestedWaitMs > 0 ? requestedWaitMs : SECURITY_SCAN_PARENT_WAIT_MS;

    logger.log({
        message: `Spawning security-scan slice child for job ${jobId}`,
        context: 'SecurityScanSliceRunner',
        metadata: { jobId, scriptPath },
    });

    const child = spawnImpl(execPath, [scriptPath], {
        env,
        stdio: 'inherit',
    });

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(waitTimer);
            options.abortSignal?.removeEventListener('abort', onAbort);
            fn();
        };

        const onAbort = () => {
            killChild(child);
        };

        const waitTimer = setTimeout(() => {
            killChild(child);
            settle(() =>
                reject(
                    new Error(
                        `Security scan slice child exceeded ${parentWaitMs}ms for job ${jobId}`,
                    ),
                ),
            );
        }, parentWaitMs);
        waitTimer.unref();

        options.abortSignal?.addEventListener('abort', onAbort, {
            once: true,
        });
        if (options.abortSignal?.aborted) onAbort();

        child.once('error', (error) => {
            settle(() => reject(error));
        });

        child.once('exit', (code, signal) => {
            settle(() => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(
                    new Error(
                        `Security scan slice child exited ${code ?? signal} for job ${jobId}`,
                    ),
                );
            });
        });
    });
}
