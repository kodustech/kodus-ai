import { InMemoryPrAdmissionStore } from './pr-admission-store';
const scope = { organizationId: 'org', repositoryId: 'repo', prNumber: 1 };

it('keeps same-head IDs in one generation and fences older retries', async () => {
    const store = new InMemoryPrAdmissionStore();
    await store.register(scope, 'a', 'old', false);
    await store.register(scope, 'same', 'old', false);
    expect(await store.current(scope, 'a')).toEqual({ accepted: true });
    await store.register(scope, 'b', 'new', false);
    expect(await store.register(scope, 'a', 'old', true)).toEqual({
        accepted: false,
        reason: 'superseded',
    });
    expect(await store.current(scope, 'same')).toEqual({
        accepted: false,
        reason: 'superseded',
    });
});
it('cancellation retry uses its saved ceiling after a reopen and keeps the superseding head', async () => {
    const store = new InMemoryPrAdmissionStore();
    await store.register(scope, 'a', 'old', false);
    const ceiling = await store.cancel(scope, 'close');
    await store.register(scope, 'b', 'new', false);
    expect(await store.cancel(scope, 'close')).toBe(ceiling);
    expect(await store.canCancel(scope, 'b', ceiling)).toBe(false);
    expect(await store.canCancel(scope, 'a', ceiling)).toBe(true);
    expect(await store.canCancel(scope, 'legacy', ceiling)).toBe(true);
    const next = await store.cancel(scope, 'supersede', 'new');
    expect(await store.current(scope, 'b')).toEqual({ accepted: true });
    expect(await store.canCancel(scope, 'b', next)).toBe(false);
});
it('scopes run and cancellation identities to org and rejects changed bindings', async () => {
    const store = new InMemoryPrAdmissionStore();
    await store.register(scope, 'a', 'old', false);
    await expect(
        store.register({ ...scope, repositoryId: 'other' }, 'a', 'old', false),
    ).rejects.toMatchObject({ code: 'admission_conflict' });
    await expect(
        store.register(scope, 'a', 'changed', false),
    ).rejects.toMatchObject({ code: 'admission_conflict' });
    expect(
        await store.register(
            { ...scope, organizationId: 'other' },
            'a',
            'new',
            false,
        ),
    ).toEqual({ accepted: true });
    await store.cancel(scope, 'close');
    await expect(
        store.cancel({ ...scope, repositoryId: 'other' }, 'close'),
    ).rejects.toMatchObject({ code: 'admission_conflict' });
    expect(
        await store.cancel({ ...scope, organizationId: 'other' }, 'close'),
    ).toBe('1');
});
it('unknown retry may seed an absent fence but never replace an existing one', async () => {
    const store = new InMemoryPrAdmissionStore();
    expect(await store.register(scope, 'a', 'old', true)).toEqual({
        accepted: true,
    });
    expect(await store.register(scope, 'unknown', 'new', true)).toEqual({
        accepted: false,
        reason: 'unknown_redelivery',
    });
    expect(await store.current(scope, 'a')).toEqual({ accepted: true });
});
