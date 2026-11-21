import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { recipeDigest } from '@libs/runtime/run/recipe';
import { inferRecipe } from '@libs/runtime/run/recipe-inference';

import { ProposeInferredRecipeUseCase } from '../application/use-cases/propose-inferred-recipe.use-case';

const ORG = 'org-1';
const SETUP_SHA = 'a'.repeat(40);
const COMPOSE = 'services:\n  web: { build: ., ports: ["3000"] }\n';
const inferred = inferRecipe({ compose: { path: 'compose.yaml', text: COMPOSE } });
if (inferred.status !== 'inferred') throw new Error('fixture');
const RECIPE = inferred.content;
const user = { uuid: 'user-1', organization: { uuid: ORG } };
const product = { environmentId: 'env-1', organizationId: ORG, teamId: 'team-1', repositoryId: 'repo-1', repositoryName: 'acme/shop' };

const setupRecord = (
    over: Partial<EnvironmentSetupRecord> = {},
    recipe: Partial<NonNullable<EnvironmentSetupRecord['recipe']>> = {},
): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: ORG,
    repositoryId: 'repo-1',
    key: 'k2',
    state: 'active',
    steps: [],
    blockers: [],
    sha: SETUP_SHA,
    branch: 'main',
    refSource: 'default_branch',
    recipe: {
        path: '.kodus/workspace.yaml',
        sha: SETUP_SHA,
        state: 'found',
        content: RECIPE,
        digest: recipeDigest(RECIPE),
        origin: 'inferred',
        cleanBoots: 2,
        ...recipe,
    },
    requestedAt: '2026-11-03T12:00:00.000Z',
    updatedAt: '2026-11-03T12:00:00.000Z',
    ...over,
});

function make(
    rec: EnvironmentSetupRecord | null = setupRecord(),
    opts: { files?: Record<string, string>; headSha?: string; deny?: boolean; gitDown?: boolean; refused?: boolean } = {},
) {
    const files = opts.files ?? { 'compose.yaml': COMPOSE };
    const git = {
        getDefaultBranchHead: jest.fn(async () => {
            if (opts.gitDown) throw new Error('Bad credentials');
            return { status: 'ok', branch: 'main', sha: opts.headSha ?? SETUP_SHA };
        }),
        readFileAtCommit: jest.fn(async (input: { path: string }) => files[input.path] ?? null),
        openPullRequestWithFiles: jest.fn(async (_input: { body: string; files: unknown }) =>
            opts.refused ? null : { number: 52, url: 'https://github.com/acme/shop/pull/52' },
        ),
    };
    const authorization = {
        ensure: jest.fn(async () => {
            if (opts.deny) throw new ForbiddenException();
        }),
    };
    const environment = {
        load: jest.fn(async (_u: unknown, id: string) => {
            if (id !== 'env-1') throw new NotFoundException('Environment not found');
            return { env: { environmentId: 'env-1', organizationId: ORG, repositoryId: 'repo-1' }, runs: [] };
        }),
        setup: jest.fn().mockResolvedValue(rec),
    };
    const useCase = new ProposeInferredRecipeUseCase(environment as any, { get: jest.fn().mockResolvedValue(product) }, authorization as any, git as any);
    return { useCase, git, authorization };
}

const run = (t: ReturnType<typeof make>) => t.useCase.execute({ user, environmentId: 'env-1' });

describe('ProposeInferredRecipeUseCase', () => {
    it('opens the PR that adds the proven recipe, as it booted, on the default branch', async () => {
        const t = make();
        await expect(run(t)).resolves.toEqual({ pullRequest: { number: 52, url: 'https://github.com/acme/shop/pull/52' } });
        expect(t.authorization.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'update', resource: 'runtime_environment', repoIds: ['repo-1'] }),
        );
        const pr = t.git.openPullRequestWithFiles.mock.calls[0][0];
        expect(pr).toMatchObject({
            baseBranch: 'main',
            branch: `kody-runtime/recipe-${recipeDigest(RECIPE).slice(7, 19)}`,
            title: 'chore(kody-runtime): add the environment recipe Kodus inferred',
            files: [{ path: '.kodus/workspace.yaml', content: RECIPE }],
            repositoryName: 'acme/shop',
            teamId: 'team-1',
        });
        expect(pr.body).toContain('booted it from zero on 2 clean machines at `aaaaaaaaaaaa`');
        expect(pr.body).toContain(`\`\`\`yaml\n${RECIPE.trimEnd()}\n\`\`\``);
        // Both recipe paths were checked at the head; the files were not read again (same head as the setup).
        expect(t.git.readFileAtCommit.mock.calls.map(([i]) => i.path)).toEqual(['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml']);
    });

    it('waits for a second clean boot before proposing (ENV-06)', async () => {
        await expect(run(make(setupRecord({}, { cleanBoots: 1 })))).rejects.toThrow(/booted from zero once/);
        await expect(run(make(setupRecord({}, { cleanBoots: undefined })))).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses what is not a booted inferred recipe', async () => {
        await expect(run(make(null))).rejects.toThrow(/nothing to propose/);
        await expect(run(make(setupRecord({}, { origin: undefined })))).rejects.toThrow(/nothing to propose/);
        await expect(run(make(setupRecord({ state: 'blocked' })))).rejects.toThrow(/did not boot/);
        await expect(run(make(setupRecord({}, { content: `${RECIPE}# edited\n` })))).rejects.toThrow(/does not match/);
    });

    it('is 409 when a recipe appeared on the default branch meanwhile', async () => {
        for (const path of ['.kodus/workspace.yaml', '.kodus/workspace.runtime.yaml']) {
            const t = make(setupRecord(), { files: { 'compose.yaml': COMPOSE, [path]: 'version: 1\n' } });
            const err = await run(t).catch((e) => e);
            expect(err).toBeInstanceOf(ConflictException);
            expect(err.message).toBe(`${path} is on main now. Set up again to boot with it.`);
            expect(t.git.openPullRequestWithFiles).not.toHaveBeenCalled();
        }
    });

    it('after a new head, proposes only while the same files still give the proven recipe', async () => {
        const moved = 'b'.repeat(40);
        await expect(run(make(setupRecord(), { headSha: moved }))).resolves.toMatchObject({ pullRequest: { number: 52 } });
        const changed = make(setupRecord(), { headSha: moved, files: { 'compose.yaml': 'services:\n  web: { build: ., ports: ["8080"] }\n' } });
        await expect(run(changed)).rejects.toThrow(/files changed on main/);
        expect(changed.git.openPullRequestWithFiles).not.toHaveBeenCalled();
    });

    it('a Git failure is a 503 with a plain message, never the platform text', async () => {
        const err = await run(make(setupRecord(), { gitDown: true })).catch((e) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect(err.message).toBe('Kodus could not reach the Git platform for this repository. Check the Git integration and try again.');
        await expect(run(make(setupRecord(), { refused: true }))).rejects.toThrow('The Git platform refused the pull request.');
    });

    it('offers the recipe Kody wrote the same way, after two clean boots, and only at the commit it booted on', async () => {
        const t = make(setupRecord({}, { origin: 'authored', notes: 'The root compose file.' }));
        await expect(run(t)).resolves.toMatchObject({ pullRequest: { number: 52 } });
        const pr = t.git.openPullRequestWithFiles.mock.calls[0][0];
        expect(pr).toMatchObject({ title: 'chore(kody-runtime): add the environment recipe Kody wrote', files: [{ path: '.kodus/workspace.yaml', content: RECIPE }] });
        expect(pr.body).toContain('Kody read the repository and wrote this one. It booted from zero on 2 clean machines at `aaaaaaaaaaaa`');
        await expect(run(make(setupRecord({}, { origin: 'authored', cleanBoots: 1 })))).rejects.toThrow(/The recipe Kody wrote booted from zero once/);
        // No inference can redo Kody's recipe at a new head: a new setup proves it there.
        const moved = make(setupRecord({}, { origin: 'authored' }), { headSha: 'b'.repeat(40) });
        await expect(run(moved)).rejects.toThrow(/main moved since the setup/);
        expect(moved.git.openPullRequestWithFiles).not.toHaveBeenCalled();
    });

    it("adds Kody's build files to the same PR, and refuses a record whose digest does not cover them", async () => {
        const files = [
            { path: '.kodus/Dockerfile', content: 'FROM node:22-bookworm-slim\n' },
            { path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n' },
        ];
        const t = make(setupRecord({}, { origin: 'authored', files, digest: recipeDigest(RECIPE, files) }));
        await expect(run(t)).resolves.toMatchObject({ pullRequest: { number: 52 } });
        const pr = t.git.openPullRequestWithFiles.mock.calls[0][0];
        expect(pr.files).toEqual([{ path: '.kodus/workspace.yaml', content: RECIPE }, ...files]);
        expect(pr.body).toContain('`.kodus/Dockerfile`, `.kodus/compose.yaml`');
        // The recipe's own digest no longer stands for what booted with files.
        await expect(run(make(setupRecord({}, { origin: 'authored', files, digest: recipeDigest(RECIPE) })))).rejects.toThrow('does not match what booted');
        const edited = [files[0], { ...files[1], content: files[1].content + '# changed\n' }];
        await expect(run(make(setupRecord({}, { origin: 'authored', files: edited, digest: recipeDigest(RECIPE, files) })))).rejects.toThrow('does not match what booted');
    });

    it('needs Update on the environment, and another environment is 404', async () => {
        const denied = make(setupRecord(), { deny: true });
        await expect(run(denied)).rejects.toBeInstanceOf(ForbiddenException);
        expect(denied.git.openPullRequestWithFiles).not.toHaveBeenCalled();
        await expect(make().useCase.execute({ user, environmentId: 'env-2' })).rejects.toBeInstanceOf(NotFoundException);
    });
});
