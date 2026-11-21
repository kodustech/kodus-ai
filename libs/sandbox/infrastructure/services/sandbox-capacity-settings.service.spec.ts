import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';

import {
    CAPACITY_SETTINGS_CACHE_TTL_MS,
    SandboxCapacitySettingsService,
    validateCapacityInput,
} from './sandbox-capacity-settings.service';

function make(stored: unknown, env = { maxConcurrent: 0, maxWaitMs: 600_000 }) {
    const params: any = {
        findByKey: jest.fn().mockResolvedValue(
            stored === undefined ? null : { configValue: stored },
        ),
        createOrUpdateConfig: jest.fn().mockResolvedValue(true),
    };
    const svc = new SandboxCapacitySettingsService(params);
    const clock = { t: 1_000_000 };
    svc.readEnv = () => env;
    svc.now = () => clock.t;
    return { svc, params, clock };
}

describe('SandboxCapacitySettingsService precedence', () => {
    it('uses the env when nothing is stored', async () => {
        const { svc } = make(undefined, { maxConcurrent: 3, maxWaitMs: 120_000 });
        await svc.refresh();
        expect(svc.current()).toEqual({ maxConcurrent: 3, maxWaitMs: 120_000 });
    });

    it('the database value wins over the env', async () => {
        const { svc } = make(
            { maxConcurrent: 7, maxWaitMs: 300_000 },
            { maxConcurrent: 3, maxWaitMs: 120_000 },
        );
        await svc.refresh();
        expect(svc.current()).toEqual({ maxConcurrent: 7, maxWaitMs: 300_000 });
    });

    it('a stored null means no cap even when the env sets one', async () => {
        const { svc } = make({ maxConcurrent: null, maxWaitMs: 300_000 }, { maxConcurrent: 3, maxWaitMs: 1 });
        await svc.refresh();
        expect(svc.current().maxConcurrent).toBe(0);
    });

    it('an absent field defers to the env', async () => {
        const { svc } = make({ maxWaitMs: 300_000 }, { maxConcurrent: 3, maxWaitMs: 1 });
        await svc.refresh();
        expect(svc.current()).toEqual({ maxConcurrent: 3, maxWaitMs: 300_000 });
    });

    it('an invalid stored value keeps the last good settings', async () => {
        const { svc, params, clock } = make({ maxConcurrent: 5, maxWaitMs: 300_000 });
        await svc.refresh();
        params.findByKey.mockResolvedValue({ configValue: { maxConcurrent: 500, maxWaitMs: 300_000 } });
        clock.t += CAPACITY_SETTINGS_CACHE_TTL_MS + 1;
        await svc.refresh();
        expect(svc.current()).toEqual({ maxConcurrent: 5, maxWaitMs: 300_000 });
    });

    it('a failed read keeps the last good settings', async () => {
        const { svc, params, clock } = make({ maxConcurrent: 5, maxWaitMs: 300_000 });
        await svc.refresh();
        params.findByKey.mockRejectedValue(new Error('db down'));
        clock.t += CAPACITY_SETTINGS_CACHE_TTL_MS + 1;
        await svc.refresh();
        expect(svc.current().maxConcurrent).toBe(5);
    });

    it('reads again only after the short cache TTL', async () => {
        const { svc, params, clock } = make({ maxConcurrent: 5, maxWaitMs: 300_000 });
        await svc.refresh();
        await svc.refresh();
        expect(params.findByKey).toHaveBeenCalledTimes(1);
        clock.t += CAPACITY_SETTINGS_CACHE_TTL_MS + 1;
        await svc.refresh();
        expect(params.findByKey).toHaveBeenCalledTimes(2);
    });

    it('update persists under the sandbox_capacity key and applies at once', async () => {
        const { svc, params } = make(undefined);
        params.findByKey.mockResolvedValue({ configValue: { maxConcurrent: 4, maxWaitMs: 900_000 } });
        await svc.update({ maxConcurrent: 4, maxWaitMs: 900_000 });
        expect(params.createOrUpdateConfig).toHaveBeenCalledWith(
            GlobalParametersKey.SANDBOX_CAPACITY,
            { maxConcurrent: 4, maxWaitMs: 900_000 },
        );
        expect(svc.current()).toEqual({ maxConcurrent: 4, maxWaitMs: 900_000 });
    });

    it('update refuses an invalid value without writing', async () => {
        const { svc, params } = make(undefined);
        await expect(svc.update({ maxConcurrent: 0, maxWaitMs: 900_000 })).rejects.toThrow();
        expect(params.createOrUpdateConfig).not.toHaveBeenCalled();
    });
});

describe('validateCapacityInput', () => {
    it.each([
        [1, 60_000, true],
        [100, 3_600_000, true],
        [null, 600_000, true],
        [0, 600_000, false],
        [101, 600_000, false],
        [2.5, 600_000, false],
        ['3', 600_000, false],
        [5, 59_999, false],
        [5, 3_600_001, false],
        [5, 'x', false],
    ])('maxConcurrent=%p maxWaitMs=%p valid=%p', (c, w, ok) => {
        expect(validateCapacityInput({ maxConcurrent: c, maxWaitMs: w }) === null).toBe(ok);
    });
});
