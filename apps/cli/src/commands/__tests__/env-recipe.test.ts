import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvHealth, EnvStatus } from '../../types/env.js';

vi.mock('../../utils/team-key-auth.js', () => ({
    resolveTeamKeyAccess: vi.fn(async () => ({ teamKey: 'kodus_test' })),
}));

import { collectRecipe } from '../../features/env-recipe/recipe-files.js';
import { EnvService, envService } from '../../services/env.service.js';
import { envCommand, formatRecipeCheck, waitForSetup } from '../env.js';

const rpc = (structuredContent: unknown, isError = false) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { structuredContent, isError },
});

const RECIPE =
    'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: web\n';

describe('kodus env recipe', () => {
    let dir: string;
    beforeEach(async () => {
        vi.restoreAllMocks();
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-env-recipe-'));
        await fs.mkdir(path.join(dir, '.kodus'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('registers check, guide and submit under env recipe', () => {
        const recipe = envCommand.commands.find((c) => c.name() === 'recipe')!;
        expect(recipe.commands.map((c) => c.name()).sort()).toEqual([
            'check',
            'guide',
            'submit',
        ]);
        const submit = recipe.commands.find((c) => c.name() === 'submit')!;
        expect(submit.options.map((o) => o.long)).toEqual(
            expect.arrayContaining([
                '--file',
                '--wait',
                '--timeout',
                '--env',
                '--repo-id',
                '--json',
            ]),
        );
    });

    it('reads the Runtime-only recipe first and the build files directly under .kodus/', async () => {
        await fs.writeFile(
            path.join(dir, '.kodus/workspace.yaml'),
            'version: 1\n# runo\n',
        );
        await fs.writeFile(
            path.join(dir, '.kodus/workspace.runtime.yaml'),
            RECIPE,
        );
        await fs.writeFile(
            path.join(dir, '.kodus/compose.yaml'),
            'services: {}\n',
        );
        await fs.mkdir(path.join(dir, '.kodus/nested'));
        await fs.writeFile(path.join(dir, '.kodus/nested/x'), 'ignored');
        const got = await collectRecipe(dir);
        expect(got).toEqual({
            recipePath: '.kodus/workspace.runtime.yaml',
            recipe: RECIPE,
            files: [{ path: '.kodus/compose.yaml', content: 'services: {}\n' }],
        });
    });

    // Behavior: the notes file for the planner is committed with the recipe but is not one of its build files, so it never counts against their limits.
    it('leaves the planner notes file out of the build files', async () => {
        await fs.writeFile(path.join(dir, '.kodus/workspace.yaml'), RECIPE);
        await fs.writeFile(path.join(dir, '.kodus/runtime-notes.md'), 'x'.repeat(20 * 1024));
        await fs.writeFile(path.join(dir, '.kodus/compose.yaml'), 'services: {}\n');
        const got = await collectRecipe(dir);
        expect(got.files).toEqual([{ path: '.kodus/compose.yaml', content: 'services: {}\n' }]);
    });

    it('refuses locally what Kodus would refuse: more than 4 files, a file over 16 KiB, a name it does not take', async () => {
        await fs.writeFile(path.join(dir, '.kodus/workspace.yaml'), RECIPE);
        await fs.writeFile(
            path.join(dir, '.kodus/big'),
            'x'.repeat(16 * 1024 + 1),
        );
        await expect(collectRecipe(dir)).rejects.toThrow(/16 KiB/);
        await fs.rm(path.join(dir, '.kodus/big'));
        for (const n of ['a', 'b', 'c', 'd', 'e']) {
            await fs.writeFile(path.join(dir, `.kodus/${n}`), n);
        }
        await expect(collectRecipe(dir)).rejects.toThrow(/limit is 4/);
        for (const n of ['a', 'b', 'c', 'd', 'e']) {
            await fs.rm(path.join(dir, `.kodus/${n}`));
        }
        await fs.writeFile(path.join(dir, '.kodus/.env'), 'SECRET=1');
        await expect(collectRecipe(dir)).rejects.toThrow(/not allowed/);
    });

    it('says there is no recipe when neither file exists', async () => {
        await expect(collectRecipe(dir)).rejects.toThrow(/No recipe found/);
    });

    it('sends the recipe and its files to env_recipe_submit with the target only when given', async () => {
        const requester = vi.fn(async () =>
            rpc({
                setupRequested: true,
                environmentId: 'env-1',
                recipeDigest: 'sha256:abc',
                setupKey: 'env-1:t',
            }),
        );
        // A directory with no git remote: nothing names the repository.
        const service = new EnvService(requester as any, async () => null);
        await service.submitRecipe({
            recipe: RECIPE,
            files: [{ path: '.kodus/compose.yaml', content: 'x' }],
        });
        const [, init] = (requester.mock.calls[0] as any[]) ?? [];
        expect(JSON.parse(init.body).params).toEqual({
            name: 'env_recipe_submit',
            arguments: {
                recipe: RECIPE,
                files: [{ path: '.kodus/compose.yaml', content: 'x' }],
            },
        });
    });

    it("names the repository by this directory's git remote when no environment is given, so the first recipe makes its environment", async () => {
        const requester = vi.fn(async () =>
            rpc({
                setupRequested: true,
                environmentId: 'env-new',
                recipeDigest: 'sha256:abc',
                setupKey: 'env-new:t',
            }),
        );
        const service = new EnvService(
            requester as any,
            async () => 'git@github.com:Acme/mobile-app.git',
        );
        await service.submitRecipe({ recipe: RECIPE });
        await service.checkRecipe({ recipe: RECIPE });
        await service.submitRecipe({ recipe: RECIPE, environmentId: 'env-9' });
        const args = requester.mock.calls.map(
            (c: any[]) => JSON.parse(c[1].body).params.arguments,
        );
        expect(args[0]).toEqual({ repository: 'Acme/mobile-app', recipe: RECIPE });
        expect(args[1]).toEqual({ repository: 'Acme/mobile-app', recipe: RECIPE });
        // An environment named wins: the remote is not read into the call.
        expect(args[2]).toEqual({ environmentId: 'env-9', recipe: RECIPE });
    });

    it("a refused recipe surfaces the API's own message", async () => {
        const requester = vi.fn(async () =>
            rpc(
                {
                    status: 400,
                    code: 'recipe_refused',
                    message:
                        'Kodus refused the recipe: recipe: version must be 1',
                },
                true,
            ),
        );
        const service = new EnvService(requester as any);
        await expect(
            service.submitRecipe({ recipe: 'version: 2\n' }),
        ).rejects.toThrow(/version must be 1/);
    });

    it('prints each error of a refused check and what Kodus read from a good one', () => {
        const env = { environmentId: 'env-1', repositoryName: 'acme/shop' };
        expect(
            formatRecipeCheck(
                { ok: false, errors: ['recipe: bad'], environment: env },
                '.kodus/workspace.yaml',
                0,
            ).join('\n'),
        ).toContain('  - recipe: bad');
        const ok = formatRecipeCheck(
            {
                ok: true,
                errors: [],
                environment: env,
                summary: {
                    public: 'web',
                    health: '/health',
                    expose: [{ service: 'web', port: 3000, kind: 'http' }],
                },
            },
            '.kodus/workspace.yaml',
            1,
        ).join('\n');
        expect(ok).toContain('web:3000 (http)');
        expect(ok).toContain('kodus env recipe submit --wait');
    });

    describe('waitForSetup', () => {
        const health = (over: Partial<EnvHealth>): EnvHealth => ({
            environmentId: 'env-1',
            state: 'setting_up',
            boots7d: 0,
            blockers: [],
            ...over,
        });
        const STATUS: EnvStatus = {
            environment: {
                environmentId: 'env-1',
                repositoryId: 'r',
                repositoryName: 'acme/shop',
                state: 'blocked',
            },
            blockers: [],
        };

        it("never takes the previous setup's state for the one that boots the sent recipe", async () => {
            const polls = [
                health({ state: 'blocked', setupKey: 'env-1:before' }),
                health({ state: 'setting_up', setupKey: 'env-1:mine' }),
                health({ state: 'active', setupKey: 'env-1:mine' }),
            ];
            vi.spyOn(envService, 'health').mockImplementation(async () =>
                polls.shift()!,
            );
            const status = vi.spyOn(envService, 'status');
            const out = await waitForSetup(
                { environmentId: 'env-1' },
                'env-1:mine',
                60_000,
                { sleep: async () => undefined, intervalMs: 1 },
            );
            expect(out.outcome).toBe('active');
            expect(status).not.toHaveBeenCalled();
        });

        it('ends on its own setup blocked, with the blockers', async () => {
            vi.spyOn(envService, 'health').mockResolvedValue(
                health({ state: 'blocked', setupKey: 'env-1:mine' }),
            );
            vi.spyOn(envService, 'status').mockResolvedValue(STATUS);
            const out = await waitForSetup(
                { environmentId: 'env-1' },
                'env-1:mine',
                60_000,
                { sleep: async () => undefined },
            );
            expect(out).toMatchObject({ outcome: 'blocked', status: STATUS });
        });

        it('times out when its setup never ends', async () => {
            let t = 0;
            vi.spyOn(envService, 'health').mockResolvedValue(
                health({ setupKey: 'env-1:mine' }),
            );
            const out = await waitForSetup(
                { environmentId: 'env-1' },
                'env-1:mine',
                30_000,
                {
                    sleep: async () => undefined,
                    now: () => (t += 10_000),
                    intervalMs: 10_000,
                },
            );
            expect(out.outcome).toBe('timeout');
        });
    });
});
