import { BackfillRuleDetectorsUseCase } from '@libs/kodyRules/application/use-cases/backfill-rule-detectors.use-case';
import { KodyRulesType } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const org = { organizationId: 'org-1' } as any;

function make(rules: any[], compileResult: (rule: any) => any) {
    const kodyRulesService: any = {
        findByOrganizationId: jest.fn(async () => ({ uuid: 'kr-1', rules })),
    };
    const compileAndSave = jest.fn(async (_org, _uuid, rule) =>
        compileResult(rule),
    );
    const detectorCompiler: any = { compileAndSave };
    const uc = new BackfillRuleDetectorsUseCase(
        kodyRulesService,
        detectorCompiler,
    );
    return { uc, compileAndSave, kodyRulesService };
}

const rule = (over: any = {}) => ({
    uuid: `r-${Math.random().toString(36).slice(2, 7)}`,
    title: 't',
    rule: 'r',
    status: 'active',
    type: KodyRulesType.STANDARD,
    ...over,
});

describe('BackfillRuleDetectorsUseCase (#1449 T0 activation)', () => {
    it('compiles only eligible rules and tallies the outcome', async () => {
        const rules = [
            rule({ uuid: 'a' }), // eligible -> compiles
            rule({ uuid: 'b' }), // eligible -> declines
            rule({ uuid: 'c', status: 'inactive' }), // skipped
            rule({ uuid: 'd', type: KodyRulesType.MEMORY }), // skipped
            rule({ uuid: 'e', detector: { type: 'regex', pattern: 'x' } }), // skipped (has detector)
        ];
        const { uc, compileAndSave } = make(rules, (r) =>
            r.uuid === 'a'
                ? { compiled: true }
                : { compiled: false, declineReason: 'not-mechanical' },
        );

        const res = await uc.execute(org, { concurrency: 1 });

        expect(res.total).toBe(5);
        expect(res.processed).toBe(2); // only a and b
        expect(res.compiled).toBe(1);
        expect(res.declined).toBe(1);
        expect(res.skipped).toBe(3);
        // never touched the skipped ones
        const seen = compileAndSave.mock.calls.map((c) => c[1]).sort();
        expect(seen).toEqual(['a', 'b']);
    });

    it('with onlyMissing=false, re-processes rules that already have a detector', async () => {
        const rules = [rule({ uuid: 'a', detector: { type: 'regex', pattern: 'x' } })];
        const { uc, compileAndSave } = make(rules, () => ({ compiled: true }));
        const res = await uc.execute(org, { onlyMissing: false });
        expect(res.processed).toBe(1);
        expect(compileAndSave).toHaveBeenCalledTimes(1);
    });

    it('respects the limit for staged rollout', async () => {
        const rules = [rule(), rule(), rule(), rule()];
        const { uc, compileAndSave } = make(rules, () => ({ compiled: true }));
        const res = await uc.execute(org, { limit: 2, concurrency: 1 });
        expect(res.processed).toBe(2);
        expect(res.skipped).toBe(2);
        expect(compileAndSave).toHaveBeenCalledTimes(2);
    });

    it('counts compile errors separately without aborting', async () => {
        const rules = [rule({ uuid: 'a' }), rule({ uuid: 'b' })];
        const { uc } = make(rules, (r) =>
            r.uuid === 'a'
                ? { compiled: false, declineReason: 'error' }
                : { compiled: true },
        );
        const res = await uc.execute(org, { concurrency: 1 });
        expect(res.errored).toBe(1);
        expect(res.compiled).toBe(1);
        expect(res.processed).toBe(2);
    });
});
