import { HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { SETUP_REPO_TOKENS_CALLS_MAX } from '@libs/runtime/contracts/setup-repo-tokens';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeSetupRepoTokensUseCase } from '../application/use-cases/setup-repo-tokens.use-case';
import type { ProductEnvironment } from '../domain/ports';
import { signRunToken, signSetupToken } from '../domain/run-token';
import type { SetupCallCounter } from '../domain/setup-calls';
import { clock, config, InMemoryEnvironmentRepositories, NOW, openSealed, ORG, OTHER_ORG, REPO, SECRET, SHA, TEAM } from './fixtures';

// A running setup's next boot downloads the repositories again: the cell
// revoked the tokens of the last one. The product mints them anew for the
// setup the token names, sealed to it, and only while that setup can still
// boot something.

const KEY = 'env-1:2026-10-29T12:00:00.000Z';
const MEMBER = 'repo-billing';

const setup = (over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: ORG,
    repositoryId: REPO,
    key: KEY,
    state: 'setting_up',
    steps: [],
    blockers: [],
    sha: SHA,
    refSource: 'default_branch',
    requestedAt: '2026-10-29T12:00:00.000Z',
    updatedAt: '2026-10-29T12:00:01.000Z',
    ...over,
});

const product: ProductEnvironment = {
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: '',
    updatedAt: '',
};

const bearer = (patch: Record<string, unknown> = {}) =>
    `Bearer ${signSetupToken({ setupKey: KEY, environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 3_600, ...patch } as any, SECRET)}`;

class CountingCounter implements SetupCallCounter {
    readonly counts = new Map<string, number>();
    async take(key: string, max: number) {
        const n = this.counts.get(key) ?? 0;
        if (n >= max) return false;
        this.counts.set(key, n + 1);
        return true;
    }
}

function make(opts: { setup?: EnvironmentSetupRecord | null; members?: string[] } = {}) {
    const record = opts.setup === undefined ? setup() : opts.setup;
    const setups = { get: async (org: string, env: string) => (record && record.organizationId === org && record.environmentId === env ? record : null) };
    const products = { get: async (org: string, env: string) => (org === ORG && env === 'env-1' ? product : null), findByRepository: async () => null };
    const rows = new InMemoryEnvironmentRepositories([{ environmentId: 'env-1', organizationId: ORG }]);
    const minted: Array<{ repositoryId: string; token: string }> = [];
    const repoTokens = {
        issue: async (i: { repositoryId: string }) => {
            const token = `ghs_${i.repositoryId}_${minted.length + 1}`;
            minted.push({ repositoryId: i.repositoryId, token });
            return token;
        },
    };
    const counter = new CountingCounter();
    const uc = new RuntimeSetupRepoTokensUseCase(config(), clock, setups, products, repoTokens, counter, new RuntimeEnvironmentMembers(products, rows));
    const addMember = async (repositoryId: string, alias: string) =>
        rows.add({ environmentId: 'env-1', organizationId: ORG, repositoryId, repositoryName: `acme/${alias}`, fullName: `acme/${alias}`, role: 'member', alias, triggers: true, pairBranches: false });
    return { uc, minted, counter, addMember, rows };
}

const multiRepo = (over: Partial<EnvironmentSetupRecord> = {}) =>
    setup({
        workspace: [
            { repositoryId: REPO, alias: 'shop', role: 'primary', sha: SHA, branch: 'main' },
            { repositoryId: MEMBER, alias: 'billing', role: 'member', sha: 'b'.repeat(40), branch: 'main' },
        ],
        ...over,
    });

describe('POST /internal/runtime/setup-repo-tokens', () => {
    it("a repair boot gets a new download token for each repository of the environment, each for that repository alone, sealed to the setup", async () => {
        const t = make({ setup: multiRepo() });
        await t.addMember(MEMBER, 'billing');
        const out = await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } });

        expect(t.minted.map((m) => m.repositoryId)).toEqual([REPO, MEMBER]);
        expect(openSealed(out.repoToken, KEY)).toBe(t.minted[0].token);
        expect(out.workspace).toHaveLength(1);
        expect(out.workspace![0].repositoryId).toBe(MEMBER);
        expect(openSealed(out.workspace![0].sealedRepoToken, KEY)).toBe(t.minted[1].token);
        // Nothing in the clear: only sealed values leave the product.
        for (const m of t.minted) expect(JSON.stringify(out)).not.toContain(m.token);
    });

    it('asked again for the same boot, it mints new tokens: a token the cell revoked is never answered twice', async () => {
        const t = make();
        const first = await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } });
        const again = await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } });
        expect(openSealed(again.repoToken, KEY)).not.toBe(openSealed(first.repoToken, KEY));
    });

    it('a repository removed from the environment since the setup started gets no token', async () => {
        const t = make({ setup: multiRepo() });
        const out = await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } });
        expect(out.workspace).toBeUndefined();
        expect(t.minted.map((m) => m.repositoryId)).toEqual([REPO]);
    });

    it('refuses a missing, forged, expired or Run token before minting anything (401)', async () => {
        const t = make();
        const run = signRunToken({ runId: 'r', attempt: 1, organizationId: ORG, teamId: TEAM, repositoryId: REPO, prNumber: 1, exp: NOW.getTime() / 1000 + 600 }, SECRET);
        for (const authorization of [undefined, 'Bearer kst1.x.y', bearer({ exp: NOW.getTime() / 1000 - 1 }), `Bearer ${run}`]) {
            await expect(t.uc.execute({ authorization, body: { attempt: 'repair-1' } })).rejects.toThrow(UnauthorizedException);
        }
        expect(t.minted).toEqual([]);
    });

    it("a token of a setup the environment no longer runs, of another repository or of another org reads as absent (404)", async () => {
        const t = make();
        for (const patch of [{ setupKey: 'env-1:2026-10-29T11:00:00.000Z' }, { repositoryId: 'repo-x' }, { organizationId: OTHER_ORG }, { environmentId: 'env-2' }]) {
            await expect(t.uc.execute({ authorization: bearer(patch), body: { attempt: 'repair-1' } })).rejects.toThrow(NotFoundException);
        }
        expect(t.minted).toEqual([]);
    });

    it('a repair boot of a setup that has ended is refused as setup_finished (409), with nothing minted', async () => {
        for (const state of ['active', 'blocked'] as const) {
            const t = make({ setup: setup({ state }) });
            const e = await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } }).catch((x) => x);
            expect(e.getStatus()).toBe(409);
            expect(e.getResponse()).toMatchObject({ code: 'setup_finished' });
            expect(t.minted).toEqual([]);
        }
    });

    it("the setup's first boot gets new tokens while the setup runs (its request waited past the command's), and none once it ended", async () => {
        const t = make();
        const out = await t.uc.execute({ authorization: bearer(), body: { attempt: 'boot' } });
        expect(openSealed(out.repoToken, KEY)).toBe(t.minted[0].token);

        for (const state of ['active', 'blocked'] as const) {
            const ended = make({ setup: setup({ state }) });
            const e = await ended.uc.execute({ authorization: bearer(), body: { attempt: 'boot' } }).catch((x) => x);
            expect(e.getStatus()).toBe(409);
            expect(ended.minted).toEqual([]);
        }
    });

    it('the first boot asks at most twice (before it boots, and once after expired tokens), plus three asked again', async () => {
        const t = make();
        const outcomes: number[] = [];
        for (let i = 0; i < SETUP_REPO_TOKENS_CALLS_MAX.boot + 1; i++) {
            outcomes.push(await t.uc.execute({ authorization: bearer(), body: { attempt: 'boot' } }).then(() => 200, (e: HttpException) => e.getStatus()));
        }
        expect(SETUP_REPO_TOKENS_CALLS_MAX.boot).toBe(5);
        expect(outcomes).toEqual([200, 200, 200, 200, 200, 429]);
        // Its own count: the repairs keep theirs.
        await expect(t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } })).resolves.toBeDefined();
    });

    it("a learn boot gets tokens while the blocked setup's learn loop is trying that hypothesis, its replay included", async () => {
        const learning = setup({
            state: 'blocked',
            finishedAt: '2026-10-29T12:20:00.000Z',
            learn: { tried: [{ signature: 'sig', count: 2 }], attempts: [{ n: 2, signature: 'sig', result: 'trying', setupKey: KEY, at: '2026-10-29T12:21:00.000Z' }] },
        });
        const t = make({ setup: learning });
        // Hypothesis 2 boots as learn-3, its replay as learn-4.
        for (const attempt of ['learn-3', 'learn-4']) {
            const out = await t.uc.execute({ authorization: bearer(), body: { attempt } });
            expect(openSealed(out.repoToken, KEY)).toMatch(/^ghs_/);
        }
    });

    it('a learn boot is setup_finished once the loop stopped, for a hypothesis it is not trying, or for one of an earlier setup', async () => {
        const attempt = { n: 1, signature: 'sig', result: 'trying' as const, setupKey: KEY, at: '2026-10-29T12:21:00.000Z' };
        const cases: Array<Partial<EnvironmentSetupRecord>> = [
            { state: 'blocked', learn: { tried: [], attempts: [attempt], stopped: 'proven' } },
            { state: 'blocked', learn: { tried: [], attempts: [{ ...attempt, result: 'blocked' }] } },
            { state: 'blocked', learn: { tried: [], attempts: [{ ...attempt, setupKey: 'env-1:earlier' }] } },
            { state: 'blocked' },
            { state: 'setting_up', learn: { tried: [], attempts: [attempt] } },
        ];
        for (const over of cases) {
            const t = make({ setup: setup(over) });
            const e = await t.uc.execute({ authorization: bearer(), body: { attempt: 'learn-2' } }).catch((x) => x);
            expect(e.getStatus()).toBe(409);
            expect(e.getResponse()).toMatchObject({ code: 'setup_finished' });
            expect(t.minted).toEqual([]);
        }
    });

    it('a setup asking more tokens than its boots could need is refused (429) with nothing minted', async () => {
        const t = make();
        const max = SETUP_REPO_TOKENS_CALLS_MAX.repair;
        const outcomes: number[] = [];
        for (let i = 0; i < max + 2; i++) {
            outcomes.push(
                await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } }).then(
                    () => 200,
                    (e: HttpException) => e.getStatus(),
                ),
            );
        }
        expect(outcomes).toEqual([...Array(max).fill(200), 429, 429]);
        expect(t.minted).toHaveLength(max);
    });

    it("a refusal is left to the API's exception filter: the exception carries the setup's ids and the cause, and the use case logs nothing", async () => {
        const t = make();
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (t.uc as any).logger = logger;
        const down = new Error('counter down');
        t.counter.take = async () => Promise.reject(down);
        const unavailable = await t.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } }).catch((e) => e);
        expect(unavailable).toMatchObject({ status: 503, organizationId: ORG, environmentId: 'env-1', attempt: 'repair-1', cause: down });

        const failing = make();
        (failing.uc as any).logger = logger;
        (failing.uc as any).repoTokens = { issue: async () => Promise.reject(new TypeError('a platform message with request details')) };
        const unissued = await failing.uc.execute({ authorization: bearer(), body: { attempt: 'repair-1' } }).catch((e) => e);
        // Only the name of what the issuer threw rides along: its message may carry request details.
        expect(unissued).toMatchObject({ status: 502, repositoryId: REPO, errorName: 'TypeError' });
        expect(unissued.cause).toBeUndefined();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });
});
