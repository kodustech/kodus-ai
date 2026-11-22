import type { ProbeVerdict } from '@libs/runtime/run';
import { ReportLeafChangesSchema } from '@libs/runtime/run/run-report';

import { leafChangesReportOf } from './report';

// A finding's leaves in the report: the first 5 undescribed ones, the rest and
// the described ones counted, and only for a finding.

const leaf = (i: number) => ({ path: `a[${i}]`, kind: 'changed' as const, base: '1', pr: '2' });
const verdict = (over: Partial<ProbeVerdict> = {}): ProbeVerdict =>
    ({
        probeId: 'p',
        entryPoint: 'GET /x',
        verdict: 'finding',
        findingKind: 'behavior_change',
        leafChanges: { undescribed: Array.from({ length: 8 }, (_, i) => leaf(i)), described: [leaf(20), leaf(21)], mentions: ['a.b[0].c'], truncated: false },
        ...over,
    }) as ProbeVerdict;

describe('leafChangesReportOf', () => {
    it('keeps 5 undescribed leaves and counts the others', () => {
        const { leafChanges } = leafChangesReportOf(verdict());
        expect(leafChanges?.undescribed).toHaveLength(5);
        expect(leafChanges).toMatchObject({ undescribedCount: 8, describedCount: 2, mentions: ['a.b[0].c'] });
        expect(ReportLeafChangesSchema.parse(leafChanges)).toBeTruthy();
    });

    it('is absent for a verdict that is not a finding, or a finding without undescribed leaves', () => {
        expect(leafChangesReportOf(verdict({ verdict: 'described_change' }))).toEqual({});
        expect(leafChangesReportOf(verdict({ leafChanges: { undescribed: [], described: [leaf(0)], mentions: [], truncated: false } }))).toEqual({});
        expect(leafChangesReportOf(verdict({ leafChanges: undefined }))).toEqual({});
    });
});
