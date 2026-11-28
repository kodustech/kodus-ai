// env_upload on the worker: the files of one call become evidence objects of the
// session's org, and the cell is asked to write each one from its key into the
// checkout of the session's claim. Nothing is written for a call the cell would refuse.
import { createHash } from 'crypto';

import { canonicalEvidenceKey } from '../../shared/evidence/file-evidence-store';
import type { Claim, EnvError, EnvironmentRuntime, UploadRequest } from '@libs/runtime/environment';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import type { AddressInfo } from 'net';

import { ENV_SESSION_SIGNATURE_HEADER, ENV_UPLOAD_MAX_BYTES, envSessionKeyFrom, signEnvSessionRequest } from '@libs/runtime/contracts/env-session';

import { startEnvSessionServer } from './env-session-server';
import { EnvSessionService } from './env-session.service';
import { InMemoryEnvSessionStore } from './testing';

const ORG = 'org-a';
const OWNER = { organizationId: ORG, teamId: 'team-a', keyId: 'key-a', repositoryIds: ['repo-a'] };
const SHA = 'a'.repeat(40);
const S1 = '11111111-1111-4111-8111-111111111111';
const STEP = '33333333-3333-4333-8333-333333333333';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const setup = (): EnvironmentSetupRecord =>
    ({
        environmentId: 'env-a',
        organizationId: ORG,
        repositoryId: 'repo-a',
        key: 'k',
        state: 'active',
        refSource: 'default_branch',
        sha: SHA,
        steps: [],
        blockers: [],
        imageId: 'img-1',
        expose: [],
        recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content: 'services: {}' },
        requestedAt: '2026-11-03T10:00:00.000Z',
        updatedAt: '2026-11-03T10:00:00.000Z',
    }) as any;

const claim: Claim = {
    claimId: 'claim-1',
    cellId: 'cell-1',
    cellOwner: 'kodus',
    leaseExpiresAt: '2026-11-03T14:00:00.000Z',
    hardExpiresAt: '2026-11-03T16:00:00.000Z',
    observer: { id: 'o', state: 'ready' },
    manifest: { services: [], expose: [], imageId: 'img-1', seedSha: SHA },
};

function harness(opts: { store?: boolean; uploadResult?: void | EnvError; noUpload?: boolean; acquire?: () => Promise<Claim> } = {}) {
    const objects = new Map<string, { body: Buffer; contentType: string }>();
    const uploads: Array<{ claimId: string; req: UploadRequest }> = [];
    const env: EnvironmentRuntime = {
        acquire: async () => (opts.acquire ? opts.acquire() : claim),
        exec: async () => ({}) as any,
        probe: async () => ({}) as any,
        reset: async () => undefined,
        release: async () => undefined,
        ...(opts.noUpload
            ? {}
            : {
                  upload: async (claimId: string, req: UploadRequest) => {
                      uploads.push({ claimId, req });
                      return opts.uploadResult;
                  },
              }),
    };
    const service = new EnvSessionService({
        store: new InMemoryEnvSessionStore(),
        setups: { get: async () => setup() },
        environment: () => env,
        isStopped: async () => false,
        now: () => new Date('2026-11-03T12:00:00.000Z'),
        openWaitMs: 50,
        ...(opts.store === false
            ? {}
            : {
                  evidence: {
                      put: async (key: string, body: string | Buffer, contentType: string) => {
                          objects.set(canonicalEvidenceKey(key), { body: Buffer.from(body), contentType });
                      },
                  },
              }),
    });
    const open = () =>
        service.open({
            ...OWNER,
            repositoryId: 'repo-a',
            environmentId: 'env-a',
            sessionId: S1,
            sha: SHA,
            repositoryFullName: 'acme/shop',
            sealedRepoToken: 'sealed:v1:x',
            correlationId: 'c1',
        });
    return { service, objects, uploads, open };
}

describe('env_upload on the worker', () => {
    it("keeps each file as an evidence object of the session's org and asks the cell to write it from that key, with its digest", async () => {
        const h = harness();
        await h.open();
        const view = await h.service.upload({
            ...OWNER,
            sessionId: S1,
            stepId: STEP,
            files: [
                { path: 'fixtures/users.json', contentBase64: b64('[{"id":1}]') },
                { path: 'bin/seed.sh', contentBase64: b64('#!/bin/sh\necho ok\n'), mode: 0o755 },
            ],
        });
        expect(view).toEqual({
            stepId: STEP,
            sessionId: S1,
            files: [
                { path: 'fixtures/users.json', bytes: 10, sha256: sha('[{"id":1}]') },
                { path: 'bin/seed.sh', bytes: 18, sha256: sha('#!/bin/sh\necho ok\n') },
            ],
        });
        expect(h.uploads).toHaveLength(1);
        const { claimId, req } = h.uploads[0];
        expect(claimId).toBe('claim-1');
        expect(req.stepId).toBe(STEP);
        expect(req.files.map((f) => [f.path, f.sha256, f.mode])).toEqual([
            ['fixtures/users.json', sha('[{"id":1}]'), undefined],
            ['bin/seed.sh', sha('#!/bin/sh\necho ok\n'), 0o755],
        ]);
        for (const f of req.files) {
            expect(f.contentRef.split('/')).toEqual([ORG, S1, 'pr', expect.any(String), 'input']);
            expect(sha(h.objects.get(f.contentRef)!.body)).toBe(f.sha256);
        }
        expect(new Set(req.files.map((f) => f.contentRef)).size).toBe(2);
    });

    it.each([
        ['a path out of the checkout', [{ path: '../etc/passwd', contentBase64: b64('x') }]],
        ['an absolute path', [{ path: '/etc/passwd', contentBase64: b64('x') }]],
        ['the same path twice', [{ path: 'a.txt', contentBase64: b64('x') }, { path: 'a.txt', contentBase64: b64('y') }]],
        ['content that is not base64', [{ path: 'a.txt', contentBase64: 'not base64!' }]],
        ['more bytes than one call takes', [{ path: 'a.bin', contentBase64: b64(Buffer.alloc(ENV_UPLOAD_MAX_BYTES + 1)) }]],
    ])('refuses %s before anything is stored or sent', async (_name, files) => {
        const h = harness();
        await h.open();
        await expect(h.service.upload({ ...OWNER, sessionId: S1, stepId: STEP, files })).rejects.toMatchObject({ status: 409, code: 'invalid_upload' });
        expect(h.objects.size).toBe(0);
        expect(h.uploads).toHaveLength(0);
    });

    it('refuses a session that is not ready, and another owner as a missing session', async () => {
        const h = harness({ acquire: () => new Promise<Claim>(() => undefined) });
        await h.open();
        const files = [{ path: 'a.txt', contentBase64: b64('x') }];
        await expect(h.service.upload({ ...OWNER, sessionId: S1, stepId: STEP, files })).rejects.toMatchObject({ status: 409, code: 'session_not_ready' });
        await expect(h.service.upload({ ...OWNER, keyId: 'key-b', sessionId: S1, stepId: STEP, files })).rejects.toMatchObject({ status: 404 });
        expect(h.uploads).toHaveLength(0);
    });

    it('answers upload_unavailable where the worker has no evidence store or the environment takes no files', async () => {
        for (const opts of [{ store: false }, { noUpload: true }]) {
            const h = harness(opts);
            await h.open();
            await expect(h.service.upload({ ...OWNER, sessionId: S1, stepId: STEP, files: [{ path: 'a.txt', contentBase64: b64('x') }] })).rejects.toMatchObject({
                status: 409,
                code: 'upload_unavailable',
            });
            expect(h.objects.size).toBe(0);
        }
    });

    it("passes on the cell's refusal with its reason, never as a success", async () => {
        const h = harness({ uploadResult: { code: 'upload_failed', stepId: STEP, reason: 'files[0].path: inside a .git directory' } as EnvError });
        await h.open();
        await expect(h.service.upload({ ...OWNER, sessionId: S1, stepId: STEP, files: [{ path: '.git/config', contentBase64: b64('x') }] })).rejects.toMatchObject({
            status: 409,
            code: 'upload_failed',
            message: expect.stringContaining('inside a .git directory'),
        });
    });
});

describe('env_upload over the listener', () => {
    it('takes a signed upload of up to 512 KiB, while every other env route keeps its 64 KiB body', async () => {
        const h = harness();
        await h.open();
        const key = envSessionKeyFrom(Buffer.alloc(32, 7));
        const server = await startEnvSessionServer({ service: h.service, key, port: 0, host: '127.0.0.1' });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const post = (path: string, body: unknown) => {
            const raw = JSON.stringify(body);
            return fetch(`${base}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', [ENV_SESSION_SIGNATURE_HEADER]: signEnvSessionRequest(key, { method: 'POST', path, body: raw, at: Date.now() }) },
                body: raw,
            });
        };
        try {
            const big = b64(Buffer.alloc(ENV_UPLOAD_MAX_BYTES, 1));
            const up = await post(`/env/sessions/${S1}/upload`, { ...OWNER, stepId: STEP, files: [{ path: 'data/blob.bin', contentBase64: big }] });
            expect(up.status).toBe(200);
            expect(((await up.json()) as any).files[0].bytes).toBe(ENV_UPLOAD_MAX_BYTES);
            // Past its cap the listener answers 413 and drops the connection mid-body: either way, never served.
            const exec = await post(`/env/sessions/${S1}/exec`, { ...OWNER, stepId: STEP, command: 'x'.repeat(70 * 1024), timeoutMs: 5_000 }).then(
                (r) => r.status,
                () => 'dropped',
            );
            expect([413, 'dropped']).toContain(exec);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});
