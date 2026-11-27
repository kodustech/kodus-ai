import { templateSetupKey, boundKeyOfRun, boundKeyOfSetup, boundKeyOfSuite, boundKeyOfTemplate, candidatePools, suiteKeyOf, type PoolView } from './candidate-pools';

const pool = (over: Partial<PoolView> & Pick<PoolView, 'poolId'>): PoolView => ({
    scope: 'kodus',
    provider: 'static',
    lifecycle: 'pooled',
    weight: 0,
    labels: {},
    cordoned: false,
    scalable: true,
    ...over,
});

const kodusStatic = pool({ poolId: 'kodus-static' });
const acmeDefault = pool({ poolId: 'org:acme/default', scope: 'org:acme' });
const boat = pool({ poolId: 'boat-eu-perrun', provider: 'boat', lifecycle: 'perRun', weight: 100, allowOrgs: ['kodus'], labels: { isolation: 'microvm' } });
const run = { organizationId: 'kodus', consumer: 'runtime', runId: 'r-1' };

describe('candidatePools', () => {
    it('with only static pools, placement is what it was before pools: no restriction', () => {
        expect(candidatePools([kodusStatic, acmeDefault], { ...run, organizationId: 'acme' })).toBeNull();
    });

    it('a perRun pool an org is admitted to comes first by weight, the static ones follow as the fallback, and the Run gets its bound key', () => {
        expect(candidatePools([kodusStatic, boat], run)).toEqual({ pools: ['boat-eu-perrun', 'kodus-static'], perRun: ['boat-eu-perrun'], boundKey: 'run:kodus/r-1' });
    });

    it('an org the pool does not admit never sees it, so its placement stays unrestricted', () => {
        expect(candidatePools([kodusStatic, acmeDefault, boat], { ...run, organizationId: 'acme' })).toBeNull();
    });

    it("an org's own pools go before Kodus's, and another org's pools are never candidates", () => {
        const acmeBoat = pool({ poolId: 'org:acme/boat', scope: 'org:acme', provider: 'boat', lifecycle: 'perRun', weight: 1 });
        const globex = pool({ poolId: 'org:globex/default', scope: 'org:globex' });
        const kodusBoat = { ...boat, allowOrgs: undefined };
        expect(candidatePools([kodusStatic, globex, kodusBoat, acmeDefault, acmeBoat], { ...run, organizationId: 'acme' })?.pools).toEqual([
            'org:acme/boat',
            'org:acme/default',
            'boat-eu-perrun',
            'kodus-static',
        ]);
    });

    it('a cordoned pool, or one whose controller says it cannot grow, is dropped', () => {
        expect(candidatePools([kodusStatic, { ...boat, cordoned: true }], run)).toBeNull();
        expect(candidatePools([kodusStatic, { ...boat, scalable: false }], run)).toBeNull();
    });

    it('only a claim with something to bind a host to goes to a perRun pool: a sandbox, a Run with no id, a setup with no environment never do', () => {
        expect(candidatePools([kodusStatic, boat], { ...run, consumer: 'setup', runId: undefined })).toBeNull();
        expect(candidatePools([kodusStatic, boat], { ...run, consumer: 'sandbox' })).toBeNull();
        expect(candidatePools([kodusStatic, boat], { ...run, runId: undefined })).toBeNull();
    });

    it("an environment's own setup goes to a perRun pool like a Run, bound to that setup", () => {
        const setup = { organizationId: 'kodus', consumer: 'setup', setupKey: 'env-1:2026-11-27T00:00:00.000Z' };
        const boundKey = boundKeyOfSetup('kodus', setup.setupKey);
        expect(candidatePools([kodusStatic, boat], setup)).toEqual({ pools: ['boat-eu-perrun', 'kodus-static'], perRun: ['boat-eu-perrun'], boundKey });
        // Only boat: the setup still has a machine (before, placement was unrestricted and found no cell).
        expect(candidatePools([boat], setup)).toEqual({ pools: ['boat-eu-perrun'], perRun: ['boat-eu-perrun'], boundKey });
        // A setup key never makes a sandbox's claim perRun.
        expect(candidatePools([kodusStatic, boat], { ...setup, consumer: 'sandbox' })).toBeNull();
    });

    it('a pool whose isolation label does not satisfy the claim minimum is dropped', () => {
        const gvisorBoat = { ...boat, labels: { isolation: 'sandboxed-container' as const } };
        expect(candidatePools([kodusStatic, gvisorBoat], { ...run, isolation: 'vm' })).toBeNull();
        expect(candidatePools([kodusStatic, boat], { ...run, isolation: 'vm' })?.pools[0]).toBe('boat-eu-perrun');
    });

    it('the bound key carries the org, so two orgs with the same Run id never share a host', () => {
        expect(boundKeyOfRun('a', 'r')).not.toBe(boundKeyOfRun('b', 'r'));
        expect(boundKeyOfRun('a', 'r')).toBe('run:a/r');
    });

    it("binds a template's setup host to its environment alone", () => {
        expect(boundKeyOfTemplate('a', 'e')).toBe('template:a/e');
        expect(boundKeyOfTemplate('a', 'e')).not.toBe(boundKeyOfRun('a', 'e'));
    });

    it('binds a setup host to that one setup: the next setup of the environment gets a key, and so a host, of its own', () => {
        const first = boundKeyOfSetup('a', 'env-1:2026-11-27T00:00:00.000Z');
        expect(first).toMatch(/^setup:a\/[0-9a-f]{32}$/);
        expect(boundKeyOfSetup('a', 'env-1:2026-11-27T00:00:00.000Z')).toBe(first);
        expect(boundKeyOfSetup('a', 'env-1:2026-11-27T01:00:00.000Z')).not.toBe(first);
        // Two orgs never share it, and it is never a template's key (its setup record stays the environment's).
        expect(boundKeyOfSetup('b', 'env-1:2026-11-27T00:00:00.000Z')).not.toBe(first);
        expect(templateSetupKey('a', first)).toBeNull();
    });

    it('accepts only the claim org\'s own template key for a template setup', () => {
        expect(templateSetupKey('a', 'template:a/e')).toBe('template:a/e');
        expect(templateSetupKey('a', 'template:b/e')).toBeNull();
        expect(templateSetupKey('a', 'run:a/r1')).toBeNull();
        expect(templateSetupKey('a', 'template:a/')).toBeNull();
        expect(templateSetupKey('a', 'template:a/e/x')).toBeNull();
        expect(templateSetupKey('a', undefined)).toBeNull();
    });

    describe('a suite shard (docs/runtime/e2e-suites.md section 5)', () => {
        const shard = { organizationId: 'kodus', consumer: 'suite', suiteRunId: 'sr-1', shard: 2 };

        it('gets its own perRun host: the key names the org, the suite run and the shard', () => {
            expect(boundKeyOfSuite('kodus', 'sr-1', 2)).toBe('suite:kodus/sr-1/2');
            expect(candidatePools([kodusStatic, boat], shard)).toEqual({ pools: ['boat-eu-perrun', 'kodus-static'], perRun: ['boat-eu-perrun'], boundKey: 'suite:kodus/sr-1/2' });
        });

        it('two shards of one run, and two orgs with one run id, never share a host', () => {
            expect(boundKeyOfSuite('a', 'sr', 0)).not.toBe(boundKeyOfSuite('a', 'sr', 1));
            expect(boundKeyOfSuite('a', 'sr', 0)).not.toBe(boundKeyOfSuite('b', 'sr', 0));
            expect(boundKeyOfSuite('a', 'sr', 0)).not.toBe(boundKeyOfRun('a', 'sr'));
        });

        it('with no suite run or no shard there is no host to bind: placement stays unrestricted', () => {
            expect(candidatePools([kodusStatic, boat], { ...shard, suiteRunId: undefined })).toBeNull();
            expect(candidatePools([kodusStatic, boat], { ...shard, shard: undefined })).toBeNull();
            // A Run id alone does not make a suite shard.
            expect(candidatePools([kodusStatic, boat], { organizationId: 'kodus', consumer: 'suite', runId: 'r-1' })).toBeNull();
        });

        it("reads a suite key back only for the claim's own org and a numeric shard", () => {
            expect(suiteKeyOf('kodus', 'suite:kodus/sr-1/2')).toEqual({ suiteRunId: 'sr-1', shard: 2 });
            expect(suiteKeyOf('acme', 'suite:kodus/sr-1/2')).toBeNull();
            expect(suiteKeyOf('kodus', 'suite:kodus/sr-1/x')).toBeNull();
            expect(suiteKeyOf('kodus', 'suite:kodus/sr-1')).toBeNull();
            expect(suiteKeyOf('kodus', 'run:kodus/r-1')).toBeNull();
            expect(suiteKeyOf('kodus', undefined)).toBeNull();
        });
    });
});
