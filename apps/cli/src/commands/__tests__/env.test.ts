import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvStatus } from '../../types/env.js';

vi.mock('../../utils/team-key-auth.js', () => ({
    resolveTeamKeyAccess: vi.fn(async () => ({ teamKey: 'kodus_test' })),
}));

import { EnvService } from '../../services/env.service.js';
import {
    envCommand,
    formatEnvFix,
    formatEnvStatus,
    formatRecipeCheck,
} from '../env.js';

const STATUS: EnvStatus = {
    environment: {
        environmentId: 'env-1',
        repositoryId: 'repo-1',
        repositoryName: 'acme/shop',
        state: 'blocked',
    },
    blockers: [
        {
            signature: 'missing_env:SESSION_SECRET',
            kind: 'missing_env',
            title: 'SESSION_SECRET is not set',
            count: 2,
            lastPr: 12,
            evidence: { lines: ['Error: SESSION_SECRET is not set'] },
            fixes: [
                {
                    id: 'set_env:SESSION_SECRET',
                    action: 'set_env',
                    who: 'kodus',
                    label: 'Set SESSION_SECRET in the recipe',
                    recipeDiff: '+ SESSION_SECRET: kodus-test-value',
                    learned: { scope: 'repo', helped: 2, lastAt: 'x' },
                },
                {
                    id: 'use_mock:SESSION_SECRET',
                    action: 'use_mock',
                    who: 'dev',
                    label: 'Use a test double',
                },
            ],
        },
    ],
};

const rpc = (structuredContent: unknown, isError = false) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { structuredContent, isError },
});

describe('kodus env', () => {
    beforeEach(() => vi.clearAllMocks());

    it('registers status, fix and recipe', () => {
        expect(envCommand.commands.map((c) => c.name()).sort()).toEqual([
            'fix',
            'recipe',
            'status',
        ]);
        const fix = envCommand.commands.find((c) => c.name() === 'fix')!;
        expect(fix.options.map((o) => o.long)).toEqual(
            expect.arrayContaining(['--fix', '--env', '--repo-id', '--json']),
        );
    });

    it('calls env_blockers on /mcp/env with the team key and the target only', async () => {
        const requester = vi.fn(async () => rpc(STATUS));
        const service = new EnvService(requester as any);
        await expect(
            service.status({ repositoryId: 'repo-1' }),
        ).resolves.toEqual(STATUS);
        const [endpoint, init] = (requester.mock.calls[0] as any[]) ?? [];
        expect(endpoint).toBe('/mcp/env');
        expect(init.headers).toMatchObject({
            'X-Team-Key': 'kodus_test',
            'Accept': 'application/json, text/event-stream',
        });
        expect(JSON.parse(init.body)).toEqual({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'env_blockers',
                arguments: { repositoryId: 'repo-1' },
            },
        });
    });

    it('reads the authoring guide from env_recipe_guide with no environment named', async () => {
        const requester = vi.fn(async () => rpc({ guide: 'the rules' }));
        const service = new EnvService(requester as any);
        await expect(service.recipeGuide()).resolves.toEqual({
            guide: 'the rules',
        });
        const [, init] = (requester.mock.calls[0] as any[]) ?? [];
        expect(JSON.parse(init.body).params).toEqual({
            name: 'env_recipe_guide',
            arguments: {},
        });
        const recipe = envCommand.commands.find((c) => c.name() === 'recipe')!;
        expect(recipe.commands.map((c) => c.name()).sort()).toEqual([
            'check',
            'guide',
            'submit',
        ]);
    });

    describe('a key that reaches several environments', () => {
        const refusal = rpc(
            {
                status: 400,
                code: 'environment_required',
                message: 'Name the environment: env-1 (acme/shop), env-2 (acme/billing)',
                environments: [
                    { environmentId: 'env-1', repositoryName: 'acme/shop' },
                    { environmentId: 'env-2', repositoryName: 'Acme/Billing' },
                ],
            },
            true,
        );
        const sentTo = (requester: ReturnType<typeof vi.fn>) =>
            requester.mock.calls.map(
                (c: any[]) => JSON.parse(c[1].body).params.arguments,
            );

        it('takes the environment of the git remote origin, case-insensitive, and asks again with it', async () => {
            const requester = vi
                .fn()
                .mockResolvedValueOnce(refusal)
                .mockResolvedValueOnce(rpc(STATUS));
            const service = new EnvService(
                requester as any,
                async () => 'git@github.com:acme/billing.git',
            );
            await expect(service.status({})).resolves.toEqual(STATUS);
            expect(sentTo(requester)).toEqual([{}, { environmentId: 'env-2' }]);
        });

        it('keeps the refusal, listing them, when the remote matches none or no remote is set', async () => {
            for (const remote of [
                'https://github.com/acme/other.git',
                null,
            ]) {
                const service = new EnvService(
                    vi.fn(async () => refusal) as any,
                    async () => remote,
                );
                await expect(service.status({})).rejects.toThrow(
                    /Name the environment: env-1 \(acme\/shop\), env-2/,
                );
            }
        });

        it('keeps the refusal when the remote matches several environments', async () => {
            const twice = rpc(
                {
                    status: 400,
                    code: 'environment_required',
                    message: 'Name the environment: a (acme/shop), b (ACME/shop)',
                    environments: [
                        { environmentId: 'a', repositoryName: 'acme/shop' },
                        { environmentId: 'b', repositoryName: 'ACME/shop' },
                    ],
                },
                true,
            );
            const service = new EnvService(
                vi.fn(async () => twice) as any,
                async () => 'https://github.com/acme/shop',
            );
            await expect(service.status({})).rejects.toThrow(/Name the environment/);
        });

        it('never reads the remote when --env or --repo-id names the environment', async () => {
            const remote = vi.fn(async () => 'https://github.com/acme/shop');
            const requester = vi.fn(async () => refusal);
            const service = new EnvService(requester as any, remote);
            await expect(service.status({ environmentId: 'env-9' })).rejects.toThrow();
            await expect(service.health({ repositoryId: 'r' })).rejects.toThrow();
            expect(remote).not.toHaveBeenCalled();
            expect(requester).toHaveBeenCalledTimes(2);
        });
    });

    it('turns a tool error into a message the dev can act on', async () => {
        const forbidden = new EnvService(
            vi.fn(async () =>
                rpc(
                    { status: 403, code: 'forbidden', message: 'No env:fix' },
                    true,
                ),
            ) as any,
        );
        await expect(
            forbidden.fix({ signature: 's', fixId: 'f' }),
        ).rejects.toThrow(/CLI keys/);
        const foreign = new EnvService(
            vi.fn(async () =>
                rpc(
                    {
                        status: 404,
                        code: 'not_found',
                        message: 'Environment not found',
                    },
                    true,
                ),
            ) as any,
        );
        await expect(
            foreign.status({ environmentId: 'other' }),
        ).rejects.toThrow(/only the repositories listed/);
    });

    it('picks the only blocker, or the one named', () => {
        const service = new EnvService(vi.fn() as any);
        expect(service.pickBlocker(STATUS).signature).toBe(
            'missing_env:SESSION_SECRET',
        );
        expect(() => service.pickBlocker(STATUS, 'nope')).toThrow(/No blocker/);
        expect(() => service.pickBlocker({ ...STATUS, blockers: [] })).toThrow(
            /no blocker/,
        );
    });

    it('prints the state, evidence and fixes with the recommended one first', () => {
        const out = formatEnvStatus(STATUS).join('\n');
        expect(out).toContain('Environment env-1 (acme/shop): blocked');
        expect(out).toContain('signature: missing_env:SESSION_SECRET');
        expect(out).toContain('Error: SESSION_SECRET is not set');
        expect(out).toMatch(
            /set_env:SESSION_SECRET: Set SESSION_SECRET in the recipe \[recommended, worked before \(repo\), opens a PR\]/,
        );
        expect(out).toMatch(
            /use_mock:SESSION_SECRET: Use a test double \[by hand\]/,
        );
        expect(out).toContain('kodus env fix <signature> --fix <fix-id>');
    });

    it('prints the failed step and every evidence line, not the first three', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `error TS2322: line ${i}`);
        const status = {
            ...STATUS,
            blockers: [
                {
                    ...STATUS.blockers[0],
                    evidence: { lines, step: '[build 3/5] RUN npm run build' },
                },
            ],
        };
        const out = formatEnvStatus(status).join('\n');
        expect(out).toContain('failed step: [build 3/5] RUN npm run build');
        expect(out).toContain('error TS2322: line 0');
        expect(out).toContain('error TS2322: line 39');
    });

    it('prints the check errors, the warnings and the commit it read', () => {
        const out = formatRecipeCheck(
            {
                ok: false,
                errors: ['.kodus/compose.yaml services.app.build.context: must be a directory of the repository'],
                warnings: ['.kodus/Dockerfile: the install runs after COPY . .'],
                readAt: 'abcdef1234567',
                environment: { environmentId: 'env-1', repositoryName: 'acme/shop' },
            },
            '.kodus/workspace.yaml',
            2,
        ).join('\n');
        expect(out).toContain('must be a directory of the repository');
        expect(out).toContain('warning: .kodus/Dockerfile');
        expect(out).toContain('read the repository at abcdef1');
    });

    it('prints what a fix did', () => {
        expect(
            formatEnvFix(
                {
                    action: 'set_env',
                    pullRequest: { number: 7, url: 'https://x/pr/7' },
                },
                'set_env:SESSION_SECRET',
            ),
        ).toBe(
            'Applied set_env:SESSION_SECRET: opened pull request #7 with the recipe change: https://x/pr/7',
        );
        expect(
            formatEnvFix(
                { action: 'retry_setup', setupRequested: true },
                'retry_setup',
            ),
        ).toContain('a new setup was requested');
    });
});
