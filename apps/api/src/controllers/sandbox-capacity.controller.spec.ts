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
        return { settings, gate, c: new SandboxCapacityController(settings, gate) };
    }

    it('returns the settings, the live numbers and no cell facts with the reason', async () => {
        const { c } = make();
        expect(await c.get()).toEqual({
            settings: { maxConcurrent: 5, maxWaitMs: 600_000 },
            saved: true,
            live: { inUse: 4, cap: 5, queued: 2, oldestWaitMs: 72_000 },
            suggestedMaxConcurrent: null,
            cell: null,
            cellUnavailableReason: 'cell_facts_not_exposed_by_hub',
        });
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
