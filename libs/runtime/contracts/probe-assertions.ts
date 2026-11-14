import { z } from 'zod';

import type { Probe, ProbeResult } from '@libs/runtime/probe/probe.schema';

/** Control-plane expectations only: never part of the cell's Probe protocol. */
export const ProbeAssertionsSchema = z.strictObject({
    kind: z.literal('http'),
    status: z.number().int().min(100).max(599),
    bodyIncludes: z.string().min(1).max(2_000).optional(),
});
export type ProbeAssertions = z.infer<typeof ProbeAssertionsSchema>;

/** Undefined means there is no demonstrable HTTP expectation, not that it failed. */
export function httpExpectedHolds(probe: Probe, result: ProbeResult, assertions?: ProbeAssertions): boolean | undefined {
    if (probe.spec.kind !== 'http' || !result.http) return undefined;
    if (assertions) {
        return result.http.status === assertions.status && (assertions.bodyIncludes === undefined || result.http.body.includes(assertions.bodyIncludes));
    }
    const expected = probe.expected.trim();
    if (/^\d{3}$/.test(expected)) return String(result.http.status) === expected;
    // Legacy literal predictions remain demonstrable; a prose miss says nothing about its meaning.
    return expected && result.http.body.includes(expected) ? true : undefined;
}
