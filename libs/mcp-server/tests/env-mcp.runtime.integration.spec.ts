import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
    EnvSessionView,
    EnvStepView,
} from '@libs/runtime/contracts/env-session';
import { ENV_EXEC_QUOTA } from '@libs/runtime/api/domain/env-tools';

import {
    eventually,
    OWNER,
    runtimeEnvFixture,
    SHA,
    TEAM_KEY,
} from './fixtures/runtime-env.fixture';

type Fixture = Awaited<ReturnType<typeof runtimeEnvFixture>>;
type ToolError = { status: number; code: string; message: string };

async function call<T>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return result.structuredContent as T;
}

async function refuse(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    status: number,
): Promise<ToolError> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status });
    expect(JSON.stringify(result)).not.toMatch(
        /fixture-download-token|stack|ECONN|sealed:v1/,
    );
    return result.structuredContent as ToolError;
}

async function ready(client: Client) {
    const opened = await call<EnvSessionView>(client, 'env_up', {
        environmentId: 'shop',
    });
    return eventually(
        () =>
            call<EnvSessionView>(client, 'env_up', {
                sessionId: opened.sessionId,
            }),
        (view) => view.state === 'ready',
    );
}

describe('MCP SDK → scoped tools → signed session listener → cell protocol (#2495)', () => {
    let h: Fixture | undefined;
    afterEach(async () => {
        await h?.close();
        h = undefined;
    });

    it('env_upload: the files reach the cell from the evidence store by signed read, digest-checked, and the frame never carries their bytes', async () => {
        h = await runtimeEnvFixture();
        const client = await h.connect();
        const session = await ready(client);
        const users = Buffer.from('[{"id":1,"email":"seed@example.invalid"}]');
        const script = Buffer.from('#!/bin/sh\necho seeded\n');
        const out = await call<{ stepId: string; files: Array<{ path: string; bytes: number; sha256: string }> }>(client, 'env_upload', {
            sessionId: session.sessionId,
            files: [
                { path: 'fixtures/users.json', contentBase64: users.toString('base64') },
                { path: 'bin/seed.sh', contentBase64: script.toString('base64'), mode: 0o755 },
            ],
        });
        expect(out.files.map((f) => [f.path, f.bytes])).toEqual([
            ['fixtures/users.json', users.length],
            ['bin/seed.sh', script.length],
        ]);
        const [claimId] = [...h.cell.uploaded.keys()];
        const written = h.cell.uploaded.get(claimId)!;
        expect(written.get('fixtures/users.json')!.body.equals(users)).toBe(true);
        expect(written.get('bin/seed.sh')).toMatchObject({ mode: 0o755 });
        expect(written.get('bin/seed.sh')!.body.equals(script)).toBe(true);
        const frame = h.frames.find((f) => f.type === 'upload')!;
        expect(JSON.stringify(frame.body)).not.toContain(users.toString('base64'));
        expect((frame.body as any).files.every((f: any) => f.contentRef.startsWith(`${OWNER.organizationId}/${session.sessionId}/pr/`) && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
        // A path the cell refuses never stores anything, and another key never reaches the session.
        await refuse(client, 'env_upload', { sessionId: session.sessionId, files: [{ path: '../escape', contentBase64: 'eA==' }] }, 409);
        expect(h.audit.rows.filter((r) => r.kind === 'env_upload').map((r) => r.outcome)).toEqual(['accepted', 'refused']);
    });

    it.each([9,124])('runs pinned named validation asynchronously and preserves internal exit %i',async code=>{
        h=await runtimeEnvFixture({isolatedValidation:true,validationExitCode:code});const client=await h.connect();const session=await ready(client);
        const allow=h.hold('exec');
        const step=await call<EnvStepView>(client,'env_validate',{sessionId:session.sessionId,name:'Unit tests',timeoutMs:1000});
        expect(step.state).toBe('running');allow();
        const done=await eventually(()=>call<EnvStepView>(client,'env_step',{stepId:step.stepId}),v=>v.state==='done');
        expect(done).toMatchObject({command:'pnpm test',exitCode:code});
        const frame=h.frames.find(f=>f.type==='exec')!;expect(frame.body).toMatchObject({command:'pnpm test'});expect(frame.body).not.toHaveProperty('executionScope');
        expect(h.audit.rows).toHaveLength(1);expect(h.audit.rows[0]).toMatchObject({kind:'env_exec',command:'pnpm test',outcome:'accepted'});
        expect(h.outbox).toEqual([]);
        await call(client,'env_down',{sessionId:session.sessionId});
    });
    it('reports lost validation transport without turning it into a finding',async()=>{
        h=await runtimeEnvFixture({isolatedValidation:true,loseValidation:true});const client=await h.connect();const session=await ready(client);
        const step=await call<EnvStepView>(client,'env_validate',{sessionId:session.sessionId,name:'Unit tests',timeoutMs:1000});
        const done=await eventually(()=>call<EnvStepView>(client,'env_step',{stepId:step.stepId}),v=>v.state==='done');
        expect(done).toMatchObject({error:'transport_lost'});expect(done).not.toHaveProperty('exitCode');expect(h.outbox).toEqual([]);
    });
    it('refuses recipe validation on an unsupported cell without an exec frame',async()=>{
        h=await runtimeEnvFixture();const client=await h.connect();const session=await ready(client);
        await refuse(client,'env_validate',{sessionId:session.sessionId,name:'unknown'},409);
        const step=await call<EnvStepView>(client,'env_validate',{sessionId:session.sessionId,name:'Unit tests'});
        const done=await eventually(()=>call<EnvStepView>(client,'env_step',{stepId:step.stepId}),v=>v.state==='done');
        expect(done.error).toBe('workload_exec_unavailable');expect(h.frames.filter(f=>f.type==='exec')).toEqual([]);expect(h.outbox).toEqual([]);
    });

    it('preserves the original six tools, lists named validation and status, polls acquire/exec and releases once', async () => {
        h = await runtimeEnvFixture();
        const client = await h.connect();
        expect(
            (await client.listTools()).tools.map((tool) => tool.name).sort(),
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
        const allowAcquire = h.hold('claim.acquire');
        const acquiring = await call<EnvSessionView>(client, 'env_up', {
            environmentId: 'shop',
        });
        expect(acquiring).toMatchObject({
            state: 'acquiring',
            environmentId: 'shop',
            sha: SHA,
        });
        expect(acquiring).not.toHaveProperty('claimId');
        allowAcquire();
        const session = await eventually(
            () =>
                call<EnvSessionView>(client, 'env_up', {
                    sessionId: acquiring.sessionId,
                }),
            (view) => view.state === 'ready',
        );
        expect(session.services).toEqual([{ name: 'web', health: 'ok' }]);

        const allowExec = h.hold('exec');
        const step = await call<EnvStepView>(client, 'env_exec', {
            sessionId: session.sessionId,
            command: 'printf fixture',
            timeoutMs: 1000,
            organizationId: 'org-b',
            repositoryIds: ['repo-b'],
        });
        expect(step).toMatchObject({
            sessionId: session.sessionId,
            state: 'running',
        });
        expect(step.stepId).toMatch(/^[0-9a-f-]{36}$/);
        expect(
            (
                await call<EnvStepView>(client, 'env_step', {
                    stepId: step.stepId,
                })
            ).state,
        ).toBe('running');
        expect(h.cell.received.filter((type) => type === 'exec')).toHaveLength(
            0,
        );
        allowExec();
        const done = await eventually(
            () =>
                call<EnvStepView>(client, 'env_step', { stepId: step.stepId }),
            (view) => view.state === 'done',
        );
        expect(done).toMatchObject({
            exitCode: 0,
            stdout: 'fixture command completed\n',
        });
        expect(h.cell.received.filter((type) => type === 'exec')).toHaveLength(
            1,
        );

        const blockers = await call<{
            blockers: Array<{
                signature: string;
                fixes: Array<{ id: string; action: string }>;
            }>;
        }>(client, 'env_blockers', { environmentId: 'blocked' });
        const blocker = blockers.blockers.find((group) =>
            group.fixes.some((fix) => fix.action === 'retry_setup'),
        )!;
        expect(blocker).toBeDefined();
        const fix = blocker.fixes.find(
            (item) => item.action === 'retry_setup',
        )!;
        expect(
            await call(client, 'env_fix', {
                environmentId: 'blocked',
                signature: blocker.signature,
                fixId: fix.id,
            }),
        ).toEqual({ action: 'retry_setup', setupRequested: true });
        expect(h.outbox).toHaveLength(1);
        expect(h.outbox[0]).toMatchObject({
            payload: {
                event_name: 'runtime.environment.setup_requested',
                payload: {
                    organizationId: OWNER.organizationId,
                    repositoryId: 'repo-blocked',
                    environmentId: 'blocked',
                    requestedBy: { userId: `team-key:${OWNER.keyId}` },
                    recipe: { sha: SHA },
                },
            },
        });
        expect(JSON.stringify(h.outbox)).not.toContain(
            'fixture-download-token',
        );
        expect(h.audit.rows.map((row) => row.kind)).toEqual([
            'env_exec',
            'env_fix',
        ]);
        expect(h.audit.rows[0]).toMatchObject({
            organizationId: OWNER.organizationId,
            keyId: OWNER.keyId,
            repositoryId: 'repo-a',
        });
        expect(
            await call(client, 'env_down', { sessionId: session.sessionId }),
        ).toMatchObject({ state: 'released' });
        expect(
            await call(client, 'env_down', { sessionId: session.sessionId }),
        ).toMatchObject({ state: 'released' });
        expect(
            h.cell.received.filter((type) => type === 'claim.release'),
        ).toHaveLength(1);
        expect(
            [...h.store.claims.values()].map((claim) => claim.state),
        ).toEqual(['released']);
    });

    it("env_recipe_check answers what Kodus would refuse, and env_recipe_submit keeps the developer's recipe and sets up from it", async () => {
        h = await runtimeEnvFixture({ noCommittedRecipe: true });
        const client = await h.connect();
        const recipe = 'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: web\n    health: /health\n  expose: [{service: web, port: 3000, kind: http}]\n';
        const files = [{ path: '.kodus/compose.yaml', content: 'services:\n  web:\n    build: .\n' }];

        const bad = await call<{ ok: boolean; errors: string[] }>(client, 'env_recipe_check', { environmentId: 'blocked', recipe: 'version: 2\n' });
        expect(bad.ok).toBe(false);
        expect(bad.errors.length).toBeGreaterThan(0);
        const outside = await call<{ ok: boolean; errors: string[] }>(client, 'env_recipe_check', {
            environmentId: 'blocked',
            recipe,
            files: [{ path: 'compose.yaml', content: 'x' }],
        });
        expect(outside.ok).toBe(false);
        expect(outside.errors.join(' ')).toMatch(/files/);
        expect(await call(client, 'env_recipe_check', { environmentId: 'blocked', recipe, files })).toMatchObject({
            ok: true,
            errors: [],
            summary: { public: 'web', health: '/health' },
        });
        // A check keeps nothing and boots nothing.
        expect(h.outbox).toHaveLength(0);

        const refused = await refuse(client, 'env_recipe_submit', { environmentId: 'blocked', recipe: 'version: 2\n' }, 400);
        expect(refused.message).toMatch(/refused the recipe/);
        expect(h.outbox).toHaveLength(0);

        const sent = await call<{ setupRequested: true; recipeDigest: string }>(client, 'env_recipe_submit', { environmentId: 'blocked', recipe, files });
        expect(sent).toMatchObject({ setupRequested: true, environmentId: 'blocked' });
        expect(sent.recipeDigest).toMatch(/^sha256:/);
        expect((sent as { setupKey?: string }).setupKey).toMatch(/^blocked:/);
        expect(h.outbox[0]).toMatchObject({ payload: { payload: { key: (sent as { setupKey?: string }).setupKey } } });
        expect(h.outbox).toHaveLength(1);
        expect(h.outbox[0]).toMatchObject({
            payload: {
                event_name: 'runtime.environment.setup_requested',
                payload: {
                    environmentId: 'blocked',
                    requestedBy: { userId: `team-key:${OWNER.keyId}` },
                    recipe: { sha: SHA, path: '.kodus/workspace.yaml', origin: 'submitted', content: recipe, files },
                },
            },
        });
        expect(h.audit.rows.map((row) => row.kind)).toEqual(['env_recipe_submit']);
    });

    it('a recipe committed on the default branch wins over the one a developer sent', async () => {
        h = await runtimeEnvFixture();
        const client = await h.connect();
        await call(client, 'env_recipe_submit', { environmentId: 'blocked', recipe: 'version: 1\nservices:\n  compose:\n    files: [x.yaml]\n    public: web\n' });
        const payload = (h.outbox[0] as { payload: { payload: { recipe: { origin?: string; content: string } } } }).payload.payload;
        expect(payload.recipe.origin).toBeUndefined();
        expect(payload.recipe.content).toContain('compose.yaml');
    });

    it('sending a recipe needs env:fix', async () => {
        h = await runtimeEnvFixture({ noCommittedRecipe: true });
        h.keys.set('kodus_test_fixture_exec_only', { ...OWNER, capabilities: ['env:exec'] });
        const execOnly = await h.connect('kodus_test_fixture_exec_only');
        const recipe = 'version: 1\nservices:\n  compose:\n    files: [x.yaml]\n    public: web\n';
        await call(execOnly, 'env_recipe_check', { environmentId: 'blocked', recipe });
        await refuse(execOnly, 'env_recipe_submit', { environmentId: 'blocked', recipe }, 403);
        expect(h.outbox).toHaveLength(0);
    });

    it('denies missing/revoked credentials and a valid service JWT even during SDK initialization', async () => {
        h = await runtimeEnvFixture();
        await expect(h.connect('')).rejects.toThrow(/401/);
        await expect(h.connect('kodus_test_fixture_revoked')).rejects.toThrow(
            /401/,
        );
        await expect(
            h.connect(await h.serviceToken(), 'authorization'),
        ).rejects.toThrow(/403/);
        expect(
            h.frames.filter((frame) => frame.type === 'claim.acquire'),
        ).toHaveLength(0);
        expect(h.tokenRequests).toHaveLength(0);
    });

    it.each([[], ['env:*'], ['env:exec:all'], ['runs:read']])(
        'refuses missing/look-alike/unrelated capabilities %j for every env tool over MCP',
        async (...capabilities: string[]) => {
            h = await runtimeEnvFixture();
            const key = 'kodus_test_fixture_wrong_cap';
            h.keys.set(key, { ...OWNER, capabilities });
            const client = await h.connect(key);
            for (const [name, args] of [
                ['env_up', { environmentId: 'shop' }],
                ['env_exec', { sessionId: 'unknown', command: 'true' }],
                ['env_validate', {sessionId:'unknown',name:'Unit tests'}],
                ['env_step', { stepId: 'unknown' }],
                ['env_down', { sessionId: 'unknown' }],
                ['env_blockers', { environmentId: 'shop' }],
                ['env_status', { environmentId: 'shop' }],
                [
                    'env_fix',
                    {
                        environmentId: 'blocked',
                        signature: 'kodus_step',
                        fixId: 'retry_setup',
                    },
                ],
            ] as const)
                await refuse(client, name, args, 403);
            expect(
                h.cell.received.filter(
                    (type) => type === 'claim.acquire' || type === 'exec',
                ),
            ).toHaveLength(0);
            expect(h.audit.rows).toHaveLength(0);
        },
    );

    it('keeps env:fix and env:exec separate while letting either read blockers', async () => {
        h = await runtimeEnvFixture();
        h.keys.set('kodus_test_fixture_fix_only', {
            ...OWNER,
            capabilities: ['env:fix'],
        });
        h.keys.set('kodus_test_fixture_exec_only', {
            ...OWNER,
            capabilities: ['env:exec'],
        });
        const fixOnly = await h.connect('kodus_test_fixture_fix_only');
        const execOnly = await h.connect('kodus_test_fixture_exec_only');
        await call(fixOnly, 'env_blockers', { environmentId: 'blocked' });
        await call(execOnly, 'env_blockers', { environmentId: 'blocked' });
        await call(fixOnly, 'env_status', { environmentId: 'blocked' });
        await call(execOnly, 'env_status', { environmentId: 'blocked' });
        await refuse(fixOnly, 'env_up', { environmentId: 'shop' }, 403);
        await refuse(
            execOnly,
            'env_fix',
            {
                environmentId: 'blocked',
                signature: 'kodus_step',
                fixId: 'retry_setup',
            },
            403,
        );
        expect(
            h.frames.filter((frame) => frame.type === 'claim.acquire'),
        ).toHaveLength(0);
        expect(h.outbox).toHaveLength(0);
    });

    it('checks revocation again on requests from an already initialized SDK client', async () => {
        h = await runtimeEnvFixture();
        const client = await h.connect();
        h.keys.delete(TEAM_KEY);
        await expect(client.listTools()).rejects.toThrow(/401/);
        await expect(client.callTool({name:'env_validate',arguments:{sessionId:'unknown',name:'Unit tests'}})).rejects.toThrow(/401/);
        await expect(
            client.callTool({
                name: 'env_up',
                arguments: { environmentId: 'shop' },
            }),
        ).rejects.toThrow(/401/);
        expect(
            h.frames.filter((frame) => frame.type === 'claim.acquire'),
        ).toHaveLength(0);
    });

    it('denies foreign environment org/team/repo before issuing a token or dispatching a claim', async () => {
        h = await runtimeEnvFixture();
        const client = await h.connect();
        for (const environmentId of [
            'foreign-org',
            'foreign-team',
            'foreign-repo',
        ]) {
            await refuse(client, 'env_up', { environmentId }, 404);
            await refuse(client, 'env_blockers', { environmentId }, 404);
            await refuse(client, 'env_status', { environmentId }, 404);
            await refuse(
                client,
                'env_fix',
                {
                    environmentId,
                    signature: 'kodus_step',
                    fixId: 'retry_setup',
                },
                404,
            );
        }
        expect(h.tokenRequests).toHaveLength(0);
        expect(
            h.frames.filter((frame) => frame.type === 'claim.acquire'),
        ).toHaveLength(0);
    });

    it('isolates live session and step ids by org, team, key and current repo list', async () => {
        h = await runtimeEnvFixture();
        const owner = await h.connect();
        const session = await ready(owner);
        const step = await call<EnvStepView>(owner, 'env_exec', {
            sessionId: session.sessionId,
            command: 'true',
        });
        await h.worker.settle();
        const workCommands = () =>
            h!.cell.received.filter(
                (type) => type !== 'ack' && type !== 'nack',
            );
        const originalDispatches = workCommands();
        for (const override of [
            { organizationId: 'org-b' },
            { teamId: 'team-b' },
            { keyId: 'key-b' },
            { repositoryIds: ['repo-b'] },
        ]) {
            const key = `kodus_test_fixture_foreign_${h.keys.size}`;
            h.keys.set(key, { ...OWNER, ...override });
            const other = await h.connect(key);
            await refuse(
                other,
                'env_up',
                { sessionId: session.sessionId },
                404,
            );
            await refuse(
                other,
                'env_exec',
                { sessionId: session.sessionId, command: 'true' },
                404,
            );
            await refuse(other, 'env_step', { stepId: step.stepId }, 404);
            await refuse(other,'env_validate',{sessionId:session.sessionId,name:'Unit tests'},404);
            await refuse(
                other,
                'env_down',
                { sessionId: session.sessionId },
                404,
            );
        }
        expect(workCommands()).toEqual(originalDispatches);
        expect(h.audit.rows).toHaveLength(1);
    });

    it.each(['key', 'org'] as const)(
        'enforces the %s quota before dispatch and redacts the audit command',
        async (scope) => {
            h = await runtimeEnvFixture();
            const client = await h.connect(TEAM_KEY, 'authorization');
            const session = await ready(client);
            const limit =
                scope === 'key'
                    ? ENV_EXEC_QUOTA.perKeyPerHour
                    : ENV_EXEC_QUOTA.perOrgPerHour;
            for (let i = 0; i < limit - 1; i++) {
                await h.audit.record({
                    auditId: `fixture-prior-${i}`,
                    kind: 'env_exec',
                    organizationId: OWNER.organizationId,
                    teamId: OWNER.teamId,
                    keyId: scope === 'key' ? OWNER.keyId : `prior-key-${i}`,
                    repositoryId: 'repo-a',
                    command: 'true',
                    at: new Date().toISOString(),
                    outcome: 'accepted',
                });
            }
            const command = `printf fixture # Authorization: token ghp_${'a'.repeat(36)}`;
            await call(client, 'env_exec', {
                sessionId: session.sessionId,
                command,
            });
            await h.worker.settle();
            const error = await refuse(
                client,
                'env_exec',
                { sessionId: session.sessionId, command },
                429,
            );
            expect(error.code).toBe('env_exec_quota');
            expect(
                h.cell.received.filter((type) => type === 'exec'),
            ).toHaveLength(1);
            const tail = h.audit.rows.slice(-2);
            expect(tail.map((row) => row.outcome)).toEqual([
                'accepted',
                'refused_quota',
            ]);
            expect(
                tail.every(
                    (row) =>
                        row.keyId === OWNER.keyId &&
                        row.repositoryId === 'repo-a',
                ),
            ).toBe(true);
            expect(JSON.stringify(tail)).not.toContain(`ghp_${'a'.repeat(36)}`);
            expect(tail[0].command).toContain('[redacted:');
        },
    );

    it('refuses the tool request when the product cannot authenticate to the signed session listener', async () => {
        h = await runtimeEnvFixture({ wrongSessionSignature: true });
        const client = await h.connect();
        const error = await refuse(
            client,
            'env_up',
            { environmentId: 'shop' },
            503,
        );
        expect(error.code).toBe('runtime_error');
        expect(h.sessionStore.sessions.size).toBe(0);
        expect(
            h.frames.filter((frame) => frame.type === 'claim.acquire'),
        ).toHaveLength(0);
    });
});
