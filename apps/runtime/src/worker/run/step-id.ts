import { nulJoinedDigest, uuidV5From } from '@libs/runtime/contracts/derive-id';

// A stepId derived from the workflow (workflowID = runId), the attempt and a
// step name unique inside the Run. A DBOS step that is retried, or re-run
// after a worker crash, sends the same stepId, so the cell can answer the
// step it already ran instead of recording a new round (§1b).
//
// The id is the first 16 bytes of a sha256 with the version nibble set to 5
// and the variant bits to 10 (the RFC 9562 §5.5 layout), so it validates as
// z.uuid() in the protocol. It is not a true UUIDv5, which hashes with SHA-1;
// RFC 9562 would call a sha256 name-based id UUIDv8 (§5.8). Shipped ids keep
// this layout.

const NAMESPACE = 'kody-runtime/step';

export function stableStepId(runId: string, attempt: number, name: string): string {
    return uuidV5From(nulJoinedDigest([NAMESPACE, runId, attempt, name]));
}
