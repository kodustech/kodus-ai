import { decideRunVerdict, RuntimeRunReportSchema } from '@libs/runtime/run';
import { renderCheckOutput, renderReportComment } from '@libs/runtime-publish/domain/render-runtime-comment';

import { bootBlockerOf, buildReport, uncoveredByBoot, uncoveredOf } from './report';

const probe = (entryPoint: string, verdict: any) => ({ probeId: entryPoint, entryPoint, verdict, reason: 'r' }) as any;

describe('uncoveredOf', () => {
    it('carries an exercised pre-existing failure from verdict through report and publication', () => {
        const probes = [probe('GET /cart', 'pre_existing')];
        const outcome = decideRunVerdict({ entryPoints: ['GET /cart'], probes });
        const report = buildReport({ req: { requestedAt: '2026-11-06T18:00:00.000Z', headSha: 'a'.repeat(40), trigger: 'pull_request' }, state: outcome.verdictState, verdictState: outcome.verdictState, probes, steps: [], uncovered: outcome.uncoveredEntryPoints });
        expect(report.uncovered).toEqual([{ entryPoint: 'GET /cart', reason: 'pre_existing' }]);
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
        const comment = renderReportComment(report, {});
        expect(comment).toContain('The same failure was observed on both versions');
        expect(comment).not.toContain('No request Kody sent');
        const check = renderCheckOutput(report, {});
        expect(check.conclusion).toBe('neutral');
        expect(check.summary).toContain('existing failure on both versions');
        expect(check.summary).not.toContain('not reached by any request');
    });

    it('keeps an undecided comparison as the cause ahead of another pre-existing failure', () => {
        expect(uncoveredOf([probe('GET /cart', 'pre_existing'), probe('GET /cart', 'inconclusive')], ['GET /cart'])).toEqual([{ entryPoint: 'GET /cart', reason: 'inconclusive' }]);
    });

    it('gives the reason from the probe that reached the entry point, else not reached or no probe', () => {
        const probes = [probe('GET /a', 'inconclusive'), probe('GET /b', 'blocker')];
        expect(uncoveredOf(probes, ['GET /a', 'GET /b', 'GET /c'])).toEqual([
            { entryPoint: 'GET /a', reason: 'inconclusive' },
            { entryPoint: 'GET /b', reason: 'blocker' },
            { entryPoint: 'GET /c', reason: 'no_probe' },
        ]);
        expect(uncoveredOf([], ['GET /c'], true)).toEqual([{ entryPoint: 'GET /c', reason: 'not_reached' }]);
    });

    it('is what the report says, so the PR comment and the Run page agree', () => {
        const probes = [probe('GET /a', 'inconclusive')];
        const report = buildReport({ req: { requestedAt: '2026-11-06T18:00:00.000Z', headSha: 'a'.repeat(40), trigger: 'pull_request' }, state: 'partly_tested' as any, probes, steps: [], uncovered: ['GET /a', 'GET /c'] });
        expect(report.uncovered).toEqual(uncoveredOf(probes, ['GET /a', 'GET /c']));
    });
});

const req = { requestedAt: '2026-11-06T18:00:00.000Z', headSha: 'a'.repeat(40), trigger: 'pull_request' as const };

describe('blocker causes', () => {
    it("carries a blocker probe's kind and variable name to its uncovered entry point", () => {
        const probes = [{ ...probe('POST /pay', 'blocker'), blocker: { kind: 'missing_env', name: 'PAYMENTS_TEST_KEY' } }];
        expect(uncoveredOf(probes, ['POST /pay'])).toEqual([
            { entryPoint: 'POST /pay', reason: 'blocker', blocker: { kind: 'missing_env', name: 'PAYMENTS_TEST_KEY' } },
        ]);
    });

    it('drops a name that is not a variable name, and a name on any kind but missing_env', () => {
        const bad = [{ ...probe('POST /a', 'blocker'), blocker: { kind: 'missing_env', name: 'sk_live=abc' } }];
        const other = [{ ...probe('POST /a', 'blocker'), blocker: { kind: 'toolchain', name: 'NODE' } }];
        expect(uncoveredOf(bad, ['POST /a'])[0].blocker).toEqual({ kind: 'missing_env' });
        expect(uncoveredOf(other, ['POST /a'])[0].blocker).toEqual({ kind: 'toolchain' });
    });

    it('reads the variable from the boot blocker the catalog classifies, from the log line or the cell kind', () => {
        expect(bootBlockerOf([{ kind: 'compose_up', signature: 'compose_up', message: 'Error: PAYMENTS_TEST_KEY is not set' }])).toEqual({
            kind: 'missing_env',
            name: 'PAYMENTS_TEST_KEY',
        });
        expect(bootBlockerOf([{ kind: 'missing_env', signature: 'PAYMENTS_KEY', message: 'the app needs a fake' }])).toEqual({ kind: 'missing_env', name: 'PAYMENTS_KEY' });
        expect(bootBlockerOf([{ kind: 'compose_up', signature: 'compose_up', message: 'exit 1' }])).toEqual({ kind: 'unknown' });
        expect(bootBlockerOf([])).toBeUndefined();
    });

    it('marks every entry point of a Run that could not boot as blocked by that cause, and the report says it fails on main', () => {
        const uncovered = uncoveredByBoot(['GET /a', 'POST /pay'], { kind: 'missing_env', name: 'PAYMENTS_TEST_KEY' });
        expect(uncovered.every((u) => u.reason === 'blocker' && u.blocker?.name === 'PAYMENTS_TEST_KEY')).toBe(true);
        const report = buildReport({ req, state: 'could_not_boot', verdictState: 'could_not_boot', probes: [], steps: [], uncovered: ['GET /a', 'POST /pay'], uncoveredDetail: uncovered });
        expect(report.uncovered).toEqual(uncovered);
        expect(report.bootFailure).toEqual({ failsOnBase: true, kind: 'missing_env' });
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
    });

    it('keeps a valid suggestion id on its path and drops one the schema would refuse', () => {
        const probes = [
            { ...probe('GET /a', 'finding'), suggestionId: 'sugg_1' },
            { ...probe('GET /b', 'finding'), suggestionId: 'x'.repeat(200) },
        ];
        const report = buildReport({ req, state: 'regression' as any, probes, steps: [], uncovered: [] });
        expect(report.paths.map((p) => p.suggestionId)).toEqual(['sugg_1', undefined]);
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
    });
});

describe('what a path exercised', () => {
    it('carries the spec label next to an unmapped entry point, and the strict schema takes it', () => {
        const probes = [{ ...probe('unmapped', 'not_reproduced'), probeId: 'health', exercised: 'GET /api/health' }];
        const report = buildReport({ req, state: 'partly_tested' as any, probes, steps: [], uncovered: ['POST /orders'] });
        expect(report.paths[0]).toMatchObject({ entryPoint: 'unmapped', exercised: 'GET /api/health' });
        expect(report.uncovered).toEqual([{ entryPoint: 'POST /orders', reason: 'no_probe' }]);
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
        expect(RuntimeRunReportSchema.safeParse({ ...report, paths: [{ ...report.paths[0], exercised: 'x'.repeat(257) }] }).success).toBe(false);
    });
});

describe('entryPointsWithRoutes', () => {
    const { entryPointsWithRoutes } = jest.requireActual('./report');
    it('replaces an unmapped file by the routes the agent reached it through', () => {
        expect(
            entryPointsWithRoutes(
                ['GET /a', 'unmapped:pkg/api/health.go', 'unmapped:pkg/cli.go'],
                [
                    { entryPoint: 'GET /api/health', via: 'pkg/api/health.go' },
                    { entryPoint: 'HEAD /api/health', via: 'pkg/api/health.go' },
                    { entryPoint: 'GET /api/health', via: 'pkg/api/health.go' },
                    { entryPoint: 'GET /a' },
                ],
            ),
        ).toEqual(['GET /a', 'GET /api/health', 'HEAD /api/health', 'unmapped:pkg/cli.go']);
    });

    it('a route reaching a file keeps `via` on the report path', () => {
        const report = buildReport({
            req: { requestedAt: '2026-11-06T18:00:00.000Z', headSha: 'a'.repeat(40), trigger: 'pull_request' },
            state: 'regression' as any,
            probes: [{ ...probe('GET /api/health', 'finding'), via: 'pkg/api/health.go' }],
            steps: [],
            uncovered: [],
        });
        expect(report.paths[0].via).toBe('pkg/api/health.go');
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
    });
});
