import { boundKeyOfRun, boundKeyOfTemplate, candidatePools, type PoolView } from './candidate-pools';

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

    it('only a Run goes to a perRun pool: a setup or a sandbox has no Run to bind a host to', () => {
        expect(candidatePools([kodusStatic, boat], { ...run, consumer: 'setup', runId: undefined })).toBeNull();
        expect(candidatePools([kodusStatic, boat], { ...run, consumer: 'sandbox' })).toBeNull();
        expect(candidatePools([kodusStatic, boat], { ...run, runId: undefined })).toBeNull();
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
});
