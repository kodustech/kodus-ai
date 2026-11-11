import { MAX_RISKS, buildRiskPlanPrompt, intentRisksLens, riskPlanOf } from './intent-risks';

const stateWith = (payload: unknown) => ({ artifacts: [{ type: 'submitRisks', payload }] }) as any;

describe('intent-risks', () => {
    it('reads the last submitted plan, dropping empty risks and capping the list', () => {
        const risks = Array.from({ length: MAX_RISKS + 3 }, (_, i) => ({ risk: `r${i}`, where: 'a.ts' }));
        const plan = riskPlanOf(stateWith({ intent: ' scope rules by org ', risks: [{ risk: '  ', where: 'x' }, ...risks] }));
        expect(plan?.intent).toBe('scope rules by org');
        expect(plan?.risks).toHaveLength(MAX_RISKS);
        expect(plan?.risks[0]).toEqual({ risk: 'r0', where: 'a.ts' });
    });

    it('gives no plan when nothing was submitted', () => {
        expect(riskPlanOf({ artifacts: [] } as any)).toBeUndefined();
    });

    it('puts title, description and diff in the plan prompt, and marks a missing description', () => {
        expect(buildRiskPlanPrompt('fix: x', 'Closes #1', 'DIFF')).toContain('Title: fix: x\nDescription:\nCloses #1');
        expect(buildRiskPlanPrompt('t', '', 'DIFF')).toContain('Description:\n(none)');
    });

    it('lists the intent and numbered risks in the checking lens', () => {
        const lens = intentRisksLens({ intent: 'do X', risks: [{ risk: 'misses CLI', where: 'cli.ts' }] });
        expect(lens.extraItems?.[0]).toContain('Intent: do X');
        expect(lens.extraItems?.[0]).toContain('[1] misses CLI\n      where: cli.ts');
    });
});
