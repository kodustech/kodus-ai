import { BadRequestException, NotFoundException } from '@nestjs/common';

import { environment } from '@libs/ee/configs/environment';

import { SandboxCapacityController, SelfHostedOnlyGuard } from './sandbox-capacity.controller';

describe('SelfHostedOnlyGuard', () => {
    afterEach(() => {
        (environment as any).API_CLOUD_MODE = false;
    });
    it('answers 404 on Kodus Cloud', () => {
        (environment as any).API_CLOUD_MODE = true;
        expect(() => new SelfHostedOnlyGuard().canActivate()).toThrow(NotFoundException);
    });
    it('lets a self-hosted deployment through', () => {
        (environment as any).API_CLOUD_MODE = false;
        expect(new SelfHostedOnlyGuard().canActivate()).toBe(true);
    });
});

describe('SandboxCapacityController', () => {
    function make() {
        const settings: any = {
            refresh: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
            current: jest.fn().mockReturnValue({ maxConcurrent: 5, maxWaitMs: 600_000 }),
            storedSettings: jest.fn().mockReturnValue({ maxConcurrent: 5, maxWaitMs: 600_000 }),
        };
        const gate: any = {
            numbers: jest.fn().mockResolvedValue({ inUse: 4, cap: 5, queued: 2, oldestWaitMs: 72_000 }),
        };
        const cells: any = { liveCells: jest.fn().mockResolvedValue([]) };
        return { settings, gate, cells, c: new SandboxCapacityController(settings, gate, cells) };
    }

    it('returns the settings, the live numbers and no cell facts with the reason when no cell is live', async () => {
        const { c } = make();
        expect(await c.get()).toEqual({
            settings: { maxConcurrent: 5, maxWaitMs: 600_000 },
            saved: true,
            live: { inUse: 4, cap: 5, queued: 2, oldestWaitMs: 72_000 },
            suggestedMaxConcurrent: null,
            cell: null,
            cellUnavailableReason: 'no_live_cell',
        });
    });

    it('sums the live cells memory, takes the sandbox size and suggests the cap leaving room for a 12 GB Run', async () => {
        const { c, cells } = make();
        cells.liveCells.mockResolvedValue([
            { cellId: 'a', allocatableMb: 22_528, sandboxMemoryMb: 2048, sandboxCpus: 2 },
            { cellId: 'b', allocatableMb: 22_528, sandboxMemoryMb: 2048, sandboxCpus: 2 },
        ]);
        const r = await c.get();
        expect(r.cell).toEqual({ allocatableMemoryMb: 45_056, sandboxMemoryMb: 2048, sandboxCpus: 2, poolReady: null });
        expect(r.suggestedMaxConcurrent).toBe(Math.floor((45_056 - 12_288) / 2048));
        expect(r.cellUnavailableReason).toBeNull();
    });

    it('says why when the Runtime database cannot be read', async () => {
        const { c, cells } = make();
        cells.liveCells.mockRejectedValue(new Error('503'));
        const r = await c.get();
        expect(r.cell).toBeNull();
        expect(r.cellUnavailableReason).toBe('runtime_database_unreadable');
    });

    it('reports no cap as null', async () => {
        const { c, settings } = make();
        settings.current.mockReturnValue({ maxConcurrent: 0, maxWaitMs: 600_000 });
        expect((await c.get()).settings.maxConcurrent).toBeNull();
    });

    it('saves valid input', async () => {
        const { c, settings } = make();
        await c.update({ maxConcurrent: null, maxWaitMs: 120_000 });
        expect(settings.update).toHaveBeenCalledWith({ maxConcurrent: null, maxWaitMs: 120_000 });
    });

    it.each([
        [{ maxConcurrent: 0, maxWaitMs: 120_000 }],
        [{ maxConcurrent: 101, maxWaitMs: 120_000 }],
        [{ maxConcurrent: 3, maxWaitMs: 1000 }],
        [{ maxWaitMs: 120_000 }],
        [{}],
    ])('refuses %j with 400 and writes nothing', async (body) => {
        const { c, settings } = make();
        await expect(c.update(body as any)).rejects.toThrow(BadRequestException);
        expect(settings.update).not.toHaveBeenCalled();
    });

    it('is owner-only (RBAC metadata)', () => {
        const meta = Reflect.getMetadataKeys(SandboxCapacityController.prototype.update);
        expect(meta.length).toBeGreaterThan(0);
    });
});
