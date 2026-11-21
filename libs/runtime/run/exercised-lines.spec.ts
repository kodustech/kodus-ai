import { exercisedFact, exercisedShortfall, exercisedSummaryOf } from './exercised-lines';
import { RuntimeRunReportSchema } from './run-report';
import { checkConclusionFor, decideRunVerdict, type ProbeVerdict } from './run-state';

// Which changed lines ran: a Run that would be green stays partly tested when
// fewer than the threshold of its measured changed lines ran (exercised-lines.ts).

const measured = (path: string, changedLines: number, exercisedLines: number) => ({ path, changedLines, exercisedLines, status: 'measured' as const });
const unknown = (path: string, changedLines: number) => ({ path, changedLines, exercisedLines: null, status: 'unknown' as const, reason: 'not_loaded_unproven' as const });
const settled: ProbeVerdict = { probeId: 'p1', entryPoint: 'GET /a', verdict: 'not_reproduced', reason: 'same' };
const finding: ProbeVerdict = { probeId: 'p2', entryPoint: 'GET /a', verdict: 'finding', reason: 'differs' };
const green = (exercised?: ReturnType<typeof exercisedSummaryOf>) => decideRunVerdict({ entryPoints: ['GET /a'], probes: [settled], exercised });

describe('exercisedSummaryOf', () => {
    it('sums the measured files and leaves the unknown ones out of both counts', () => {
        const s = exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 3), measured('b.ts', 4, 4), unknown('c.ts', 50)] }, 0.5);
        expect(s).toEqual({ exercised: 7, changed: 14, threshold: 0.5, language: 'node', measured: true });
    });

    it('is not measured when every file is unknown, the language is unsupported, or the cell answered nothing', () => {
        expect(exercisedSummaryOf({ language: 'node', files: [unknown('a.ts', 3)] }, 0.5).measured).toBe(false);
        expect(exercisedSummaryOf({ language: 'unsupported', files: [] }, 0.5)).toEqual({ exercised: 0, changed: 0, threshold: 0.5, language: 'unsupported', measured: false });
        expect(exercisedSummaryOf(undefined, 0.5)).toEqual({ exercised: 0, changed: 0, threshold: 0.5, measured: false });
    });
});

describe('the exercised-lines rule in decideRunVerdict', () => {
    it('below the threshold, a green Run is partly tested with "N of M changed lines ran" and the share the repo asks', () => {
        const v = green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 4)] }, 0.5));
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('4 of 10 changed lines ran, below the 50% this repo asks');
        expect(checkConclusionFor('partly_tested', v).title).toBe('Partly tested · 4 of 10 changed lines ran, below the 50% this repo asks');
    });

    it("names the Run's own threshold, not the default", () => {
        const v = green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 7)] }, 0.8));
        expect(v.forcedNeutral).toContain('7 of 10 changed lines ran, below the 80% this repo asks');
    });

    it('at or above the threshold, the Run stays green', () => {
        expect(green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 5)] }, 0.5)).verdictState).toBe('no_regressions');
        expect(green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 9)] }, 0.5)).verdictState).toBe('no_regressions');
    });

    it('the threshold is the setting passed in', () => {
        expect(green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 5)] }, 0.8)).verdictState).toBe('partly_tested');
        expect(green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 0)] }, 0)).verdictState).toBe('no_regressions');
    });

    it('nothing measured (all unknown, unsupported, or no answer) leaves the verdict as it was', () => {
        for (const s of [
            exercisedSummaryOf({ language: 'node', files: [unknown('a.ts', 10)] }, 0.5),
            exercisedSummaryOf({ language: 'unsupported', files: [] }, 0.5),
            exercisedSummaryOf(undefined, 0.5),
            undefined,
        ]) {
            const v = green(s);
            expect(v.verdictState).toBe('no_regressions');
            expect(v.forcedNeutral).toEqual([]);
        }
    });

    it('measured files with no changed line say nothing', () => {
        expect(green(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 0, 0)] }, 0.5)).verdictState).toBe('no_regressions');
    });

    it('never touches a regression and never upgrades a partly tested Run', () => {
        const low = exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 1)] }, 0.5);
        const high = exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 10)] }, 0.5);
        const regression = decideRunVerdict({ entryPoints: ['GET /a'], probes: [finding], exercised: low });
        expect(regression.verdictState).toBe('regression');
        expect(regression.forcedNeutral).toEqual([]);
        const partly = decideRunVerdict({ entryPoints: ['GET /a', 'GET /b'], probes: [settled], exercised: high });
        expect(partly.verdictState).toBe('partly_tested');
        expect(partly.forcedNeutral).toEqual([]);
    });
});

describe('exercisedShortfall and exercisedFact', () => {
    it('words the fact for measured, unmeasured with a language, and unmeasured without one', () => {
        expect(exercisedFact(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 7)] }, 0.5))).toBe('Changed lines exercised: 7 of 10');
        expect(exercisedFact(exercisedSummaryOf({ language: 'unsupported', files: [] }, 0.5))).toBe('Changed lines exercised: not measured for unsupported');
        expect(exercisedFact(exercisedSummaryOf({ language: 'node', files: [unknown('a.ts', 3)] }, 0.5))).toBe('Changed lines exercised: not measured for node');
        expect(exercisedFact(exercisedSummaryOf(undefined, 0.5))).toBe('Changed lines exercised: not measured');
        expect(exercisedFact(undefined)).toBeUndefined();
        expect(exercisedShortfall(exercisedSummaryOf({ language: 'node', files: [measured('a.ts', 10, 7)] }, 0.5))).toBeUndefined();
    });
});

describe('the report keeps exercised optional', () => {
    const report = { state: 'no_regressions', headSha: 'a'.repeat(40), requestedAt: '2026-11-17T10:00:00.000Z', paths: [], uncovered: [], blockedOutbound: [] };
    const exercised = {
        summary: { exercised: 4, changed: 10, threshold: 0.5, language: 'node', measured: true },
        files: [measured('src/a.ts', 10, 4), unknown('src/b.ts', 3)],
    };

    it('an older report without the field still parses', () => {
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
    });

    it('parses the summary and the files, and refuses a threshold past 1', () => {
        expect(RuntimeRunReportSchema.parse({ ...report, exercised }).exercised).toEqual(exercised);
        expect(RuntimeRunReportSchema.safeParse({ ...report, exercised: { ...exercised, summary: { ...exercised.summary, threshold: 50 } } }).success).toBe(false);
    });
});
