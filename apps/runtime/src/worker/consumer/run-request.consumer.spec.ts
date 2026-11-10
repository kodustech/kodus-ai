import { InMemoryPrAdmissionStore } from '../../shared/pr-admission-store';
import { Nack } from '@golevelup/nestjs-rabbitmq';

import { RuntimeEventName, runtimeEnvelope } from '@libs/runtime/run';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryCommandStore } from '../../shared/pg-command-store';
import { InMemoryEnvironmentSetupStore } from '../setup/environment-setup.service';
import { RunRequestConsumer } from './run-request.consumer';
import { RuntimeCommandName } from '@libs/runtime/api/domain/runtime-commands';

function setup() {
    const projection = new InMemoryRunProjectionStore();
    const engine = {
        start: jest.fn(async (r) => r.runId),
        stop: jest.fn(async () => true),
        approve: jest.fn(async () => undefined),
        startSetup: jest.fn(async (c: { key: string }) => `setup:${c.key}`),
    };
    const commands = new InMemoryCommandStore();
    const consumer = new RunRequestConsumer(engine as any, projection, commands, new InMemoryPrAdmissionStore());
    return { projection, engine, consumer, commands };
}

const asMessage = (payload: unknown, event: string = RuntimeEventName.RunRequested) =>
    runtimeEnvelope(event, { ...(payload as object), workflowType: 'RUNTIME_RUN' }, 'm1') as any;

describe('RunRequestConsumer', () => {
    it('writes the queued projection and starts the workflow with workflowID = runId', async () => {
        const { projection, engine, consumer } = setup();
        const req = shopRunRequest();
        await consumer.handle(asMessage(req));
        expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ runId: req.runId }));
        expect((await projection.get(req.runId))!.state).toBe('queued');
    });

    it('a malformed message is nacked without requeue (DLQ), never started', async () => {
        const { engine, consumer } = setup();
        const out = await consumer.handle(asMessage({ runId: 'nope' }));
        expect(out).toBeInstanceOf(Nack);
        expect((out as Nack).requeue).toBe(false);
        expect(engine.start).not.toHaveBeenCalled();
    });

    it('a new head supersedes the live Run of the old SHA', async () => {
        const { engine, consumer } = setup();
        const old = shopRunRequest();
        await consumer.handle(asMessage(old));
        const next = shopRunRequest({ pullRequest: { ...old.pullRequest, headSha: 'c'.repeat(40) } });
        await consumer.handle(asMessage(next));
        expect(engine.stop).toHaveBeenCalledWith(expect.objectContaining({ runId: old.runId }), 'superseded', expect.any(String));
        expect(engine.start).toHaveBeenCalledTimes(2);
    });

    it('keeps one live Run per org, repo, PR and SHA', async () => {
        const { engine, consumer } = setup();
        const first = shopRunRequest();
        await consumer.handle(asMessage(first));
        await consumer.handle(asMessage(shopRunRequest({ pullRequest: first.pullRequest })));
        expect(engine.start).toHaveBeenCalledTimes(1);
        expect(engine.stop).not.toHaveBeenCalled();
    });

    it('PR closed cancels every live Run of the PR', async () => {
        const { engine, consumer } = setup();
        const req = shopRunRequest();
        await consumer.handle(asMessage(req));
        await consumer.handle(
            asMessage({ organizationId: req.organizationId, repositoryId: req.repository.id, prNumber: req.pullRequest.number, reason: 'pr_closed' }, RuntimeEventName.RunCancelRequested),
            { messageId: 'close-command', redelivered: false },
        );
        expect(engine.stop).toHaveBeenCalledWith(expect.objectContaining({ runId: req.runId }), 'cancelled', 'pr_closed');
    });

    it('a fork approval reaches the waiting workflow only when it matches the Run record', async () => {
        const { engine, consumer, commands } = setup();
        const req = shopRunRequest({ pullRequest: { ...shopRunRequest().pullRequest, fork: true } });
        await consumer.handle(asMessage(req));
        const approval = {
            runId: req.runId,
            attempt: 1,
            organizationId: req.organizationId,
            repositoryId: req.repository.id,
            prNumber: req.pullRequest.number,
            headSha: req.pullRequest.headSha,
            approver: { userId: 'u-1' },
            approvedAt: new Date().toISOString(),
            key: `${req.runId}:${req.pullRequest.headSha}`,
        };
        await consumer.handle(asMessage({ ...approval, headSha: 'd'.repeat(40) }, RuntimeCommandName.ForkApproved));
        expect(engine.approve).not.toHaveBeenCalled();
        await consumer.handle(asMessage(approval, RuntimeCommandName.ForkApproved));
        // No tokens in this approval: the gate keeps the request's own.
        expect(engine.approve).toHaveBeenCalledWith(req.runId, req.pullRequest.headSha, approval.key, undefined);
        expect(await commands.hasForkApproval(req.runId, req.pullRequest.headSha)).toBe(true);
    });

    it('the stop button cancels the live Runs of the org and refuses new ones', async () => {
        const { engine, consumer } = setup();
        const req = shopRunRequest();
        await consumer.handle(asMessage(req));
        await consumer.handle(
            asMessage({ scope: 'org', organizationId: req.organizationId, requestedBy: { userId: 'admin' }, requestedAt: new Date().toISOString(), correlationId: 'c' }, RuntimeCommandName.StopRequested),
        );
        expect(engine.stop).toHaveBeenCalledWith(expect.objectContaining({ runId: req.runId }), 'cancelled', 'stopped by an admin');
        await consumer.handle(asMessage(shopRunRequest({ pullRequest: { ...req.pullRequest, number: 43 } })));
        expect(engine.start).toHaveBeenCalledTimes(1);
    });

    it('clearing a stop reopens the org, is idempotent and keeps a stop requested after the clear', async () => {
        const { engine, consumer, commands } = setup();
        const req = shopRunRequest();
        const stop = (requestedAt: string) =>
            asMessage({ scope: 'org', organizationId: req.organizationId, requestedBy: { userId: 'admin' }, requestedAt, correlationId: 'c' }, RuntimeCommandName.StopRequested);
        const clear = (clearedAt: string, scope = 'org') =>
            asMessage(
                { scope, ...(scope === 'org' ? { organizationId: req.organizationId } : {}), clearedBy: { userId: 'admin' }, clearedAt, correlationId: 'c2' },
                RuntimeCommandName.StopCleared,
            );
        await consumer.handle(stop('2026-10-30T10:00:00.000Z'));
        expect(await commands.isStopped(req.organizationId)).toBe(true);
        // A global clear does not touch org stops.
        await consumer.handle(clear('2026-10-30T11:00:00.000Z', 'global'));
        expect(await commands.isStopped(req.organizationId)).toBe(true);

        await consumer.handle(clear('2026-10-30T11:00:00.000Z'));
        await consumer.handle(clear('2026-10-30T11:00:00.000Z'));
        expect(await commands.isStopped(req.organizationId)).toBe(false);
        expect(commands.stops[0].clearedAt).toBe('2026-10-30T11:00:00.000Z');
        await consumer.handle(asMessage(req));
        expect(engine.start).toHaveBeenCalledTimes(1);

        // A stop requested after the clear (outbox retry order) stays active.
        await consumer.handle(stop('2026-10-30T12:00:00.000Z'));
        await consumer.handle(clear('2026-10-30T11:00:00.000Z'));
        expect(await commands.isStopped(req.organizationId)).toBe(true);
    });

    it('an org clear without organizationId is dead-lettered', async () => {
        const { consumer } = setup();
        const out = await consumer.handle(
            asMessage({ scope: 'org', clearedBy: { userId: 'a' }, clearedAt: new Date().toISOString(), correlationId: 'c' }, RuntimeCommandName.StopCleared),
        );
        expect(out).toBeInstanceOf(Nack);
    });

    it('an environment setup request is only enqueued on the setup workflow, never run in the handler', async () => {
        const { consumer, engine } = setup();
        const at = new Date().toISOString();
        const body = { environmentId: 'env-1', organizationId: 'o', teamId: 't', repositoryId: 'r', repositoryName: 'acme/shop', requestedBy: { userId: 'u' }, requestedAt: at, key: `env-1:${at}` };
        const out = await consumer.handle(asMessage(body, RuntimeCommandName.EnvironmentSetupRequested));
        expect(out).toBeUndefined();
        expect(engine.startSetup).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'env-1', key: body.key }));
        expect(engine.start).not.toHaveBeenCalled();
        // A worker without the setup service acknowledges instead of looping.
        engine.startSetup.mockResolvedValueOnce(false as any);
        expect(await consumer.handle(asMessage({ ...body, key: 'k2' }, RuntimeCommandName.EnvironmentSetupRequested))).toBeUndefined();
        // A malformed one (a blocker kind the product never sends) is dead-lettered.
        const bad = await consumer.handle(asMessage({ ...body, blocker: { kind: 'guess', message: 'x' } }, RuntimeCommandName.EnvironmentSetupRequested));
        expect(bad).toBeInstanceOf(Nack);
    });

    it("a Run boots with the expose list its environment's setup recorded from the default branch, not the request's", async () => {
        const { projection, engine, commands } = setup();
        const req = shopRunRequest();
        const store = new InMemoryEnvironmentSetupStore();
        const recorded = [{ service: 'web', port: 8080, kind: 'http' as const }];
        await store.save({
            environmentId: req.environment.environmentId,
            organizationId: req.organizationId,
            repositoryId: req.repository.id,
            key: 'k',
            state: 'active',
            steps: [],
            blockers: [],
            sha: req.pullRequest.baseSha,
            recipe: { path: '.kodus/workspace.yaml', sha: req.pullRequest.baseSha, state: 'found', digest: 'sha256:abc' },
            expose: recorded,
            requestedAt: req.requestedAt,
            updatedAt: req.requestedAt,
        });
        const consumer = new RunRequestConsumer(engine as any, projection, commands, new InMemoryPrAdmissionStore(), undefined, store);
        const prEditsRecipe = { ...req, diff: [...req.diff, { path: '.kodus/workspace.yaml', patch: '+  expose: [{ service: evil, port: 1, kind: http }]' }] };
        await consumer.handle(asMessage(prEditsRecipe));
        expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ expose: recorded }) }));
        expect((await projection.get(req.runId))?.recipe).toEqual({ sha: req.pullRequest.baseSha, state: 'found', digest: 'sha256:abc', prChangesRecipe: true });
        expect((await projection.get(req.runId))?.recipeChangedInPr).toEqual(['.kodus/workspace.yaml']);

        // Another org's setup record for the same environment id is never used.
        const other = shopRunRequest({ organizationId: 'org-z' });
        await consumer.handle(asMessage(other));
        expect(engine.start).toHaveBeenLastCalledWith(expect.objectContaining({ environment: other.environment }));
    });

    it("a Run boots with the authored files its setup recorded from the default branch, and never with files a request carries", async () => {
        const { projection, engine, commands } = setup();
        const req = shopRunRequest();
        const store = new InMemoryEnvironmentSetupStore();
        const files = [{ path: '.kodus/Dockerfile', content: 'FROM node:22-bookworm-slim\n' }];
        const base = {
            environmentId: req.environment.environmentId,
            organizationId: req.organizationId,
            repositoryId: req.repository.id,
            steps: [],
            blockers: [],
            sha: req.pullRequest.baseSha,
            requestedAt: req.requestedAt,
            updatedAt: req.requestedAt,
        };
        await store.save({
            ...base,
            key: 'k',
            state: 'active',
            recipe: { path: '.kodus/workspace.yaml', sha: req.pullRequest.baseSha, state: 'found', origin: 'authored', content: 'version: 1\n', digest: 'sha256:both', files },
        });
        const consumer = new RunRequestConsumer(engine as any, projection, commands, new InMemoryPrAdmissionStore(), undefined, store);
        const planted = [{ path: '.kodus/Dockerfile', content: 'FROM evil.example/backdoor:latest\n' }];
        const withPlanted = { ...req, environment: { ...req.environment, recipe: { path: '.kodus/workspace.yaml', content: 'version: 1\n', files: planted } } };
        await consumer.handle(asMessage(withPlanted));
        expect(engine.start).toHaveBeenLastCalledWith(
            expect.objectContaining({ environment: expect.objectContaining({ recipe: { path: '.kodus/workspace.yaml', content: 'version: 1\n', digest: 'sha256:both', files } }) }),
        );

        // No active setup: the request's recipe stands, without its files.
        const z = shopRunRequest({ organizationId: 'org-z' });
        const other = { ...z, environment: { ...z.environment, recipe: withPlanted.environment.recipe } };
        await consumer.handle(asMessage(other));
        const started = engine.start.mock.calls.at(-1)?.[0] as { environment: { recipe?: { files?: unknown } } };
        expect(started.environment.recipe).toEqual({ path: '.kodus/workspace.yaml', content: 'version: 1\n' });
    });

    it('records the recipe files the PR changes that the claims replace, including a file only the product saw (S-19)', async () => {
        const { projection, consumer } = setup();
        const req = shopRunRequest();
        const recipe = { path: '.kodus/workspace.yaml', content: 'version: 1\n' };
        const cut = {
            ...req,
            environment: { ...req.environment, recipe },
            prChangedRecipeFiles: ['.kodus/workspace.runtime.yaml', '.kodus/compose.yaml'],
            diff: [...req.diff, { path: '.kodus/workspace.yaml', patch: '+x' }, { path: '.kodus/Dockerfile.backend', patch: '+x' }],
        };
        await consumer.handle(asMessage(cut));
        // The compose and Dockerfile the workspace names boot from the PR's checkout: no recipe change.
        expect((await projection.get(req.runId))?.recipeChangedInPr).toEqual(['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml']);

        // Claims without a recipe boot the PR's own workspace file: nothing to report.
        const own = shopRunRequest({ pullRequest: { ...req.pullRequest, number: 44 }, diff: [...req.diff, { path: '.kodus/workspace.yaml', patch: '+x' }] });
        await consumer.handle(asMessage(own));
        expect(await projection.get(own.runId)).toMatchObject({ prNumber: 44 });
        expect((await projection.get(own.runId))?.recipeChangedInPr).toBeUndefined();

        const plain = shopRunRequest({ pullRequest: { ...req.pullRequest, number: 43 } });
        await consumer.handle(asMessage(plain));
        expect(await projection.get(plain.runId)).toMatchObject({ prNumber: 43 });
        expect((await projection.get(plain.runId))?.recipeChangedInPr).toBeUndefined();
    });

    it("the setup's authored files are recipe files too: the claims write them, never the PR's copy (S-19)", async () => {
        const { projection, engine, commands } = setup();
        const req = shopRunRequest();
        const store = new InMemoryEnvironmentSetupStore();
        await store.save({
            environmentId: req.environment.environmentId,
            organizationId: req.organizationId,
            repositoryId: req.repository.id,
            key: 'k',
            state: 'active',
            steps: [],
            blockers: [],
            sha: req.pullRequest.baseSha,
            recipe: { path: '.kodus/workspace.yaml', sha: req.pullRequest.baseSha, state: 'found', origin: 'authored', content: 'version: 1\n', digest: 'sha256:a', files: [{ path: '.kodus/Dockerfile', content: 'FROM node:22\n' }] },
            requestedAt: req.requestedAt,
            updatedAt: req.requestedAt,
        });
        const consumer = new RunRequestConsumer(engine as any, projection, commands, new InMemoryPrAdmissionStore(), undefined, store);
        await consumer.handle(asMessage({ ...req, diff: [...req.diff, { path: '.kodus/Dockerfile', patch: '+x' }, { path: '.kodus/compose.yaml', patch: '+x' }] }));
        expect((await projection.get(req.runId))?.recipeChangedInPr).toEqual(['.kodus/Dockerfile']);
        expect((await projection.get(req.runId))?.recipe).toMatchObject({ prChangesRecipe: true });
    });

    it('an unknown event is dead-lettered, not parsed as a Run', async () => {
        const { engine, consumer } = setup();
        const out = await consumer.handle(asMessage(shopRunRequest(), 'runtime.something.else'));
        expect(out).toBeInstanceOf(Nack);
        expect(engine.start).not.toHaveBeenCalled();
    });

    it('an approved egress host pushes the environment allowlist to the hub', async () => {
        const { projection, engine, commands } = setup();
        const push = jest.fn(async () => undefined);
        const consumer = new RunRequestConsumer(engine as any, projection, commands, new InMemoryPrAdmissionStore(), { push });
        const approve = (host: string) =>
            consumer.handle(
                asMessage(
                    { environmentId: 'shop', organizationId: 'org-a', host, approvedBy: { userId: 'admin' }, approvedAt: new Date().toISOString(), key: `shop:${host}` },
                    RuntimeCommandName.EgressApproved,
                ),
            );
        await approve('registry.npmjs.org');
        await approve('API.stripe.com');
        expect(push).toHaveBeenLastCalledWith('org-a', 'shop', ['api.stripe.com', 'registry.npmjs.org']);
    });
});
