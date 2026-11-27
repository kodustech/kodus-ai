import { readBuildInputsDigest } from '../application/build-inputs.reader';

const target = { organizationId: 'o', teamId: 't', repositoryId: 'r', repositoryName: 'acme/shop', sha: 'a'.repeat(40) };
const RECIPE = 'version: 1\nservices: {compose: {files: [docker-compose.yml], public: app}}\n';

/** A Git port over a map of path to text; the listing is its keys unless told otherwise. */
const gitOf = (files: Record<string, string>, over: Record<string, unknown> = {}) => ({
    listFilesAtCommit: async () => Object.keys(files),
    readFileAtCommit: async ({ path }: { path: string }) => files[path] ?? null,
    ...over,
}) as any;

const BASE = { 'package.json': '{"name":"shop","version":"1.0.0"}', 'pnpm-lock.yaml': 'lock: 1', Dockerfile: 'FROM node:22', 'docker-compose.yml': 'services: {}', 'src/app.ts': 'export {}' };

describe('reading the build inputs digest of a commit (setup request)', () => {
    it('is the same for two commits that differ only in app source', async () => {
        const a = await readBuildInputsDigest(gitOf(BASE), target, RECIPE);
        const b = await readBuildInputsDigest(gitOf({ ...BASE, 'src/app.ts': 'export const x = 1', 'src/new.ts': '' }), target, RECIPE);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(b).toBe(a);
    });
    it('is the same for a release bump of package.json, and differs for a lockfile, a Dockerfile or a recipe-named compose file change', async () => {
        const a = await readBuildInputsDigest(gitOf(BASE), target, RECIPE);
        expect(await readBuildInputsDigest(gitOf({ ...BASE, 'package.json': '{"name":"shop","version":"1.0.1"}' }), target, RECIPE)).toBe(a);
        expect(await readBuildInputsDigest(gitOf({ ...BASE, 'pnpm-lock.yaml': 'lock: 2' }), target, RECIPE)).not.toBe(a);
        expect(await readBuildInputsDigest(gitOf({ ...BASE, Dockerfile: 'FROM node:24' }), target, RECIPE)).not.toBe(a);
        expect(await readBuildInputsDigest(gitOf({ ...BASE, 'docker-compose.yml': 'services: {a: {}}' }), target, RECIPE)).not.toBe(a);
    });
    it('ignores a compose file the recipe does not name', async () => {
        const a = await readBuildInputsDigest(gitOf(BASE), target, RECIPE);
        expect(await readBuildInputsDigest(gitOf({ ...BASE, 'docker-compose.other.yml': 'x' }), target, RECIPE)).toBe(a);
    });
    it('is undefined, so the template keys on the commit, when the platform cannot list or read, or the listing fails', async () => {
        expect(await readBuildInputsDigest(gitOf(BASE, { listFilesAtCommit: undefined }), target, RECIPE)).toBeUndefined();
        expect(await readBuildInputsDigest(gitOf(BASE, { listFilesAtCommit: async () => 'unsupported_platform' }), target, RECIPE)).toBeUndefined();
        expect(await readBuildInputsDigest(gitOf(BASE, { listFilesAtCommit: async () => { throw new Error('api down'); } }), target, RECIPE)).toBeUndefined();
        expect(await readBuildInputsDigest(gitOf(BASE, { readFileAtCommit: async () => 'unsupported_platform' }), target, RECIPE)).toBeUndefined();
    });
    it('is undefined when a listed build input cannot be read: not read is not unchanged', async () => {
        expect(await readBuildInputsDigest(gitOf(BASE, { readFileAtCommit: async ({ path }: { path: string }) => { if (path === 'pnpm-lock.yaml') throw new Error('too large'); return 'x'; } }), target, RECIPE)).toBeUndefined();
        expect(await readBuildInputsDigest(gitOf(BASE, { readFileAtCommit: async ({ path }: { path: string }) => (path === 'Dockerfile' ? null : 'x') }), target, RECIPE)).toBeUndefined();
    });
    it('is undefined for a repository with no build inputs, and for one with more than the bound', async () => {
        expect(await readBuildInputsDigest(gitOf({ 'src/app.ts': 'x' }), target, RECIPE)).toBeUndefined();
        const many = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`packages/p${i}/package.json`, '{}']));
        expect(await readBuildInputsDigest(gitOf(many), target, RECIPE)).toBeUndefined();
    });
    it('reads at the commit it was asked for', async () => {
        const seen: string[] = [];
        await readBuildInputsDigest(gitOf(BASE, { readFileAtCommit: async (i: { sha: string; path: string }) => (seen.push(i.sha), 'x') }), target, RECIPE);
        expect(new Set(seen)).toEqual(new Set(['a'.repeat(40)]));
    });
});
