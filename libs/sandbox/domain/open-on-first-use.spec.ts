import { openOnFirstUse } from './open-on-first-use';

describe('openOnFirstUse', () => {
    it('opens nothing until the first use', async () => {
        const open = jest.fn().mockResolvedValue('sandbox');
        const lazy = openOnFirstUse(open);

        await expect(lazy.settled()).resolves.toBeUndefined();
        expect(open).not.toHaveBeenCalled();
    });

    it('opens once for concurrent and later uses', async () => {
        let resolve!: (v: string) => void;
        const open = jest.fn(() => new Promise<string>((r) => (resolve = r)));
        const lazy = openOnFirstUse(open);

        const first = lazy.open();
        const second = lazy.open();
        resolve('sandbox');

        await expect(Promise.all([first, second])).resolves.toEqual([
            'sandbox',
            'sandbox',
        ]);
        await expect(lazy.open()).resolves.toBe('sandbox');
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('waits for an open still in flight when settled', async () => {
        let resolve!: (v: string) => void;
        const lazy = openOnFirstUse(
            () => new Promise<string>((r) => (resolve = r)),
        );

        void lazy.open();
        const settled = lazy.settled();
        resolve('sandbox');

        await expect(settled).resolves.toBe('sandbox');
    });

    it('keeps a failed open failed, without opening again', async () => {
        const open = jest.fn().mockRejectedValue(new Error('clone failed'));
        const lazy = openOnFirstUse(open);

        await expect(lazy.open()).rejects.toThrow('clone failed');
        await expect(lazy.open()).rejects.toThrow('clone failed');
        await expect(lazy.settled()).rejects.toThrow('clone failed');
        expect(open).toHaveBeenCalledTimes(1);
    });
});
