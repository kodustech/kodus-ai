import { nulJoinedDigest, uuidV5From } from '@libs/runtime/contracts/derive-id';

// A stepId derived from the workflow (workflowID = runId), the attempt and a
// step name unique inside the Run. A DBOS step that is retried, or re-run
// after a worker crash, sends the same stepId, so the cell can answer the
// step it already ran instead of recording a new round (§1b).
//
// The id is a name-based UUID (RFC 9562 §5.5 layout, sha256 truncated):
// version 5 and variant 10xx, so it validates as z.uuid() in the protocol.

const NAMESPACE = 'kody-runtime/step';

export function stableStepId(runId: string, attempt: number, name: string): string {
    return uuidV5From(nulJoinedDigest([NAMESPACE, runId, attempt, name]));
}
