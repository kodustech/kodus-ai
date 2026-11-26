import { ForbiddenException, NotFoundException } from '@nestjs/common';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

import { toMcpAuthInfo, type McpPrincipal } from '../auth/mcp-principal';
import { McpEnvTeamKeyGuard } from '../guards/mcp-env-team-key.guard';
import { EnvMcpServerService } from '../services/env-mcp-server.service';
import { runtimeReleaseGate } from '@libs/runtime/api/__tests__/fixtures';

import { ENV_TOOLS, envPrincipalOf, envToolError, EnvTools } from './env.tools';

const TEAM_KEY: McpPrincipal = {
    kind: 'team-key',
    organizationId: 'org-a',
    teamId: 'team-a',
    keyId: 'key-a',
    config: { capabilities: ['env:exec'], repositoryIds: ['repo-a'] },
};

function app(
    principal: McpPrincipal | undefined,
    service: Record<string, jest.Mock>,
    released = true,
) {
    const mcp = new EnvMcpServerService(
        new EnvTools(service as any, runtimeReleaseGate(released)),
    );
    const a = express();
    a.use(express.json());
    // The real route sits behind the API's limiter; the test app keeps one too.
    a.use(rateLimit({ windowMs: 60_000, limit: 1_000 }));
    a.post('/mcp/env', (req, res, next) => {
        if (principal) (req as any).auth = toMcpAuthInfo('kodus_x', principal);
        mcp.handleRequest(req.body, res).catch(next);
    });
    return a;
}

const call = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
});
const post = (a: express.Express, body: unknown) =>
    request(a)
        .post('/mcp/env')
        .set('accept', 'application/json, text/event-stream')
        .send(body);

describe('/mcp/env tools', () => {
    it('lists the original six env_* tools plus named validation, status, upload and the recipe tools', async () => {
        const res = await post(app(TEAM_KEY, {}), {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
        });
        expect(res.status).toBe(200);
        expect(
            res.body.result.tools.map((t: { name: string }) => t.name).sort(),
        ).toEqual([
            'env_blockers',
            'env_down',
            'env_exec',
            'env_fix',
            'env_recipe_check',
            'env_recipe_guide',
            'env_recipe_submit',
            'env_status',
            'env_step',
            'env_up',
            'env_upload',
            'env_validate',
        ]);
    });

    it('env_recipe_guide answers the authoring guide from the credential alone, with no environment named', async () => {
        const recipeGuide = jest.fn(async () => ({ guide: 'the rules' }));
        const res = await post(app(TEAM_KEY, { recipeGuide }), call('env_recipe_guide', {}));
        expect(res.body.result.structuredContent).toEqual({ guide: 'the rules' });
        expect(recipeGuide).toHaveBeenCalledTimes(1);
    });

    it('refuses every env_* call as not available to an org Kody Runtime is not released to, before the service', async () => {
        const up = jest.fn(async () => ({ sessionId: 's1' }));
        const res = await post(
            app(TEAM_KEY, { up }, false),
            call('env_up', { repositoryId: 'repo-a' }),
        );
        expect(res.body.result.isError).toBe(true);
        expect(res.body.result.structuredContent).toEqual(
            expect.objectContaining({ status: 404, code: 'not_available' }),
        );
        expect(up).not.toHaveBeenCalled();
    });

    it('takes org, team, key and repos from the credential, never from the arguments', async () => {
        const service = {
            exec: jest
                .fn()
                .mockResolvedValue({ stepId: 's1', state: 'running' }),
        };
        const res = await post(
            app(TEAM_KEY, service),
            call('env_exec', {
                sessionId: 'x',
                command: 'node -v',
                organizationId: 'org-b',
                repositoryIds: ['repo-b'],
            }),
        );
        expect(res.body.result.structuredContent).toEqual({
            stepId: 's1',
            state: 'running',
        });
        const [principal, args] = service.exec.mock.calls[0];
        expect(principal).toEqual({
            keyId: 'key-a',
            organizationId: 'org-a',
            teamId: 'team-a',
            capabilities: ['env:exec'],
            repositoryIds: ['repo-a'],
        });
        // The schema drops what it does not declare.
        expect(args).toEqual({ sessionId: 'x', command: 'node -v' });
    });

    it('lets an agent name the commit per repository on env_up and the repository a command runs in on env_exec', async () => {
        const sha = 'c'.repeat(40);
        const service = {
            up: jest.fn().mockResolvedValue({ sessionId: 's', state: 'acquiring' }),
            exec: jest.fn().mockResolvedValue({ stepId: 's1', state: 'running' }),
        };
        const a = app(TEAM_KEY, service);
        await post(a, call('env_up', { environmentId: 'env-a', commits: { billing: sha } }));
        await post(a, call('env_exec', { sessionId: 's', command: 'pnpm test', repository: 'billing' }));
        expect(service.up.mock.calls[0][1]).toEqual({ environmentId: 'env-a', commits: { billing: sha } });
        expect(service.exec.mock.calls[0][1]).toEqual({ sessionId: 's', command: 'pnpm test', repository: 'billing' });
    });

    it('answers a 404 tool error for a foreign id and a 403 for a missing capability', async () => {
        const service = {
            step: jest
                .fn()
                .mockRejectedValue(new NotFoundException('Step not found')),
            fix: jest
                .fn()
                .mockRejectedValue(
                    new ForbiddenException(
                        'This team key does not have the env:fix capability',
                    ),
                ),
        };
        const a = app(TEAM_KEY, service);
        const step = await post(
            a,
            call('env_step', { stepId: 'other-team-step' }),
        );
        expect(step.body.result).toMatchObject({
            isError: true,
            structuredContent: { status: 404, code: 'not_found' },
        });
        const fix = await post(
            a,
            call('env_fix', { signature: 's', fixId: 'f' }),
        );
        expect(fix.body.result).toMatchObject({
            isError: true,
            structuredContent: { status: 403, code: 'forbidden' },
        });
    });

    it('env_status reads the health for the credential only: the org comes from the key, a foreign id is a 404', async () => {
        const health = { environmentId: 'env-a', state: 'active', boots7d: 2, bootRate7d: 1, readyP50Ms: 30_000, blockers: [] };
        const service = {
            status: jest
                .fn()
                .mockImplementation(async (_p: unknown, a: { environmentId?: string }) => {
                    if (a.environmentId !== 'env-a') throw new NotFoundException('Environment not found');
                    return health;
                }),
        };
        const a = app(TEAM_KEY, service);
        const own = await post(a, call('env_status', { environmentId: 'env-a', organizationId: 'org-b' }));
        expect(own.body.result.structuredContent).toEqual(health);
        const [principal, args] = service.status.mock.calls[0];
        expect(principal).toMatchObject({ organizationId: 'org-a', teamId: 'team-a', keyId: 'key-a' });
        expect(args).toEqual({ environmentId: 'env-a' });
        const foreign = await post(a, call('env_status', { environmentId: 'env-b' }));
        expect(foreign.body.result).toMatchObject({ isError: true, structuredContent: { status: 404, code: 'not_found' } });
        const tool = ENV_TOOLS.find((t) => t.name === 'env_status')!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    });

    it('env_upload hands the session and the files to the service with the credential, never an org from the arguments', async () => {
        const service = { upload: jest.fn(async () => ({ stepId: 's', sessionId: 'x', files: [{ path: 'a.json', bytes: 2, sha256: 'c'.repeat(64) }] })) };
        const files = [{ path: 'a.json', contentBase64: 'e30=' }];
        const res = await post(app(TEAM_KEY, service), call('env_upload', { sessionId: 'x', files }));
        expect(res.body.result.structuredContent.files[0]).toMatchObject({ path: 'a.json', bytes: 2 });
        expect(service.upload).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a', keyId: 'key-a' }), { sessionId: 'x', files });
    });

    it('S-45: a service credential gets no env_status either', async () => {
        const service = { status: jest.fn() };
        const res = await post(app({ kind: 'service', organizationId: 'org-a' }, service), call('env_status', { environmentId: 'env-a' }));
        expect(res.body.result).toMatchObject({ isError: true, structuredContent: { status: 401, code: 'team_key_required' } });
        expect(service.status).not.toHaveBeenCalled();
    });

    it('S-45: a service credential (the Kody chat) gets no env tool to run', async () => {
        const service = { exec: jest.fn() };
        const res = await post(
            app({ kind: 'service', organizationId: 'org-a' }, service),
            call('env_exec', { sessionId: 'x', command: 'id' }),
        );
        expect(res.body.result).toMatchObject({
            isError: true,
            structuredContent: { status: 401, code: 'team_key_required' },
        });
        expect(service.exec).not.toHaveBeenCalled();
    });

    it('envPrincipalOf refuses a team key principal without a key id', () => {
        expect(
            envPrincipalOf({
                authInfo: {
                    extra: { principal: { ...TEAM_KEY, keyId: undefined } },
                },
            }),
        ).toBeNull();
    });

    it('envToolError never forwards an unexpected error message', () => {
        expect(
            envToolError(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
                .structuredContent,
        ).toEqual({
            status: 500,
            code: 'internal_error',
            message: 'The tool failed.',
        });
    });

    it('every tool says which capability it needs', () => {
        for (const t of ENV_TOOLS)
            expect(t.description).toMatch(/Needs env:(exec|fix)/);
    });
});

describe('McpEnvTeamKeyGuard', () => {
    const ctx = (auth?: unknown) =>
        ({ switchToHttp: () => ({ getRequest: () => ({ auth }) }) }) as any;
    const guard = new McpEnvTeamKeyGuard();

    it('lets a team key through and refuses no credential (401) and the service token (403), discovery included', () => {
        expect(guard.canActivate(ctx(toMcpAuthInfo('k', TEAM_KEY)))).toBe(true);
        expect(() => guard.canActivate(ctx())).toThrow('Team API key required');
        expect(() =>
            guard.canActivate(
                ctx(
                    toMcpAuthInfo('jwt', {
                        kind: 'service',
                        organizationId: 'org-a',
                    }),
                ),
            ),
        ).toThrow(ForbiddenException);
    });
});
