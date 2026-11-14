import { RuntimePoolController, POOL_USD_PER_MACHINE_HOUR } from '../application/pool-controller.service';
import type { PoolPolicy, PoolUsage } from '../domain/pool';
import type { ProductEnvironment, ProductEnvironmentStore } from '../domain/ports';
import { config, FakeOutbox, ORG } from './fixtures';

class Envs implements Pick<ProductEnvironmentStore, 'setPoolApplied' | 'markPoolActivity' | 'listPoolManagedAcrossOrganizations'> {
    rows: ProductEnvironment[] = [];
    find = (o: string, id: string) => this.rows.find((e) => e.organizationId === o && e.environmentId === id)!;
    async setPoolApplied(o: string, id: string, size: number, usage: PoolUsage) {
        Object.assign(this.find(o, id), { poolAppliedSize: size, poolUsage: usage });
    }
    async markPoolActivity(o: string, id: string, at: Date) {
        this.find(o, id).poolActivityAt = at.toISOString();
    }
    async listPoolManagedAcrossOrganizations(limit: number) {
        return this.rows.filter((e) => e.poolPolicy || (e.poolAppliedSize ?? 0) > 0).slice(0, limit);
    }
}

// São Paulo time: 2026-11-04 is a Wednesday.
const at = (local: string) => new Date(`${local}-03:00`);
const weekdays: PoolPolicy = { schedule: { timezone: 'America/Sao_Paulo', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '19:00' } };

function setup(policy: PoolPolicy | null, start: string) {
    let now = at(start);
    const envs = new Envs();
    envs.rows.push({
        environmentId: 'env-1',
        organizationId: ORG,
        teamId: 't',
        repositoryId: 'r',
        repositoryName: 'acme/shop',
        state: 'active',
        poolSize: 2,
        poolPolicy: policy,
        createdAt: '',
        updatedAt: '',
    });
    const outbox = new FakeOutbox();
    const pool = new RuntimePoolController(envs as unknown as ProductEnvironmentStore, config(), outbox, () => now);
    const asked = () => outbox.rows.map((r) => r.payload.payload.size);
    return { pool, envs, env: () => envs.rows[0], asked, set: (local: string) => (now = at(local)) };
}

describe('RuntimePoolController', () => {
    it('opens and closes the pool with the schedule, asking the cell only when the size changes', async () => {
        const s = setup(weekdays, '2026-11-04T07:55');
        await s.pool.tick();
        expect(s.asked()).toEqual([0]);
        s.set('2026-11-04T08:00');
        await s.pool.tick();
        s.set('2026-11-04T08:05');
        await s.pool.tick();
        expect(s.asked()).toEqual([0, 2]);
        s.set('2026-11-04T19:00');
        await s.pool.tick();
        expect(s.asked()).toEqual([0, 2, 0]);
        expect(s.pool.status(s.env())).toMatchObject({ size: 0, reason: 'outside_schedule' });
    });

    it('a pull request warms a cold pool at once and it cools after the idle time', async () => {
        const s = setup({ ...weekdays, onPullRequest: { idleMinutes: 30 } }, '2026-11-04T21:00');
        await s.pool.tick();
        await s.pool.onPullRequest(s.env());
        expect(s.asked()).toEqual([0, 2]);
        expect(s.pool.status(s.env())).toMatchObject({ size: 2, reason: 'pull_request' });
        s.set('2026-11-04T21:25');
        await s.pool.tick();
        expect(s.asked()).toEqual([0, 2]);
        s.set('2026-11-04T21:31');
        await s.pool.tick();
        expect(s.asked()).toEqual([0, 2, 0]);
    });

    it('a pull request without the warm-up in the policy only restarts the clock', async () => {
        const s = setup(weekdays, '2026-11-04T21:00');
        await s.pool.tick();
        await s.pool.onPullRequest(s.env());
        expect(s.asked()).toEqual([0]);
        expect(s.env().poolActivityAt).toBe(at('2026-11-04T21:00').toISOString());
    });

    it('counts the machine-minutes it kept ready and stops at the budget', async () => {
        // Two machines an hour cost 2 × list price; a budget of one hour's worth runs out after an hour.
        const s = setup({ monthlyBudgetUsd: Math.round(2 * POOL_USD_PER_MACHINE_HOUR * 100) / 100 }, '2026-11-04T10:00');
        await s.pool.tick();
        expect(s.asked()).toEqual([2]);
        for (let m = 5; m <= 60; m += 5) {
            s.set(m === 60 ? '2026-11-04T11:00' : `2026-11-04T10:${String(m).padStart(2, '0')}`);
            await s.pool.tick();
        }
        expect(s.env().poolUsage!.machineMinutes).toBe(120);
        expect(s.asked()).toEqual([2, 0]);
        expect(s.pool.status(s.env())).toMatchObject({ size: 0, reason: 'budget', spentUsd: 0.81 });
    });

    it('without a policy the size holds, and the estimate is the whole month', async () => {
        const s = setup(null, '2026-11-08T03:00');
        await s.pool.tick();
        expect(s.asked()).toEqual([]);
        expect(s.pool.status(s.env())).toMatchObject({ size: 2, reason: 'always', estimate: { hours: 731 } });
    });
});
