import { createPublicKey, generateKeyPairSync } from 'crypto';

import { ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { DEFAULT_PREVIEW_SETTINGS, environmentPreviewIdFor, previewIdFor, previewTokenBinding, verifyPreviewGrant, type PreviewOpen, type PreviewRef, type PreviewSettings, type PreviewView } from '@libs/runtime/contracts/preview';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { RuntimeRunAccessService } from '../application/run-access.service';
import { FORK_PREVIEW_OFF, PREVIEW_REFUSALS_TEXT, RuntimePreviewsService } from '../application/use-cases/previews.use-cases';
import type { ProductEnvironment } from '../domain/ports';
import { EnvSessionPortError } from '../domain/env-tools';
import { previewGrantKeyFrom, type RuntimePreviewPort } from '../domain/previews';
import { config, NOW, openSealed, ORG, OTHER_ORG, OTHER_REPO, REPO, realAuthorization, run, storeWith, user } from './fixtures';

const HOST = 'p-abcdefghijklmnopqrstuvwxyz-pr.preview.example';

/** The worker's preview routes as the API sees them: one record per preview id, scoped by org. */
class FakePreviews implements RuntimePreviewPort {
    readonly rows = new Map<string, PreviewView & { organizationId: string }>();
    readonly opened: PreviewOpen[] = [];
    readonly stopped: PreviewRef[] = [];
    off = false;

    async openPreview(req: PreviewOpen): Promise<PreviewView> {
        if (this.off) throw new EnvSessionPortError(409, 'preview_off', 'Previews are off on this deployment.');
        this.opened.push(req);
        const row = this.rows.get(req.previewId) ?? {
            organizationId: req.organizationId,
            previewId: req.previewId,
            runId: req.runId,
            environmentId: req.environmentId,
            repositoryId: req.repositoryId,
            side: req.side,
            sha: req.sha,
            host: HOST,
            state: 'starting' as const,
            openedBy: req.openedBy,
            withoutSecrets: true,
            idleMinutes: 15,
            ceilingMinutes: 120,
            createdAt: NOW.toISOString(),
            expiresAt: NOW.toISOString(),
        };
        this.rows.set(req.previewId, row);
        return row;
    }

    async previewStatus(ref: PreviewRef): Promise<PreviewView> {
        const row = this.rows.get(ref.previewId);
        if (!row || row.organizationId !== ref.organizationId) throw new EnvSessionPortError(404, 'not_found', 'not found');
        return row;
    }

    async stopPreview(ref: PreviewRef): Promise<PreviewView> {
        const row = await this.previewStatus(ref);
        this.stopped.push(ref);
        return { ...row, state: 'stopped' };
    }
}

const owner = user(Role.OWNER);
const repoAdmin = user(Role.REPO_ADMIN);
const contributor = user(Role.CONTRIBUTOR);
const billing = user(Role.BILLING_MANAGER);
const outsider = user(Role.OWNER, { org: OTHER_ORG, uuid: 'outsider' });

const environment = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: 'team-a',
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...patch,
});

async function setup(
    opts: {
        runs?: ReturnType<typeof run>[];
        assigned?: string[];
        fork?: boolean | undefined;
        members?: string[];
        settings?: Partial<PreviewSettings>;
        env?: Partial<ProductEnvironment>;
        storedFork?: boolean;
        setup?: Partial<EnvironmentSetupRecord> | null;
        domain?: string | null;
        environmentsDown?: boolean;
        setupsDown?: boolean;
    } = {},
) {
    const runs = opts.runs ?? [run()];
    const keys = generateKeyPairSync('ed25519');
    const previews = new FakePreviews();
    const authorization = realAuthorization(opts.assigned ?? [REPO]);
    const members = opts.members ? { repositoryIdsOfEnvironment: async () => opts.members! } : undefined;
    const access = new RuntimeRunAccessService(await storeWith(...runs), authorization, members as any);
    const git = {
        getPullRequestHead: async () => ({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fork: opts.fork as boolean }),
    };
    const tokens = { issue: async () => 'ghs_example_not_a_real_token' };
    const pem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const settings = { getPreviewSettings: async () => ({ ...DEFAULT_PREVIEW_SETTINGS, ...opts.settings }), setPreviewSettings: async () => undefined };
    const env = environment(opts.env);
    const environments = {
        get: async (org: string, id: string) => {
            if (opts.environmentsDown) throw new Error('connection terminated unexpectedly');
            return org === env.organizationId && id === env.environmentId ? env : null;
        },
    };
    const baked = opts.setup === null ? null : ({ organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, state: 'active', sha: 'c'.repeat(40), ...opts.setup } as EnvironmentSetupRecord);
    const setups = {
        get: async (org: string) => {
            if (opts.setupsDown) throw new Error('connection terminated unexpectedly');
            return org === ORG ? baked : null;
        },
    };
    const targets = { get: async () => (opts.storedFork === undefined ? null : ({ fork: opts.storedFork } as any)) };
    const domain = opts.domain === null ? {} : { previewDomain: opts.domain ?? 'preview.example' };
    const service = new RuntimePreviewsService(access, git, tokens, config({ previewGrantPrivateKey: pem, ...domain }), previews, () => NOW, authorization, settings, environments, setups, targets);
    return { service, previews, runs, publicKey: keys.publicKey };
}

describe('Runtime previews (API)', () => {
    it('opens the PR side of a finished Run with a token sealed to the preview, at the Run head', async () => {
        const { service, previews, runs } = await setup({ fork: false });
        const view = await service.open(repoAdmin, runs[0].runId, 'pr');
        const previewId = previewIdFor(ORG, runs[0].runId, 'pr');
        expect(view.previewId).toBe(previewId);
        expect(previews.opened[0]).toMatchObject({ organizationId: ORG, runId: runs[0].runId, side: 'pr', sha: runs[0].headSha, openedBy: repoAdmin.uuid });
        expect(openSealed(previews.opened[0].sealedRepoToken, previewTokenBinding(previewId))).toBe('ghs_example_not_a_real_token');
    });

    it('opens the base side at the Run base sha, fork or not', async () => {
        const { service, previews, runs } = await setup({ fork: true });
        await service.open(owner, runs[0].runId, 'base');
        expect(previews.opened[0]).toMatchObject({ side: 'base', sha: runs[0].baseSha });
    });

    it('refuses a user without access to the repository (repo-scoped roles)', async () => {
        const theirs = run({ repositoryId: OTHER_REPO });
        const { service, previews } = await setup({ runs: [theirs], fork: false, assigned: [REPO] });
        await expect(service.open(repoAdmin, theirs.runId, 'pr')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.open(contributor, theirs.runId, 'pr')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.open(billing, theirs.runId, 'pr')).rejects.toBeInstanceOf(ForbiddenException);
        // The owner reaches every repository of the org.
        await expect(service.open(owner, theirs.runId, 'pr')).resolves.toMatchObject({ runId: theirs.runId });
        expect(previews.opened).toHaveLength(1);
    });

    it('refuses a user without access to one repository of a multi-repository environment', async () => {
        const { service, runs } = await setup({ fork: false, members: [REPO, OTHER_REPO], assigned: [REPO] });
        await expect(service.open(repoAdmin, runs[0].runId, 'pr')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses another org: its Run by id, and its preview by id', async () => {
        const { service, runs } = await setup({ fork: false });
        await expect(service.open(outsider, runs[0].runId, 'pr')).rejects.toBeInstanceOf(NotFoundException);
        const view = await service.open(owner, runs[0].runId, 'pr');
        await expect(service.get(outsider, view.previewId)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.grant(outsider, view.previewId)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.stop(outsider, view.previewId)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.get(owner, 'prv_notavalidid')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses the PR side of a fork, and of a PR the Git API cannot tell', async () => {
        for (const fork of [true, undefined]) {
            const { service, runs, previews } = await setup({ fork });
            await expect(service.open(owner, runs[0].runId, 'pr')).rejects.toThrow(new ConflictException(FORK_PREVIEW_OFF));
            expect(previews.opened).toHaveLength(0);
        }
    });

    it('refuses a Run that is not finished, and a halted one', async () => {
        for (const state of ['booting', 'testing', 'queued', 'halted'] as const) {
            const r = run({ state });
            const { service } = await setup({ runs: [r], fork: false });
            await expect(service.open(owner, r.runId, 'pr')).rejects.toBeInstanceOf(ConflictException);
        }
    });

    it('refuses a Run of a multi-repository environment (the worker boots one repository)', async () => {
        const { service, runs } = await setup({ fork: false, members: [REPO, OTHER_REPO], assigned: [REPO, OTHER_REPO] });
        await expect(service.open(owner, runs[0].runId, 'pr')).rejects.toBeInstanceOf(ConflictException);
    });

    it('passes the worker preview_off refusal on as is', async () => {
        const { service, previews, runs } = await setup({ fork: false });
        previews.off = true;
        await expect(service.open(owner, runs[0].runId, 'pr')).rejects.toMatchObject({ status: 409, response: { code: 'preview_off' } });
    });

    it('mints a grant that verifies for the preview host only and expires in 60 seconds', async () => {
        const { service, runs, publicKey } = await setup({ fork: false });
        const view = await service.open(contributor, runs[0].runId, 'pr');
        const { redirectUrl } = await service.grant(contributor, view.previewId, '/orders?id=7');
        const url = new URL(redirectUrl);
        expect(url.origin).toBe(`https://${HOST}`);
        expect(url.pathname).toBe('/__kodus/session');
        expect(url.searchParams.get('to')).toBe('/orders?id=7');
        const token = url.searchParams.get('grant')!;
        const ok = verifyPreviewGrant(publicKey, token, { host: HOST, now: NOW.getTime() + 59_000 });
        expect(ok).toMatchObject({ ok: true, claims: { sub: contributor.uuid, org: ORG, pid: view.previewId, side: 'pr' } });
        expect(verifyPreviewGrant(publicKey, token, { host: HOST, now: NOW.getTime() + 60_000 })).toEqual({ ok: false, reason: 'expired' });
        expect(verifyPreviewGrant(publicKey, token, { host: 'p-zzzzzzzzzzzzzzzzzzzzzzzzzz-pr.preview.example', now: NOW.getTime() })).toEqual({ ok: false, reason: 'wrong_audience' });
    });

    it('refuses a grant to another host path, for a stopped preview, and without a grant key', async () => {
        const { service, previews, runs } = await setup({ fork: false });
        const view = await service.open(owner, runs[0].runId, 'pr');
        await expect(service.grant(owner, view.previewId, '//evil.example/')).rejects.toBeInstanceOf(HttpException);
        await expect(service.grant(owner, view.previewId, '/__kodus/link/x')).rejects.toBeInstanceOf(HttpException);
        previews.rows.set(view.previewId, { ...previews.rows.get(view.previewId)!, state: 'stopped' });
        await expect(service.grant(owner, view.previewId)).rejects.toBeInstanceOf(ConflictException);

        const keyless = await setup({ fork: false });
        const v2 = await keyless.service.open(owner, keyless.runs[0].runId, 'pr');
        (keyless.service as any).config = config();
        await expect(keyless.service.grant(owner, v2.previewId)).rejects.toMatchObject({ status: 503, response: { code: 'preview_off' } });
    });

    it('lets the opener and an owner stop a preview, and refuses anyone else', async () => {
        const { service, previews, runs } = await setup({ fork: false, assigned: [REPO] });
        const view = await service.open(contributor, runs[0].runId, 'pr');
        await expect(service.stop(repoAdmin, view.previewId)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.stop(contributor, view.previewId)).resolves.toMatchObject({ state: 'stopped' });
        await expect(service.stop(owner, view.previewId)).resolves.toMatchObject({ state: 'stopped' });
        expect(previews.stopped.map((s) => s.actor)).toEqual([contributor.uuid, owner.uuid]);
    });
});

describe('Runtime previews (API), phase 2', () => {
    it("carries the org's settings and the environment's secrets choice in each open, and the PR it is of", async () => {
        const { service, previews, runs } = await setup({ fork: false, settings: { idleMinutes: 5, ceilingMinutes: 60, monthlyMachineMinutes: 600 }, env: { previewSecrets: 'run' } });
        await service.open(repoAdmin, runs[0].runId, 'pr');
        expect(previews.opened[0]).toMatchObject({ prNumber: 7, policy: { idleMinutes: 5, ceilingMinutes: 60, secrets: true, forkPullRequest: false, monthlyMachineMinutes: 600 } });
    });

    it('refuses to open while an owner has previews off, and the card says why', async () => {
        const { service, previews, runs } = await setup({ fork: false, settings: { enabled: false } });
        await expect(service.open(owner, runs[0].runId, 'pr')).rejects.toMatchObject({ status: 409, response: { code: 'preview_disabled' } });
        expect(previews.opened).toHaveLength(0);
        expect((await service.forRun(owner, runs[0].runId)).offer).toMatchObject({ available: false, code: 'preview_disabled' });
    });

    it('offers nothing on a deployment without a preview domain', async () => {
        const { service, runs } = await setup({ fork: false, domain: null });
        expect((await service.forRun(owner, runs[0].runId)).offer).toMatchObject({ available: false, code: 'preview_off' });
    });

    it("opens a fork's PR side only when an owner allowed fork previews and the Run tested it, without secrets", async () => {
        const off = await setup({ fork: true, env: { previewSecrets: 'run' } });
        await expect(off.service.open(owner, off.runs[0].runId, 'pr')).rejects.toThrow(new ConflictException(FORK_PREVIEW_OFF));

        const untested = run({ state: 'cancelled' });
        const notRun = await setup({ runs: [untested], fork: true, settings: { forks: 'members' } });
        await expect(notRun.service.open(owner, untested.runId, 'pr')).rejects.toThrow(new ConflictException(PREVIEW_REFUSALS_TEXT.forkNotTested));

        const on = await setup({ fork: true, settings: { forks: 'members' }, env: { previewSecrets: 'run' } });
        await on.service.open(owner, on.runs[0].runId, 'pr');
        expect(on.previews.opened[0].policy).toMatchObject({ forkPullRequest: true, secrets: false });
    });

    it("the Run's card shows each opened side, says a fork's PR side is off, and refuses a halted or multi-repository Run in words", async () => {
        const { service, runs } = await setup({ fork: false, storedFork: true });
        await service.open(owner, runs[0].runId, 'base');
        const card = await service.forRun(contributor, runs[0].runId);
        expect(card.offer).toMatchObject({ available: true, prReason: FORK_PREVIEW_OFF, idleMinutes: 15, ceilingMinutes: 120, secrets: 'none' });
        expect(Object.keys(card.sides)).toEqual(['base']);

        const halted = run({ state: 'halted' });
        const h = await setup({ runs: [halted] });
        expect((await h.service.forRun(owner, halted.runId)).offer).toMatchObject({ available: false, reason: PREVIEW_REFUSALS_TEXT.halted });
        const multi = await setup({ members: [REPO, OTHER_REPO], assigned: [REPO, OTHER_REPO] });
        expect((await multi.service.forRun(owner, multi.runs[0].runId)).offer).toMatchObject({ available: false, reason: PREVIEW_REFUSALS_TEXT.multiRepository });
    });

    it("opens an environment's own preview at its last setup's commit, within the caller's repo scope", async () => {
        const { service, previews } = await setup({});
        const view = await service.openEnvironment(contributor, 'env-1');
        expect(view.previewId).toBe(environmentPreviewIdFor(ORG, 'env-1', 'c'.repeat(40)));
        expect(previews.opened[0]).toMatchObject({ side: 'base', sha: 'c'.repeat(40), environmentId: 'env-1' });
        expect(previews.opened[0]).not.toHaveProperty('runId');
        expect((await service.forEnvironment(contributor, 'env-1')).preview?.previewId).toBe(view.previewId);
        // The opener reads and grants it like a Run's preview.
        await expect(service.grant(contributor, view.previewId)).resolves.toHaveProperty('redirectUrl');

        await expect(service.openEnvironment(outsider, 'env-1')).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.get(outsider, view.previewId)).rejects.toBeInstanceOf(NotFoundException);
        const scoped = await setup({ assigned: [OTHER_REPO] });
        await expect(scoped.service.openEnvironment(repoAdmin, 'env-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an environment preview before its setup finished, and says so', async () => {
        const { service, previews } = await setup({ setup: { state: 'failed' } as Partial<EnvironmentSetupRecord> });
        expect((await service.forEnvironment(owner, 'env-1')).offer).toMatchObject({ available: false, reason: PREVIEW_REFUSALS_TEXT.noSetup });
        await expect(service.openEnvironment(owner, 'env-1')).rejects.toBeInstanceOf(ConflictException);
        expect(previews.opened).toHaveLength(0);
    });

    it('answers unavailable, not "not found", when the environment store cannot be read', async () => {
        const { service, previews, runs } = await setup({ fork: false, environmentsDown: true });
        for (const call of [() => service.forEnvironment(owner, 'env-1'), () => service.openEnvironment(owner, 'env-1'), () => service.forRun(owner, runs[0].runId)]) {
            const error = await call().catch((e) => e);
            expect(error).toBeInstanceOf(ServiceUnavailableException);
            expect(String(error.message)).not.toContain('connection terminated');
        }
        expect(previews.opened).toHaveLength(0);
    });

    it('answers unavailable, not "no setup yet", when the setup store cannot be read', async () => {
        const { service, previews } = await setup({ setupsDown: true });
        for (const call of [() => service.forEnvironment(owner, 'env-1'), () => service.openEnvironment(owner, 'env-1')]) {
            const error = await call().catch((e) => e);
            expect(error).toBeInstanceOf(ServiceUnavailableException);
            expect(String(error.message)).not.toContain('connection terminated');
        }
        expect(previews.opened).toHaveLength(0);
    });
});

describe('preview grant key', () => {
    it('reads a PKCS8 PEM, with escaped newlines, or base64 DER, and refuses a key that is not Ed25519', () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
        const der = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
        for (const raw of [pem, pem.replace(/\n/g, '\\n'), der]) {
            expect(createPublicKey(previewGrantKeyFrom(raw)).export({ format: 'pem', type: 'spki' })).toEqual(publicKey.export({ format: 'pem', type: 'spki' }));
        }
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
        expect(() => previewGrantKeyFrom(rsa)).toThrow(/Ed25519/);
    });
});
