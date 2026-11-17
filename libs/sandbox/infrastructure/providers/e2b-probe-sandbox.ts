import { CommandExitError, Sandbox } from 'e2b';

import type { ProbeSandbox } from '../services/egress-probe/sandbox-egress-probe.service';
import {
    E2B_DEPLOYMENT_METADATA_KEY,
    e2bDeploymentTag,
} from './e2b-sandbox.service';

/** The probe lives for minutes at most; E2B kills it after this anyway. */
const PROBE_SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A sandbox from E2B's default image: no Kodus template, so no egress proxy.
 * Traffic leaves from E2B's own addresses, which is exactly what the probe
 * needs to compare against the fixed IP. Killed on timeout, never paused.
 */
export async function createE2BProbeSandbox(
    apiKey: string,
    apiNodeEnv: string | undefined,
): Promise<ProbeSandbox> {
    const sandbox = await Sandbox.create({
        timeoutMs: PROBE_SANDBOX_TIMEOUT_MS,
        apiKey,
        metadata: {
            stage: 'egress-probe',
            [E2B_DEPLOYMENT_METADATA_KEY]: e2bDeploymentTag(apiNodeEnv),
        },
        secure: true,
    });

    return {
        run: async (command, opts) => {
            try {
                const result = await sandbox.commands.run(command, {
                    ...(opts?.timeoutMs && { timeoutMs: opts.timeoutMs }),
                    ...(opts?.envs && { envs: opts.envs }),
                    ...(opts?.user && { user: opts.user }),
                });
                return {
                    exitCode: result.exitCode,
                    stdout: result.stdout ?? '',
                    stderr: result.stderr ?? '',
                };
            } catch (error) {
                // A non-zero exit is an answer, not a failure of the probe.
                if (error instanceof CommandExitError) {
                    return {
                        exitCode: error.exitCode,
                        stdout: error.stdout ?? '',
                        stderr: error.stderr ?? '',
                    };
                }
                throw error;
            }
        },
        kill: async () => {
            await sandbox.kill();
        },
    };
}
