import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { FINDER_DONE_TOOL } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { inspectFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';

/**
 * Whether a run submitted its result whole through the result tool. The
 * runner makes an artifact of every requested result call, executed or not,
 * so a turn cut while writing submitResult leaves one holding raw,
 * unparseable input, an object that is no findings result (`{}`), or items
 * recovery had to drop: only a result that arrived whole counts. The last
 * one is the one the review publishes (extractFindings reads the last).
 */
export function submittedWholeByTool(state: RunState): boolean {
    const published = [...state.artifacts]
        .reverse()
        .find((a) => a.type === FINDER_DONE_TOOL);
    return !!published && isWholeResult(published.payload);
}

/**
 * Whether a run delivered a whole result: through the result tool, or written
 * as its final answer instead of calling the tool, held to the same test (one
 * that lost items to the schema is not whole). A final answer the provider cut
 * (length, content filter) is not a result, however much of it parses.
 * Reads the outcome extractFindings stamped on the state.
 */
export function submittedWholeResult(state: RunState): boolean {
    if (submittedWholeByTool(state)) return true;
    const stamped = state as RunState & {
        __findingsOutcome?: string;
        __textResult?: unknown;
    };
    const finalTurn = state.steps[state.steps.length - 1];
    const finalTurnCut =
        !!finalTurn?.finishReason &&
        finalTurn.finishReason !== 'stop' &&
        finalTurn.finishReason !== 'tool-calls';
    return (
        stamped.__findingsOutcome === 'text' &&
        !finalTurnCut &&
        isWholeResult(stamped.__textResult)
    );
}

/**
 * A submitResult payload that arrived whole: the findings schema accepts it
 * and recovery dropped none of its items. On a cut turn a dropped item means
 * the result was damaged; the valid items still ship, the run is partial.
 */
function isWholeResult(payload: unknown): boolean {
    // Silent: extractFindings already logged this artifact. Items salvaged
    // before a break mean a cut payload: only those items survived (escaping
    // or dropping text after a whole array loses none). A
    // provider text node is not a finding the cut damaged (findings-schema.ts).
    const { result, drops, recoveries } = inspectFindingsResult(
        payload,
        undefined,
        { silent: true },
    );
    return (
        !!result &&
        !recoveries.some((r) => r.includes('salvaged-items')) &&
        drops.every((d) => d.reason === 'provider-text-node')
    );
}
