import { createHash } from 'crypto';

// A stepId derived from the workflow (workflowID = runId), the attempt and a
// step name unique inside the Run. A DBOS step that is retried, or re-run
// after a worker crash, sends the same stepId, so the cell can answer the
// step it already ran instead of recording a new round (§1b).
//
// The id is a name-based UUID (RFC 9562 §5.5 layout, sha256 truncated):
// version 5 and variant 10xx, so it validates as z.uuid() in the protocol.

const NAMESPACE = 'kody-runtime/step';

export function stableStepId(runId: string, attempt: number, name: string): string {
    const b = createHash('sha256').update(`${NAMESPACE}\0${runId}\0${attempt}\0${name}`).digest().subarray(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
