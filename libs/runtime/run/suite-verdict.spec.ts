import type { Classification, ClassifiedTest } from '@libs/runtime/suite';

import { checkConclusionFor, decideRunVerdict } from './run-state';
import { suiteFindingsOf, suiteUnclassifiedCount, suiteVerdictParts } from './suite-verdict';

// docs/runtime/e2e-suites.md section 10.2: in Run mode the suite is a stage of the Run. A regression becomes a finding of
// kind e2e_regression and the verdict regression; flaky, pre-existing and the rest are no finding; an unclassified failure
// with no regression makes the Run partly tested, never no_regressions with part of the suite unknown.

const test = (spec: string, cls: ClassifiedTest['class'], over: Partial<ClassifiedTest> = {}): ClassifiedTest => ({ spec, title: `${spec} works`, class: cls, blocks: cls === 'regression', finding: cls === 'regression', baseDrift: 0, prSignature: 'expected <n> got <n>', ...over });
const classification = (...tests: ClassifiedTest[]): Classification => ({ tests, massFailure: false, requestTemplateBuild: false });
const settled = { probeId: 'p1', entryPoint: 'GET /orders', verdict: 'not_reproduced' as const, reason: 'same on both sides' };

describe('the findings of a suite run', () => {
    it('turns each regression into a finding of kind e2e_regression with the spec, the test and the evidence of its class', () => {
        const [f, ...rest] = suiteFindingsOf(classification(test('cypress/e2e/a.cy.ts', 'regression')));
        expect(rest).toEqual([]);
        expect(f).toMatchObject({ probeId: 'suite:cypress/e2e/a.cy.ts:cypress/e2e/a.cy.ts works', entryPoint: 'cypress/e2e/a.cy.ts', verdict: 'finding', findingKind: 'e2e_regression' });
        expect(f.reason).toContain('failed on the PR twice and passed on main');
        expect(f.reason).toContain('expected <n> got <n>');
        expect(f.exercised).toBe('cypress/e2e/a.cy.ts › cypress/e2e/a.cy.ts works');
    });

    it('makes no finding of flaky, pre-existing, unconfirmed or infra failures', () => {
        const c = classification(test('a.cy.ts', 'flaky'), test('b.cy.ts', 'pre_existing'), test('c.cy.ts', 'pre_existing_changed'), test('d.cy.ts', 'failed_unconfirmed'), test('e.cy.ts', 'regression_unconfirmed'), test('f.cy.ts', 'regression_probable'), test('g.cy.ts', 'infra'), test('h.cy.ts', 'unclassified'));
        expect(suiteFindingsOf(c)).toEqual([]);
        expect(suiteFindingsOf(undefined)).toEqual([]);
    });

    it('counts what is left undecided: every failure that is neither confirmed nor ruled out', () => {
        expect(suiteUnclassifiedCount(classification(test('a.cy.ts', 'flaky'), test('b.cy.ts', 'pre_existing'), test('d.cy.ts', 'failed_unconfirmed'), test('e.cy.ts', 'regression_unconfirmed'), test('f.cy.ts', 'regression_probable'), test('h.cy.ts', 'unclassified')))).toBe(4);
        expect(suiteUnclassifiedCount(undefined)).toBe(0);
    });
});

describe('the Run verdict with a suite', () => {
    it('a regression of the suite is the verdict regression, and the check fails', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /orders'], probes: [settled, ...suiteFindingsOf(classification(test('a.cy.ts', 'regression')))] });
        expect(v.verdictState).toBe('regression');
        expect(v.findings.map((f) => f.findingKind)).toEqual(['e2e_regression']);
        expect(checkConclusionFor('regression', v).conclusion).toBe('failure');
    });

    it('an unclassified failure with no regression makes the Run partly tested, never no_regressions', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /orders'], probes: [settled], suiteUnclassified: 2 });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('2 e2e failures not classified');
        expect(checkConclusionFor('partly_tested', v).conclusion).not.toBe('success');
    });

    it('with every probe settled and nothing unclassified, the suite changes nothing', () => {
        expect(decideRunVerdict({ entryPoints: ['GET /orders'], probes: [settled], suiteUnclassified: 0 }).verdictState).toBe('no_regressions');
    });

    it('a suite that could not start holds a green Run back and the check says why, in fixed words', () => {
        const parts = suiteVerdictParts({ status: 'unavailable', reason: 'no_host' });
        expect(parts).toEqual({ findings: [], unclassified: 0, notRun: true, notRunWhy: 'no suite host came up' });
        const v = decideRunVerdict({ entryPoints: ['GET /orders'], probes: [settled], suiteNotRun: true, suiteNotRunWhy: parts.notRunWhy });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('the e2e suite could not run: no suite host came up');
        // A reason the check has no words for says only that it did not run.
        expect(suiteVerdictParts({ status: 'unavailable', reason: 'something new' })).toEqual({ findings: [], unclassified: 0, notRun: true });
        expect(decideRunVerdict({ entryPoints: ['GET /orders'], probes: [settled], suiteNotRun: true }).forcedNeutral).toContain('the e2e suite could not run');
    });

    it('a regression stays a regression when other failures are unclassified', () => {
        const v = decideRunVerdict({ entryPoints: [], probes: suiteFindingsOf(classification(test('a.cy.ts', 'regression'))), suiteUnclassified: 3 });
        expect(v.verdictState).toBe('regression');
    });
});
