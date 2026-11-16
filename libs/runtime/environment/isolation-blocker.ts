import { describeIsolationMinimum, type IsolationMinimum } from '@libs/runtime/contracts/isolation';

import type { Blocked } from './environment-runtime';

/** The signature of a claim whose isolation minimum no connected cell satisfies (blocker kind capacity). */
export const ISOLATION_UNAVAILABLE = 'isolation_unavailable';

/**
 * A claim that asks more isolation than any connected cell gives: nothing was
 * sent to a cell and nothing booted. It is never placed on a lower cell, and
 * waiting does not help until a cell that satisfies it connects.
 */
export function isolationUnavailable(min: IsolationMinimum, where = 'no connected cell that may serve this organization'): Blocked {
    return {
        status: 'blocked',
        blockers: [
            {
                kind: 'capacity',
                signature: ISOLATION_UNAVAILABLE,
                message: `the claim asks for ${describeIsolationMinimum(min)} isolation, and ${where} gives it; the claim was not started on a lower isolation`,
            },
        ],
    };
}
