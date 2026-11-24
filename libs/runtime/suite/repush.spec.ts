import { planRepush, type PreviousSuiteRun, type RepushInput } from './repush';
import type { Selection } from './select';

const SPECS = ['e2e/a.cy.ts', 'e2e/b.cy.ts', 'e2e/c.cy.ts', 'e2e/d.cy.ts'];
const selected = (specs: string[], diffCoverage: Record<string, number> = {}): Selection => ({ mode: 'selected', specs, diffCoverage, text: `selected ${specs.length} of 4 specs: covers the changed files` });
const fullSel = (text = 'full suite: package.json changed'): Selection => ({ mode: 'full', specs: SPECS, reason: 'manifest', text });
const prev = (over: Partial<PreviousSuiteRun> = {}): PreviousSuiteRun => ({ prSha: 'sha-1', mergeBase: 'base-1', mode: 'full', green: true, failures: [], ...over });
const input = ({ delta, fromMergeBase, ...over }: Partial<Omit<RepushInput, 'delta' | 'fromMergeBase'>> & { delta?: Selection; fromMergeBase?: Selection } = {}): RepushInput => ({
    previous: prev(),
    mergeBase: 'base-1',
    prSha: 'sha-2',
    allSpecs: SPECS,
    delta: () => delta ?? selected([]),
    fromMergeBase: () => fromMergeBase ?? selected(['e2e/a.cy.ts']),
    ...over,
});

describe('planRepush', () => {
    it('runs the specs that were red before plus the specs the new delta reaches', () => {
        const p = planRepush(input({ previous: prev({ green: false, failures: [{ spec: 'e2e/c.cy.ts', class: 'regression' }] }), delta: selected(['e2e/a.cy.ts']) }));
        expect(p).toMatchObject({ mode: 'selected', specs: ['e2e/a.cy.ts', 'e2e/c.cy.ts'], failedBefore: ['e2e/c.cy.ts'] });
    });

    it('runs none when the previous full run was green and the delta selects nothing, and says so', () => {
        const p = planRepush(input({ delta: selected([]) }));
        expect(p).toMatchObject({ mode: 'none', specs: [] });
        expect(p.text).toBe('no spec covers this change; last full run green (sha sha-1)');
    });

    it('a delta that falls in the safety net escalates to the full suite', () => {
        const p = planRepush(input({ delta: fullSel() }));
        expect(p).toMatchObject({ mode: 'full', specs: SPECS });
        expect(p.text).toContain('package.json changed');
    });

    it('a rebase, a new merge base, resets to a normal selection from it', () => {
        const p = planRepush(input({ previous: prev({ green: false, failures: [{ spec: 'e2e/c.cy.ts', class: 'regression' }] }), mergeBase: 'base-2', fromMergeBase: selected(['e2e/b.cy.ts']), delta: selected(['e2e/a.cy.ts']) }));
        expect(p).toMatchObject({ mode: 'selected', specs: ['e2e/b.cy.ts'], failedBefore: [] });
        expect(p.text).toContain('merge base changed');
    });

    it('a rebase whose selection is the safety net runs the full suite', () => {
        expect(planRepush(input({ mergeBase: 'base-2', fromMergeBase: fullSel() })).mode).toBe('full');
    });

    it('a pre_existing earlier failure is not forced in, nor is pre_existing_changed', () => {
        const p = planRepush(
            input({
                previous: prev({ green: false, failures: [{ spec: 'e2e/b.cy.ts', class: 'pre_existing' }, { spec: 'e2e/c.cy.ts', class: 'pre_existing_changed' }, { spec: 'e2e/d.cy.ts', class: 'regression' }] }),
                delta: selected(['e2e/a.cy.ts']),
            }),
        );
        expect(p.specs).toEqual(['e2e/a.cy.ts', 'e2e/d.cy.ts']);
        expect(p.failedBefore).toEqual(['e2e/d.cy.ts']);
    });

    it('a previous run that was only pre_existing red and a delta of nothing runs none', () => {
        const p = planRepush(input({ previous: prev({ green: false, failures: [{ spec: 'e2e/b.cy.ts', class: 'pre_existing' }] }), delta: selected([]) }));
        expect(p.mode).toBe('none');
    });

    it('an unclassified or unconfirmed earlier failure is run again, since nothing proved it harmless', () => {
        const p = planRepush(input({ previous: prev({ green: false, failures: [{ spec: 'e2e/b.cy.ts', class: 'unclassified' }, { spec: 'e2e/c.cy.ts', class: 'failed_unconfirmed' }] }), delta: selected([]) }));
        expect(p).toMatchObject({ mode: 'selected', specs: ['e2e/b.cy.ts', 'e2e/c.cy.ts'] });
    });

    it('after a selected, not full, previous run the union rule holds on the delta', () => {
        const p = planRepush(input({ previous: prev({ mode: 'selected', green: true }), delta: selected(['e2e/d.cy.ts']) }));
        expect(p).toMatchObject({ mode: 'selected', specs: ['e2e/d.cy.ts'] });
    });

    it('after a selected previous run that was green and a delta of nothing, none runs and the text names the selected run', () => {
        const p = planRepush(input({ previous: prev({ mode: 'selected', green: true }), delta: selected([]) }));
        expect(p).toMatchObject({ mode: 'none' });
        expect(p.text).toBe('no spec covers this change; last run green (sha sha-1)');
    });

    it('drops an earlier failure whose spec no longer exists', () => {
        const p = planRepush(input({ previous: prev({ green: false, failures: [{ spec: 'e2e/deleted.cy.ts', class: 'regression' }] }), delta: selected([]) }));
        expect(p.mode).toBe('none');
    });

    it('hands the risk-first order the delta coverage', () => {
        const p = planRepush(input({ delta: selected(['e2e/a.cy.ts'], { 'e2e/a.cy.ts': 3 }) }));
        expect(p.mode === 'selected' && p.diffCoverage).toEqual({ 'e2e/a.cy.ts': 3 });
    });
});
