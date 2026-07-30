import { KodyRuleDetectorSweepService } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-detector-sweep.service';

function make(opts: {
    docs?: any[];
    lock?: any;
    backfillResult?: any;
    enabledEnv?: string;
}) {
    const prev = process.env.KODY_RULES_DETECTOR_SWEEP_ENABLED;
    if (opts.enabledEnv === undefined)
        delete process.env.KODY_RULES_DETECTOR_SWEEP_ENABLED;
    else process.env.KODY_RULES_DETECTOR_SWEEP_ENABLED = opts.enabledEnv;

    const release = jest.fn(async () => {});
    const lock = opts.lock === undefined ? { release } : opts.lock;
    const kodyRulesService: any = {
        findOrganizationIdsWithRules: jest.fn(async () =>
            (opts.docs ?? [])
                .map((d: any) => d?.organizationId)
                .filter((id: unknown): id is string => typeof id === 'string'),
        ),
    };
    const backfill: any = {
        execute: jest.fn(async () =>
            opts.backfillResult ?? {
                processed: 1,
                compiled: 1,
                declined: 0,
                errored: 0,
                skipped: 0,
                total: 1,
            },
        ),
    };
    const distributedLockService: any = { acquire: jest.fn(async () => lock) };
    const svc = new KodyRuleDetectorSweepService(
        kodyRulesService,
        backfill,
        distributedLockService,
    );
    const restore = () => {
        if (prev === undefined)
            delete process.env.KODY_RULES_DETECTOR_SWEEP_ENABLED;
        else process.env.KODY_RULES_DETECTOR_SWEEP_ENABLED = prev;
    };
    return { svc, kodyRulesService, backfill, distributedLockService, release, restore };
}

describe('KodyRuleDetectorSweepService (#1449 continuous T0 sweep)', () => {
    it('runs backfill per org (onlyMissing) and releases the lock', async () => {
        const { svc, backfill, release, restore } = make({
            docs: [{ organizationId: 'o1' }, { organizationId: 'o2' }],
        });
        await svc.sweep();
        expect(backfill.execute).toHaveBeenCalledTimes(2);
        expect(backfill.execute).toHaveBeenCalledWith(
            { organizationId: 'o1' },
            expect.objectContaining({ onlyMissing: true }),
        );
        expect(release).toHaveBeenCalledTimes(1);
        restore();
    });

    it('skips entirely when the lock is held by another worker', async () => {
        const { svc, kodyRulesService, backfill, restore } = make({
            lock: null,
            docs: [{ organizationId: 'o1' }],
        });
        await svc.sweep();
        expect(
            kodyRulesService.findOrganizationIdsWithRules,
        ).not.toHaveBeenCalled();
        expect(backfill.execute).not.toHaveBeenCalled();
        restore();
    });

    it('is a no-op when disabled by env flag', async () => {
        const { svc, distributedLockService, restore } = make({
            enabledEnv: 'false',
            docs: [{ organizationId: 'o1' }],
        });
        await svc.sweep();
        expect(distributedLockService.acquire).not.toHaveBeenCalled();
        restore();
    });

    it('continues past a failing org and still releases the lock', async () => {
        const { svc, backfill, release, restore } = make({
            docs: [{ organizationId: 'bad' }, { organizationId: 'good' }],
        });
        backfill.execute
            .mockRejectedValueOnce(new Error('org blew up'))
            .mockResolvedValueOnce({
                processed: 1,
                compiled: 1,
                declined: 0,
                errored: 0,
                skipped: 0,
                total: 1,
            });
        await svc.sweep();
        expect(backfill.execute).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(1);
        restore();
    });

    it('stops at the per-run cap and defers remaining orgs', async () => {
        const prev = process.env.KODY_RULES_DETECTOR_SWEEP_MAX_PER_RUN;
        process.env.KODY_RULES_DETECTOR_SWEEP_MAX_PER_RUN = '5';
        const { svc, backfill, restore } = make({
            docs: [{ organizationId: 'o1' }, { organizationId: 'o2' }],
            backfillResult: {
                processed: 5,
                compiled: 5,
                declined: 0,
                errored: 0,
                skipped: 0,
                total: 5,
            },
        });
        await svc.sweep();
        // first org consumes the whole budget (5) → second org deferred
        expect(backfill.execute).toHaveBeenCalledTimes(1);
        if (prev === undefined)
            delete process.env.KODY_RULES_DETECTOR_SWEEP_MAX_PER_RUN;
        else process.env.KODY_RULES_DETECTOR_SWEEP_MAX_PER_RUN = prev;
        restore();
    });

    it('skips docs without an organizationId', async () => {
        const { svc, backfill, restore } = make({
            docs: [{ foo: 1 }, { organizationId: 'o1' }],
        });
        await svc.sweep();
        expect(backfill.execute).toHaveBeenCalledTimes(1);
        restore();
    });
});
