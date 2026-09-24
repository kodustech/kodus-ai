import {
    ruleCompileHash,
    ruleContextNeedHash,
} from '@libs/common/utils/kody-rules/compile-hash';
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

const decided = (rule: any) => ({
    ...rule,
    // A rule is "settled" only when BOTH keys are current: the compile
    // attempt covers the detector, the context need is keyed separately and
    // versioned by the classifier prompt so a corrected prompt can still
    // reach a rule nobody edited.
    contextNeed: {
        need: 'diff-only',
        sourceHash: ruleContextNeedHash(rule),
        source: 'compiler',
        inferredAt: new Date('2026-01-01T00:00:00Z'),
    },
    compileAttempt: {
        sourceHash: ruleCompileHash(rule),
        attemptedAt: new Date('2026-01-01T00:00:00Z'),
        outcome: 'declined',
        declineReason: 'not-mechanical',
    },
});

describe('BackfillRuleDetectorsUseCase (#1449 T0 activation)', () => {
    it('compiles only eligible rules and tallies the outcome', async () => {
        const rules = [
            rule({ uuid: 'a' }), // eligible -> compiles
            rule({ uuid: 'b' }), // eligible -> declines
            rule({ uuid: 'c', status: 'inactive' }), // skipped
            rule({ uuid: 'd', type: KodyRulesType.MEMORY }), // skipped
            // skipped: the compiler already ran on exactly this text and these
            // examples. Note what does NOT make a rule skippable any more —
            // having a detector. Most rules are DECLINED and never get one, so
            // keying on the detector meant re-deciding 92,5% of the fleet every
            // night at the customer's expense.
            decided(rule({ uuid: 'e' })),
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

// ── #1826: the detector sweep also reports and stores the context need ───────
// The compile call decides both, so the sweep that arms detectors across an
// org is also the sweep that declares what every rule needs to see. Derived
// from spec.md's KRC-10 (each rule carries an inferred contextNeed) and the
// task's idempotency requirement.
describe('BackfillRuleDetectorsUseCase — context-need backfill (#1826)', () => {
    it('reports how many rules received each need', async () => {
        const rules = [
            rule({ uuid: 'a' }),
            rule({ uuid: 'b' }),
            rule({ uuid: 'c' }),
        ];
        const needs: Record<string, string> = {
            a: 'symbol-references',
            b: 'symbol-references',
            c: 'diff-only',
        };
        const { uc } = make(rules, (r) => ({
            compiled: false,
            declineReason: 'not-mechanical',
            contextNeed: needs[r.uuid],
        }));

        const res = await uc.execute(org, { concurrency: 1 });

        expect(res.contextNeeds).toEqual({
            'diff-only': 1,
            'full-file': 0,
            'symbol-references': 2,
            'sibling-file': 0,
            'cited-file': 0,
        });
    });

    it('counts a rule the compile call could not classify as diff-only', async () => {
        const rules = [rule({ uuid: 'a' })];
        const { uc } = make(rules, () => ({
            compiled: false,
            declineReason: 'error',
        }));

        const res = await uc.execute(org, { concurrency: 1 });

        expect(res.contextNeeds['diff-only']).toBe(1);
        expect(res.errored).toBe(1);
    });

    it('is idempotent for unchanged rule text: a re-run reports the same needs and changes nothing', async () => {
        // The rules already carry the need the compiler re-derives from the
        // same text, so the second pass is a no-op that still reports.
        const rules = [
            rule({
                uuid: 'a',
                contextNeed: {
                    need: 'symbol-references',
                    sourceHash: 'h',
                    source: 'compiler',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            }),
            rule({
                uuid: 'b',
                contextNeed: {
                    need: 'diff-only',
                    sourceHash: 'h',
                    source: 'compiler',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            }),
        ];
        const needs: Record<string, string> = {
            a: 'symbol-references',
            b: 'diff-only',
        };
        const { uc } = make(rules, (r) => ({
            compiled: false,
            declineReason: 'not-mechanical',
            contextNeed: needs[r.uuid],
        }));

        const first = await uc.execute(org, { concurrency: 1 });
        const second = await uc.execute(org, { concurrency: 1 });

        expect(second.contextNeeds).toEqual(first.contextNeeds);
        expect(second.contextNeedUnchanged).toBe(2);
        expect(second.contextNeedUnchanged).toBe(second.processed);
    });

    it('does not count a rule whose need actually changed as unchanged', async () => {
        const rules = [
            rule({
                uuid: 'a',
                contextNeed: {
                    need: 'diff-only',
                    sourceHash: 'old-text-hash',
                    source: 'compiler',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            }),
        ];
        const { uc } = make(rules, () => ({
            compiled: false,
            declineReason: 'not-mechanical',
            contextNeed: 'sibling-file',
        }));

        const res = await uc.execute(org, { concurrency: 1 });

        expect(res.contextNeedUnchanged).toBe(0);
        expect(res.contextNeeds['sibling-file']).toBe(1);
    });

    // ── #1826 step 1b: the sweep is what carries the language scope to the
    // 92,5% of the fleet that will never have a detector.
    it('counts the rules that came back with a language scope', async () => {
        const rules = [rule({ uuid: 'a' }), rule({ uuid: 'b' })];
        const { uc } = make(rules, (r) => ({
            compiled: false,
            declineReason: 'not-mechanical',
            fileScope: r.uuid === 'a' ? ['.rb', '.rake'] : undefined,
        }));

        const res = await uc.execute(org, { concurrency: 1 });

        expect(res.fileScoped).toBe(1);
        expect(res.fileScopeUnchanged).toBe(0);
    });

    it('counts an unchanged scope separately, so a re-run is idempotent', async () => {
        const rules = [
            rule({
                uuid: 'a',
                fileScope: {
                    extensions: ['.rb', '.rake'],
                    sourceHash: 'h',
                    source: 'compiler',
                    inferredAt: new Date('2026-01-01T00:00:00Z'),
                },
            }),
        ];
        const { uc } = make(rules, () => ({
            compiled: false,
            declineReason: 'not-mechanical',
            fileScope: ['.rb', '.rake'],
        }));

        const res = await uc.execute(org, { concurrency: 1 });

        expect(res.fileScoped).toBe(1);
        expect(res.fileScopeUnchanged).toBe(1);
    });

    it('still sweeps a rule that HAS a detector but no language scope', async () => {
        // The 816 rules compiled before the scope moved off the detector plan.
        // Skipping them on `onlyMissing` would leave them permanently unscoped,
        // which is the incremental backfill quietly excluding its own target.
        const rules = [
            rule({ uuid: 'a', detector: { type: 'regex', pattern: 'x' } }),
        ];
        const { uc, compileAndSave } = make(rules, () => ({
            compiled: true,
            fileScope: ['.rb'],
        }));

        const res = await uc.execute(org, {});

        expect(compileAndSave).toHaveBeenCalledTimes(1);
        expect(res.processed).toBe(1);
        expect(res.fileScoped).toBe(1);
    });

    it('skips a rule the compiler already decided on this exact text', async () => {
        const { uc, compileAndSave } = make(
            [decided(rule({ uuid: 'a' }))],
            () => ({ compiled: true }),
        );

        const res = await uc.execute(org, {});

        expect(compileAndSave).not.toHaveBeenCalled();
        expect(res.processed).toBe(0);
        expect(res.skipped).toBe(1);
    });

    it('sweeps a DECLINED rule only once, not every night', async () => {
        // The whole bug in one test. A declined rule never gets a detector, so
        // the old "has no detector" eligibility made it eligible forever — at
        // roughly 2.000 model calls a night across the fleet, on the customer's
        // own BYOK key, to re-reach a verdict we already had.
        const declined = rule({ uuid: 'a' });
        const first = make([declined], () => ({
            compiled: false,
            declineReason: 'not-mechanical',
        }));
        await first.uc.execute(org, {});
        expect(first.compileAndSave).toHaveBeenCalledTimes(1);

        // Same rule, now carrying the marker that first run would have written.
        const second = make([decided(declined)], () => ({ compiled: false }));
        await second.uc.execute(org, {});
        expect(second.compileAndSave).not.toHaveBeenCalled();
    });

    it('sweeps again once the rule TEXT changes', async () => {
        const edited = { ...decided(rule({ uuid: 'a' })), rule: 'a new body' };
        const { uc, compileAndSave } = make([edited], () => ({
            compiled: false,
        }));

        await uc.execute(org, {});

        expect(compileAndSave).toHaveBeenCalledTimes(1);
    });

    it('sweeps again once an EXAMPLE changes, not just the text', async () => {
        // Examples are the compile gate: the same text with a different
        // `incorrect` snippet can flip a rule from declined to compiled.
        const edited = {
            ...decided(rule({ uuid: 'a' })),
            examples: [{ isCorrect: false, snippet: 'console.log(x)' }],
        };
        const { uc, compileAndSave } = make([edited], () => ({
            compiled: false,
        }));

        await uc.execute(org, {});

        expect(compileAndSave).toHaveBeenCalledTimes(1);
    });
});
