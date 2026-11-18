import { ExternalMaintenanceCandidates } from './maintenance-candidates';

it('discovers only bounded organization IDs with an opaque keyset cursor and no task bodies', async () => {
    const rows = [
        {
            organization_id: 'org-a',
            receipt_id: '00000000-0000-4000-8000-000000000001',
            due_at: new Date('2026-10-01T00:00:00Z'),
        },
        {
            organization_id: 'org-a',
            receipt_id: '00000000-0000-4000-8000-000000000002',
            due_at: new Date('2026-10-02T00:00:00Z'),
        },
    ];
    const query = jest.fn(async (..._args: unknown[]) => rows);
    const reader = new ExternalMaintenanceCandidates({
        source: async () => ({ query }),
    } as never);
    const page = await reader.page(
        'expired',
        '2026-11-08T00:00:00Z',
        undefined,
        2,
    );
    expect(page.organizationIds).toEqual(['org-a']);
    expect(page.cursor).toEqual(expect.any(String));
    expect(query.mock.calls[0][0]).toContain('LIMIT $4');
    expect(query.mock.calls[0][0]).not.toMatch(/SELECT\s+(\*|record)/i);
    await reader.page('expired', '2026-11-08T00:00:00Z', page.cursor, 2);
    expect(query.mock.calls[1][1]).toEqual([
        '2026-11-08T00:00:00Z',
        '2026-10-02T00:00:00.000Z',
        rows[1].receipt_id,
        2,
    ]);
});

it('advances over old terminal candidates even when retention later protects them', async () => {
    const query = jest.fn(async (..._args: unknown[]) => [
        {
            organization_id: 'org-a',
            receipt_id: '00000000-0000-4000-8000-000000000001',
            due_at: '2026-10-01T00:00:00Z',
        },
    ]);
    const reader = new ExternalMaintenanceCandidates({
        source: async () => ({ query }),
    } as never);
    const page = await reader.page(
        'terminal',
        '2026-10-09T00:00:00Z',
        undefined,
        1,
    );
    expect(page.cursor).toBeTruthy();
    expect(query.mock.calls[0][0]).toContain('terminal_at');
    query.mockResolvedValueOnce([]);
    expect(
        await reader.page('terminal', '2026-10-09T00:00:00Z', page.cursor, 1),
    ).toEqual({ organizationIds: [], cursor: undefined });
});

it('refuses malformed cursors and unbounded windows before querying', async () => {
    const source = jest.fn();
    const reader = new ExternalMaintenanceCandidates({ source } as never);
    await expect(
        reader.page('expired', '2026-11-08T00:00:00Z', 'untrusted', 25),
    ).rejects.toThrow();
    await expect(
        reader.page('expired', '2026-11-08T00:00:00Z', undefined, 501),
    ).rejects.toThrow();
    expect(source).not.toHaveBeenCalled();
});
