import { PgSuiteSpecStats } from './pg-suite-spec-stats';

const scope = { organizationId: 'org-a', environmentId: 'env-1' };
const SHA = 'a'.repeat(40);

/** The specs (with their milliseconds) a `record` sent to the database, or undefined when it sent nothing. */
async function recorded(observed: Parameters<PgSuiteSpecStats['record']>[2]): Promise<Array<{ spec: string; ms: number }> | undefined> {
    const query = jest.fn(async () => ({ rows: [] }));
    await new PgSuiteSpecStats({ query } as never).record(scope, SHA, observed);
    const call = query.mock.calls[0] as unknown as [string, unknown[]] | undefined;
    return call ? (JSON.parse(call[1][3] as string) as Array<{ spec: string; ms: number }>) : undefined;
}

describe('what the duration stats record', () => {
    it('keeps a failed spec at the wall time it cost its shard, beside a passing one', async () => {
        expect(await recorded([{ spec: 'a.cy.ts', status: 'passed', durationMs: 45_000 }, { spec: 'b.cy.ts', status: 'failed', durationMs: 180_000 }])).toEqual([
            { spec: 'a.cy.ts', ms: 45_000 },
            { spec: 'b.cy.ts', ms: 180_000 },
        ]);
    });

    it('never records a skipped spec, nor a duration that is not a number or is negative', async () => {
        expect(await recorded([{ spec: 'c.cy.ts', status: 'skipped', durationMs: 0 }, { spec: 'd.cy.ts', status: 'failed', durationMs: Number.NaN }, { spec: 'e.cy.ts', status: 'passed', durationMs: -1 }])).toBeUndefined();
    });
});
