import { SandboxReadBudget } from './sandbox-read-budget';

describe('SandboxReadBudget: what a worker holds of sandbox reads at once', () => {
    it('lets reads in while they fit and holds the next in line until bytes come back', async () => {
        const b = new SandboxReadBudget(10);
        const a = await b.acquire(6);
        let second = false;
        const p = b.acquire(6).then((n) => ((second = true), n));
        await Promise.resolve();
        expect(second).toBe(false);
        expect(b.inUse).toBe(6);
        b.release(a);
        expect(await p).toBe(6);
        expect(second).toBe(true);
        expect(b.inUse).toBe(6);
    });

    it('serves the line in order: a small read does not jump a large one that waits', async () => {
        const b = new SandboxReadBudget(10);
        const first = await b.acquire(8);
        const order: string[] = [];
        const large = b.acquire(9).then(() => order.push('large'));
        const small = b.acquire(1).then(() => order.push('small'));
        await Promise.resolve();
        expect(order).toEqual([]);
        b.release(first);
        await large;
        expect(order).toEqual(['large', 'small'].slice(0, order.length));
        b.release(9);
        await small;
        expect(order).toEqual(['large', 'small']);
    });

    it('clamps a read larger than the whole budget, so it waits for an empty budget instead of forever', async () => {
        const b = new SandboxReadBudget(10);
        expect(await b.acquire(50)).toBe(10);
        expect(b.inUse).toBe(10);
        b.release(10);
        expect(b.inUse).toBe(0);
    });
});
