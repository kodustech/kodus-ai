import {
    GraphBaselineChangedError,
    MAX_GRAPH_INCREMENTAL_FILES,
} from '@libs/code-review/domain/graph-job-attempt';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

export async function graphCheckoutSha(
    sandbox: SandboxInstance,
    wasCreated: boolean,
    baseline: string | null,
    signal?: AbortSignal,
): Promise<string> {
    signal?.throwIfAborted();
    const result = await raceWithAbortSignal(
        sandbox.run(`git -C ${shSingleQuote(sandbox.repoDir)} rev-parse HEAD`, {
            timeoutMs: 10_000,
            signal,
        }),
        signal,
    );
    const sha = result.stdout?.trim();
    if (result.exitCode || !sha)
        throw new Error('Failed to resolve HEAD sha from sandbox');
    // Reconnecting is best-effort. A reused checkout can predate our baseline read.
    if (!wasCreated && sha !== baseline) throw new GraphBaselineChangedError();
    return sha;
}

/** null requests a complete snapshot when the old tree is unavailable or the diff is too large. */
export async function graphCheckoutFiles(
    sandbox: SandboxInstance,
    baseline: string | null,
    head: string,
    signal?: AbortSignal,
): Promise<string[] | null> {
    signal?.throwIfAborted();
    if (!baseline || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseline))
        return null;
    if (baseline === head) return [];
    const git = `git -C ${shSingleQuote(sandbox.repoDir)}`;
    // The sandbox fetches the parent at clone time. A more distant base can be outside its shallow history.
    // The empty final record is present only after Git emitted the complete path list.
    const diff = `${git} diff --no-ext-diff --no-textconv --no-renames --ignore-submodules=none --raw -z ${baseline} ${shSingleQuote(head)} --`;
    const result = await raceWithAbortSignal(
        sandbox.run(
            `if ${diff}; then printf '\\0'; else printf unavailable; fi`,
            { timeoutMs: 60_000, signal },
        ),
        signal,
    );
    if (result.exitCode !== 0 || !result.stdout.endsWith('\0')) return null;
    const records = result.stdout.slice(0, -1);
    if (!records) return [];
    if (!records.endsWith('\0')) return null;
    const fields = records.slice(0, -1).split('\0');
    if (fields.length % 2 || fields.length > 2 * MAX_GRAPH_INCREMENTAL_FILES)
        return null;
    const paths: string[] = [];
    for (let i = 0; i < fields.length; i += 2) {
        const header = /^:([0-7]{6}) ([0-7]{6}) [\da-f]+ [\da-f]+ [ADMT]$/.exec(
            fields[i],
        );
        if (!header || !fields[i + 1]) return null;
        const [, oldMode, newMode] = header;
        // A gitlink names one directory, while the graph stores files beneath it.
        if (oldMode === '160000' || newMode === '160000') return null;
        paths.push(fields[i + 1]);
    }
    return paths;
}
