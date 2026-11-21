import { ExternalMaintenanceSweep } from './maintenance-sweep';

function fixture() {
    const page = jest.fn(async (kind: string) => ({
        organizationIds: ['org-a'],
        cursor: kind + '-next',
    }));
    const tasks = ['task-a', 'task-b', 'task-c'];
    const listExpiredTaskIds = jest.fn(async () => tasks);
    const purgeTerminal = jest.fn(async () => 1);
    const reconcileTask = jest.fn(async () => 'completed');
    return {
        page,
        listExpiredTaskIds,
        purgeTerminal,
        reconcileTask,
        sweep: new ExternalMaintenanceSweep(
            { page } as never,
            { listExpiredTaskIds, purgeTerminal },
            { reconcileTask } as never,
            () => new Date('2026-11-08T00:00:00Z'),
            { maxTasks: 2, candidateWindow: 25, retentionDays: 30 },
        ),
    };
}

it('scopes every task operation and bounds reconciliation and purge without making new work', async () => {
    const h = fixture();
    const summary = await h.sweep.run(new AbortController().signal);
    expect(h.reconcileTask.mock.calls.map((c) => c.slice(0, 2))).toEqual([
        ['org-a', 'task-a'],
        ['org-a', 'task-b'],
    ]);
    expect(h.listExpiredTaskIds).toHaveBeenCalledWith(
        'org-a',
        '2026-11-08T00:00:00.000Z',
        2,
    );
    expect(h.purgeTerminal).toHaveBeenCalledWith(
        'org-a',
        '2026-10-09T00:00:00.000Z',
        2,
    );
    expect(summary).toMatchObject({
        reconciled: 2,
        completed: 2,
        purged: 1,
        errors: 0,
    });
});

it('advances both administrative cursors even when candidates are protected or an org fails', async () => {
    const h = fixture();
    h.listExpiredTaskIds.mockRejectedValueOnce(new Error('private detail'));
    h.purgeTerminal.mockResolvedValue(0);
    expect((await h.sweep.run(new AbortController().signal)).errors).toBe(1);
    await h.sweep.run(new AbortController().signal);
    expect(h.page.mock.calls[2]).toEqual([
        'expired',
        '2026-11-08T00:00:00.000Z',
        'expired-next',
        25,
    ]);
    expect(h.page.mock.calls[3]).toEqual([
        'terminal',
        '2026-10-09T00:00:00.000Z',
        'terminal-next',
        25,
    ]);
});

it('stops admitting work after cancellation and does not turn cancellation into a terminal decision', async () => {
    const h = fixture();
    const controller = new AbortController();
    h.reconcileTask.mockImplementationOnce(async () => {
        controller.abort();
        return 'completed';
    });
    const summary = await h.sweep.run(controller.signal);
    expect(h.reconcileTask).toHaveBeenCalledTimes(1);
    expect(h.purgeTerminal).not.toHaveBeenCalled();
    expect(summary.budgetStopped).toBe(true);
});
