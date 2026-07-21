/**
 * agent-harness — ExecutableVerifier (the "checker" that runs a command).
 *
 * A Verifier<T> that gates on an OBJECTIVE signal: it runs a command (tsc,
 * linter, test) via a CommandRunner and reads the result into a Verdict. This
 * is doer≠checker with a checker that CANNOT be overconfident — the compiler
 * either flags the line or it does not.
 *
 * Generic by construction: the harness knows nothing about tsc or findings. The
 * DOMAIN supplies an ExecutableCheck<T> — which command to run for a candidate,
 * and how to read the result into a verdict (populating a `dimensions` entry
 * with the objective signal). The harness owns two things the domain shouldn't
 * re-implement: the fail-open discipline (Verifier<T> MUST keep when unsure) and
 * memoization, so N candidates that share one `tsc` run pay for it once.
 */
import type {
    Verdict,
    Verifier,
} from '../../domain/contracts/verifier.contract';
import type { ToolContext } from '../../domain/contracts/tool.contract';
import type {
    CommandResult,
    CommandRunner,
} from '../../domain/contracts/command-runner.contract';

export interface ExecutableCheck<T> {
    /** The command to run for `candidate`, or null to SKIP the check (→ keep,
     *  fail open: no applicable objective signal). */
    command(candidate: T): string | null;
    /** Read a command result into a verdict for `candidate`. */
    interpret(candidate: T, result: CommandResult): Verdict;
    /** Optional stable key: candidates sharing a key share ONE command run
     *  (e.g. every finding in file X reuses a single `tsc X`). Absent = no reuse. */
    cacheKey?(candidate: T): string | null;
}

/** Fail-open verdict — used when no objective check applies or the runner
 *  cannot launch. A checker must NEVER silently drop a candidate. */
export function keptOpen(rationale: string): Verdict {
    return { keep: true, confidence: 'low', rationale };
}

export class ExecutableVerifier<T> implements Verifier<T> {
    private readonly inflight = new Map<string, Promise<CommandResult>>();

    constructor(
        private readonly runner: CommandRunner,
        private readonly check: ExecutableCheck<T>,
    ) {}

    async verify(candidate: T, ctx: ToolContext): Promise<Verdict> {
        const command = this.check.command(candidate);
        if (!command) {
            return keptOpen('No executable check applicable to this candidate.');
        }

        let result: CommandResult;
        try {
            result = await this.run(candidate, command, ctx);
        } catch {
            return keptOpen('Executable check could not run — kept (fail open).');
        }

        return this.check.interpret(candidate, result);
    }

    private run(
        candidate: T,
        command: string,
        ctx: ToolContext,
    ): Promise<CommandResult> {
        const key = this.check.cacheKey?.(candidate) ?? null;
        if (key === null) {
            return this.runner.run(command, { signal: ctx.signal });
        }
        let pending = this.inflight.get(key);
        if (!pending) {
            pending = this.runner.run(command, { signal: ctx.signal });
            this.inflight.set(key, pending);
        }
        return pending;
    }
}
