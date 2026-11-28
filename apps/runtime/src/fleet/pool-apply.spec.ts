import { poolSpecHash } from '@libs/runtime/fleet/pool';

import { resolvePoolDocuments } from './pool-apply';

// `runtime-fleet apply` (docs/runtime/host-providers.md §5.2): pool files from the infra repository become the
// stored pools, with their class resolved. A file is applied whole or not at all.

const boatClass = { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large', base: 'kodus-cell-r42-gvisor' } };
const boatPool = (over: Record<string, unknown> = {}) => ({
    kind: 'HostPool',
    name: 'boat-eu-perrun',
    scope: 'kodus',
    provider: 'boat',
    lifecycle: 'perRun',
    hostClass: 'boat-large-cell',
    labels: { residency: 'eu', backend: 'docker-gvisor', tenancy: 'run' },
    admission: { allowOrgs: ['org-kodus'] },
    price: { usdPerHostHour: 0.072, source: 'list' },
    ...over,
});
const docs = (...d: unknown[]) => d.map((doc, i) => ({ source: `pools.yaml#${i + 1}`, doc }));

describe('resolving pool files', () => {
    it('a boat pool and its class from separate documents become one stored pool, class inline, with its spec hash', () => {
        const r = resolvePoolDocuments(docs(boatClass, boatPool()), { allowFake: false });
        if (r.ok === false) throw new Error(r.errors.join('\n'));
        expect(r.pools).toHaveLength(1);
        const [p] = r.pools;
        expect(p.poolId).toBe('boat-eu-perrun');
        expect(p.pool.hostClass).toMatchObject({ provider: 'boat', boat: { type: 'large', base: 'kodus-cell-r42-gvisor', noEnv: true, snapshots: false } });
        expect(p.specHash).toBe(poolSpecHash(p.pool));
    });

    // docs/runtime/shared-image-store.md section 3: the pool names its store, and swapping the provider is a config change only.
    it("a pool names its image store in its own file, stored with the pool, and the store never makes a host stale", () => {
        const withStore = resolvePoolDocuments(docs(boatClass, boatPool({ imageStore: { provider: 'oci-registry', endpoint: 'https://store.example' } })), { allowFake: false });
        const without = resolvePoolDocuments(docs(boatClass, boatPool()), { allowFake: false });
        if (withStore.ok === false || without.ok === false) throw new Error('the files did not resolve');
        expect(withStore.pools[0].pool.imageStore).toMatchObject({ provider: 'oci-registry', endpoint: 'https://store.example', prefix: 'kodus-ci' });
        expect(withStore.pools[0].specHash).toBe(without.pools[0].specHash);
    });

    it('refuses a pool whose image store is plain HTTP on a real host, so a customer image never crosses the wire in clear', () => {
        const r = resolvePoolDocuments(docs(boatClass, boatPool({ imageStore: { provider: 'oci-registry', endpoint: 'http://store.example' } })), { allowFake: false });
        expect(r.ok).toBe(false);
    });

    it('refuses the whole file and names every problem: a class nobody defines, a field the schema does not know, a provider with no adapter, two pools with one id', () => {
        const r = resolvePoolDocuments(
            docs(
                boatClass,
                boatPool({ hostClass: 'boat-xlarge' }),
                { ...boatPool({ name: 'boat-us' }), apiKey: 'boat_should-never-be-here' },
                { kind: 'HostPool', name: 'aws-use2', scope: 'kodus', provider: 'aws', lifecycle: 'pooled', capacity: { min: 0, max: 2 }, hostClass: { kind: 'HostClass', name: 'aws-a', provider: 'aws', aws: {} } },
                boatPool({ weight: 5 }),
                boatPool({ weight: 6 }),
                { kind: 'NodePool' },
            ),
            { allowFake: false },
        );
        expect(r.ok).toBe(false);
        const errors = r.ok === false ? r.errors : [];
        expect(errors).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/pools\.yaml#2: .*boat-xlarge/),
                expect.stringMatching(/pools\.yaml#3: .*apiKey/),
                expect.stringMatching(/pools\.yaml#4: .*no adapter/),
                expect.stringMatching(/pools\.yaml#6: .*boat-eu-perrun.*more than once/),
                expect.stringMatching(/pools\.yaml#7: .*kind/),
            ]),
        );
        // A value from the file is never echoed: a key pasted by mistake stays out of the pipeline's log.
        expect(errors.join('\n')).not.toContain('boat_should-never-be-here');
    });

    it('a boat pool names the orgs it admits (customer data at rest in boat waits for legal) and the cell base its hosts start from', () => {
        const noAdmission = resolvePoolDocuments(docs(boatClass, boatPool({ admission: undefined })), { allowFake: false });
        expect(noAdmission.ok === false && noAdmission.errors.join()).toMatch(/admission\.allowOrgs/);
        const noBase = resolvePoolDocuments(docs({ ...boatClass, boat: { type: 'large' } }, boatPool()), { allowFake: false });
        expect(noBase.ok === false && noBase.errors.join()).toMatch(/base/);
    });

    it("a boat class's base is a cell base, never an environment template: one org's baked data would boot every org's hosts", () => {
        const r = resolvePoolDocuments(docs({ ...boatClass, boat: { type: 'large', base: 'kodus-env-0a1b2c3d4e-5f6a7b8c9d-0011223344556677' } }, boatPool()), { allowFake: false });
        expect(r.ok === false && r.errors.join()).toMatch(/kodus-cell-/);
    });

    it('a fake pool is for dev only', () => {
        const fake = { kind: 'HostPool', name: 'fake-perrun', scope: 'kodus', provider: 'fake', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'fake', provider: 'fake' } };
        expect(resolvePoolDocuments(docs(fake), { allowFake: false }).ok).toBe(false);
        expect(resolvePoolDocuments(docs(fake), { allowFake: true }).ok).toBe(true);
    });

    it('a file with no pool in it is refused', () => {
        expect(resolvePoolDocuments(docs(boatClass), { allowFake: false })).toEqual({ ok: false, errors: [expect.stringMatching(/no HostPool/)] });
    });
});
