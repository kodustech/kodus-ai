/**
 * agent-harness — CommandRunner port (domain-agnostic).
 *
 * Runs a shell command somewhere the domain controls (a sandbox, a container,
 * the local repo checkout) and returns its result. This is the seam that lets
 * verification gate on an OBJECTIVE runtime signal — `tsc`, a linter, a test —
 * instead of a model's (overconfident) self-assessment. `ExecutableVerifier`
 * consumes it.
 *
 * Contract: a non-zero `exitCode` is DATA, not an error — the runner resolves
 * with it. Reserve rejection for the command failing to launch (so the verifier
 * can fail open). stdout and stderr are kept SEPARATE so a consumer can tell
 * real output from diagnostics.
 */
export interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface CommandRunner {
    /** Run `command`; resolve with its result (any exit code). Rejects only if
     *  the command cannot be launched. Must respect `opts.signal` if given. */
    run(
        command: string,
        opts?: { signal?: AbortSignal },
    ): Promise<CommandResult>;
}
