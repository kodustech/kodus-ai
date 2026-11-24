import { BRAKE_MISSES, BRAKE_WINDOW_SHADOWS, brakeAfterMiss, FULL_AFTER_MISS_PRS, missesOf, shadowDue } from './shadow';

// docs/runtime/e2e-suites.md section 6.1 (Proof b) and D14 (build-plan step 19): the shadow check's rules, pure.

describe('which selected runs get a shadow', () => {
    it('every 5th of the first 50 selected runs of an environment, then every 10th', () => {
        const due = Array.from({ length: 80 }, (_, i) => i + 1).filter(shadowDue);
        expect(due).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80]);
    });
    it('never the zeroth run, and a count that is not a whole number of runs is never due', () => {
        expect(shadowDue(0)).toBe(false);
        expect(shadowDue(-5)).toBe(false);
        expect(shadowDue(5.5)).toBe(false);
    });
});

describe('what a shadow run says the selection missed', () => {
    const t = (spec: string, cls: string) => ({ spec, class: cls });
    it('a spec the selection skipped that the full run found a regression in', () => {
        expect(missesOf({ selected: ['a.cy.ts'], classification: { tests: [t('a.cy.ts', 'regression'), t('b.cy.ts', 'regression'), t('b.cy.ts', 'regression'), t('c.cy.ts', 'regression')] } })).toEqual(['b.cy.ts', 'c.cy.ts']);
    });
    it('is not a miss when the selection ran the spec, or when the full run found only noise: flaky, pre-existing, unclassified', () => {
        expect(missesOf({ selected: ['a.cy.ts'], classification: { tests: [t('a.cy.ts', 'regression'), t('b.cy.ts', 'flaky'), t('c.cy.ts', 'pre_existing'), t('e.cy.ts', 'unclassified'), t('f.cy.ts', 'failed_unconfirmed')] } })).toEqual([]);
    });

    it('a regression that is still unconfirmed because main moved ahead counts: the brake errs toward the whole suite', () => {
        expect(missesOf({ selected: ['a.cy.ts'], classification: { tests: [t('d.cy.ts', 'regression_unconfirmed')] } })).toEqual(['d.cy.ts']);
    });
    it('a shadow with no classification (it did not finish) misses nothing, and an empty selection misses every regression', () => {
        expect(missesOf({ selected: [] })).toEqual([]);
        expect(missesOf({ selected: [], classification: { tests: [t('a.cy.ts', 'regression')] } })).toEqual(['a.cy.ts']);
    });
});

describe('the brake', () => {
    it('one miss turns the environment to the whole suite for the next 10 pull requests', () => {
        expect(FULL_AFTER_MISS_PRS).toBe(10);
        expect(brakeAfterMiss({ missesInWindow: 1 })).toEqual({ fullPrs: 10, off: false });
    });
    it('two misses in the last ten shadows turn selection off until a person turns it on', () => {
        expect(BRAKE_MISSES).toBe(2);
        expect(BRAKE_WINDOW_SHADOWS).toBe(10);
        expect(brakeAfterMiss({ missesInWindow: 2 })).toEqual({ fullPrs: 10, off: true });
        expect(brakeAfterMiss({ missesInWindow: 5 })).toEqual({ fullPrs: 10, off: true });
    });
});
