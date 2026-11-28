import { existsSync } from 'fs';
import { join } from 'path';
import {
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { signRunToken } from '../domain/run-token';
import {
    BASE_SHA,
    clock,
    config,
    NOW,
    OTHER_ORG,
    run,
    SECRET,
    SHA,
    storeWith,
} from './fixtures';
const load = () => {
    const file = join(
        __dirname,
        '../application/use-cases/planner-source.use-case.ts',
    );
    expect(existsSync(file)).toBe(true);
    return require(file).RuntimePlannerSourceUseCase;
};
async function setup() {
    const r = run({ state: 'testing' });
    const auth = (patch = {}) =>
        `Bearer ${signRunToken({ runId: r.runId, attempt: r.attempt, organizationId: r.organizationId, teamId: r.teamId, repositoryId: r.repositoryId, prNumber: r.prNumber, exp: NOW.getTime() / 1000 + 3600, ...patch }, SECRET)}`;
    const git = {
        getPullRequestHead: jest.fn(async () => ({ headSha: r.headSha })),
        getPullRequestDiff: jest.fn(async () => ({
            files: [
                { path: 'changed.ts', status: 'modified', patch: '+changed' },
            ],
            truncated: false,
        })),
        listFilesAtCommit: jest.fn(async () => ['changed.ts', 'base-only.ts']),
        readFileAtCommit: jest.fn(async (i: any) =>
            i.path === '.env'
                ? 'TOKEN=supersecret\nPORT=3000'
                : 'source at exact commit',
        ),
    };
    const uc = new (load())(config(), clock, await storeWith(r), git);
    const scope = { runId: r.runId, attempt: r.attempt };
    const call = (body: unknown, authorization = auth()) =>
        uc.execute({ authorization, body: { v: 1, scope, ...(body as any) } });
    return { uc, git, r, auth, call, scope };
}
describe('product-scoped planner source', () => {
    it('reads exact base/head commits without allowing caller-selected repositories or SHAs', async () => {
        const h = await setup();
        expect(await h.call({ op: 'context' })).toMatchObject({
            repositoryName: h.r.repositoryName,
            baseSha: BASE_SHA,
            headSha: SHA,
        });
        await h.call({
            op: 'read',
            side: 'base',
            path: 'base-only.ts',
            maxBytes: 1024,
        });
        expect(h.git.readFileAtCommit).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sha: BASE_SHA,
                repositoryId: h.r.repositoryId,
                path: 'base-only.ts',
            }),
        );
        await h.call({
            op: 'read',
            side: 'head',
            path: 'changed.ts',
            maxBytes: 1024,
        });
        expect(h.git.readFileAtCommit).toHaveBeenLastCalledWith(
            expect.objectContaining({ sha: SHA, path: 'changed.ts' }),
        );
        await expect(
            h.call({
                op: 'read',
                side: 'head',
                path: 'base-only.ts',
                maxBytes: 1024,
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            h.call({
                op: 'read',
                side: 'base',
                path: 'changed.ts',
                sha: 'f'.repeat(40),
                maxBytes: 1024,
            }),
        ).rejects.toThrow();
    });
    it('refuses another org, attempt, traversal and an active PR that moved before trusted head-file discovery', async () => {
        const h = await setup();
        await expect(
            h.call({ op: 'context' }, h.auth({ organizationId: OTHER_ORG })),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            h.call({ op: 'context' }, h.auth({ teamId: 'other-team' })),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            h.uc.execute({
                authorization: h.auth(),
                body: {
                    v: 1,
                    scope: { ...h.scope, attempt: 2 },
                    op: 'context',
                },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            h.call({
                op: 'read',
                side: 'base',
                path: '../../secret',
                maxBytes: 1024,
            }),
        ).rejects.toThrow();
        h.git.getPullRequestHead.mockResolvedValueOnce({
            headSha: 'c'.repeat(40),
        });
        await expect(h.call({ op: 'context' })).rejects.toBeInstanceOf(
            ConflictException,
        );
    });
    it('withholds secret file values and bounds repository listings and read data', async () => {
        const h = await setup();
        const env = await h.call({
            op: 'read',
            side: 'base',
            path: '.env',
            maxBytes: 1024,
        });
        expect(JSON.stringify(env)).not.toContain('supersecret');
        expect(env).toMatchObject({ text: expect.stringContaining('TOKEN') });
        await expect(
            h.call({
                op: 'read',
                side: 'base',
                path: 'changed.ts',
                maxBytes: 2_000_000,
            }),
        ).rejects.toThrow();
        const out = await h.call({ op: 'list', side: 'base', path: '' });
        expect(out).toEqual({ entries: ['base-only.ts', 'changed.ts'] });
    });
    it('never exposes raw Git diagnostics in a source context failure', async () => {
        const h = await setup();
        h.git.getPullRequestHead.mockRejectedValueOnce(
            new Error('PRIVATE_GIT_DIAGNOSTIC'),
        );
        const error = await h.call({ op: 'context' }).catch((e: unknown) => e);
        expect(error.getStatus()).toBe(502);
        expect(JSON.stringify(error.getResponse())).not.toContain(
            'PRIVATE_GIT_DIAGNOSTIC',
        );
    });
});
