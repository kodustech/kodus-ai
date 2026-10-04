// eslint-disable-next-line @typescript-eslint/no-require-imports
const { selectCases } = require('./case-selection');

const cases = ['R1-repeat-open', 'R10-replay', 'R11-replay', 'R3-stale', 'R3p-pending'].map((id) => ({ id }));
const ids = (selector?: string) => selectCases(cases, selector).map((c: { id: string }) => c.id);

describe('review-rounds --case selection', () => {
    // `--case=R1` once also ran R10 and R11 (prefix match), and R3 ran R3p.
    it('a short id selects that case only, never another sharing its prefix', () => {
        expect(ids('R1,R3')).toEqual(['R1-repeat-open', 'R3-stale']);
    });

    it('full ids and the pending variant are accepted', () => {
        expect(ids('R1-repeat-open,R3p')).toEqual(['R1-repeat-open', 'R3p-pending']);
    });

    it('no selector runs every case; an unknown one fails visibly', () => {
        expect(ids()).toEqual(cases.map((c) => c.id));
        expect(() => ids('R99')).toThrow(/Unknown case/);
    });
});
