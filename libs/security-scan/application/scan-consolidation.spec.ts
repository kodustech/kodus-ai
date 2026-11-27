import { consolidateOpenIssues, sameRootCause } from './scan-consolidation';

const issue = (fingerprint: string, over: Record<string, unknown> = {}) => ({
    fingerprint,
    vulnerabilityClass: 'authz' as const,
    title: `issue ${fingerprint}`,
    description: 'd',
    severity: 'high' as const,
    cwe: 'CWE-862',
    filePath: 'a.ts',
    symbol: 'handler',
    startLine: 1,
    endLine: 2,
    ...over,
});

describe('sameRootCause', () => {
    it('does not ask when nothing could share the cause', async () => {
        const call = jest.fn();
        const got = await sameRootCause(call, issue('a'), [
            issue('b', { filePath: 'other.ts', symbol: 'x', cwe: 'CWE-89', title: 'sql' }),
        ]);
        expect(got).toBeNull();
        expect(call).not.toHaveBeenCalled();
    });

    it.each(['c1', 'C1', 'id c1', '1'])('reads %j as the first candidate', async (sameAs) => {
        const b = issue('b');
        const got = await sameRootCause(async () => ({ sameAs, reason: 'r' }), issue('a'), [b]);
        expect(got?.match).toBe(b);
    });

    it('reads an empty or unknown id as none', async () => {
        for (const sameAs of ['', 'c9', 'none']) {
            expect(
                await sameRootCause(async () => ({ sameAs, reason: '' }), issue('a'), [issue('b')]),
            ).toBeNull();
        }
    });
});

describe('consolidateOpenIssues', () => {
    const same = async () => ({ sameAs: 'c1', reason: 'one fix' });

    it('keeps the more severe issue and folds the other into it', async () => {
        const high = issue('high', { severity: 'high' });
        const critical = issue('critical', { severity: 'critical' });
        const { absorbed, compared } = await consolidateOpenIssues(
            same,
            [high, critical],
            new Set(['high', 'critical']),
        );
        expect(absorbed).toEqual([
            expect.objectContaining({ issue: high, into: critical }),
        ]);
        expect(compared.sort()).toEqual(['critical', 'high']);
    });

    it('compares only the subjects, against every issue still standing', async () => {
        const call = jest.fn(same);
        const { absorbed } = await consolidateOpenIssues(
            call,
            [issue('old'), issue('new')],
            new Set(['new']),
        );
        expect(call).toHaveBeenCalledTimes(1);
        expect(absorbed).toEqual([
            expect.objectContaining({ issue: issue('new'), into: issue('old') }),
        ]);
    });

    it('stops at the cap and leaves the rest uncompared', async () => {
        let calls = 0;
        const { compared } = await consolidateOpenIssues(
            async () => {
                calls++;
                if (calls > 1) throw new Error('budget');
                return { sameAs: '', reason: '' };
            },
            [issue('a'), issue('b'), issue('c')],
            new Set(['a', 'b', 'c']),
            { isFinal: () => calls > 1 },
        );
        expect(compared).toEqual(['a']);
    });

    it('stops when told to before the next comparison', async () => {
        const call = jest.fn(same);
        const { compared } = await consolidateOpenIssues(
            call,
            [issue('a'), issue('b')],
            new Set(['a', 'b']),
            { shouldStop: () => true },
        );
        expect(call).not.toHaveBeenCalled();
        expect(compared).toEqual([]);
    });

    it('counts a failed comparison and goes on', async () => {
        let n = 0;
        const { failures, compared } = await consolidateOpenIssues(
            async () => {
                if (n++ === 0) throw new Error('flaky');
                return { sameAs: '', reason: '' };
            },
            [issue('a'), issue('b')],
            new Set(['a', 'b']),
        );
        expect(failures).toBe(1);
        expect(compared).toEqual(['b']);
    });
});
