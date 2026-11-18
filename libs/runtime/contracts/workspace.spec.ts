import { readFileSync } from 'fs';
import { join } from 'path';

import { sealSecret } from '@libs/runtime/run/sealed-secret';
import { RuntimeRunRequestedSchema, type RuntimeRunRequested } from '@libs/runtime/run/run-messages';

import { RuntimeEnvironmentSetupRequestedSchema, type RuntimeEnvironmentSetupRequested } from './runtime-commands';
import { memberImageKey, refsDigest, repositoryAliasOf, workspaceShapeError } from './workspace';

// The Go cell reads the same vectors (bakecatalog/refs_test.go, recipe/needs_test.go).
const vectors = JSON.parse(readFileSync(join(__dirname, '../protocol/fixtures/workspace/vectors.json'), 'utf8')) as {
    refsDigest: Array<{ refs: Array<{ repositoryId: string; sha: string }>; recipeDigest: string; want: string }>;
    memberImageKey: Array<{ repositoryId: string; sha: string; contextDigest: string; want: string }>;
    aliases: Array<{ name: string; alias: string | null }>;
};

const A = '1'.repeat(40);
const B = '2'.repeat(40);

describe('refsDigest', () => {
    it.each(vectors.refsDigest.map((v) => [v.want, v] as const))('%s is the same for every order of the refs', (_want, v) => {
        expect(refsDigest(v.refs, v.recipeDigest)).toBe(v.want);
        expect(refsDigest([...v.refs].reverse(), v.recipeDigest)).toBe(v.want);
        expect(refsDigest([...v.refs.slice(1), ...v.refs.slice(0, 1)], v.recipeDigest)).toBe(v.want);
    });

    it('changes with any repository commit and with the recipe', () => {
        const base = refsDigest([{ repositoryId: '42', sha: A }, { repositoryId: '7', sha: A }], 'sha256:r');
        expect(refsDigest([{ repositoryId: '42', sha: A }, { repositoryId: '7', sha: B }], 'sha256:r')).not.toBe(base);
        expect(refsDigest([{ repositoryId: '42', sha: A }, { repositoryId: '7', sha: A }], 'sha256:other')).not.toBe(base);
        // The commits swap between repositories: another workspace, another key.
        expect(refsDigest([{ repositoryId: '42', sha: B }, { repositoryId: '7', sha: A }], 'sha256:r')).not.toBe(refsDigest([{ repositoryId: '42', sha: A }, { repositoryId: '7', sha: B }], 'sha256:r'));
        expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('refuses a ref it cannot frame unambiguously', () => {
        expect(() => refsDigest([{ repositoryId: '', sha: A }], 'r')).toThrow('bad repository id');
        expect(() => refsDigest([{ repositoryId: 'a\nb', sha: A }], 'r')).toThrow('bad repository id');
        expect(() => refsDigest([{ repositoryId: '1', sha: 'abc' }], 'r')).toThrow('bad sha');
        expect(() => refsDigest([{ repositoryId: '1', sha: A }, { repositoryId: '1', sha: B }], 'r')).toThrow('twice');
    });
});

describe('memberImageKey', () => {
    it.each(vectors.memberImageKey.map((v) => [v.want, v] as const))('%s', (_want, v) => {
        expect(memberImageKey(v.repositoryId, v.sha, v.contextDigest)).toBe(v.want);
    });

    it('is one key per repository, commit and build context', () => {
        const key = memberImageKey('42', A, 'sha256:ctx');
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(memberImageKey('43', A, 'sha256:ctx')).not.toBe(key);
        expect(memberImageKey('42', B, 'sha256:ctx')).not.toBe(key);
        expect(memberImageKey('42', A, 'sha256:other')).not.toBe(key);
        expect(() => memberImageKey('42', A, '')).toThrow('bad context digest');
    });
});

describe('repositoryAliasOf', () => {
    it.each(vectors.aliases.map((v) => [v.name, v.alias] as const))('%s -> %s', (name, alias) => {
        expect(repositoryAliasOf(name) ?? null).toBe(alias);
    });
});

describe('workspaceShapeError', () => {
    const entry = (repositoryId: string, alias: string, role: 'primary' | 'member' = 'member') => ({ repositoryId, alias, role });
    it('wants one primary and each repository and alias once', () => {
        expect(workspaceShapeError([entry('1', 'shop', 'primary'), entry('2', 'billing')])).toBeUndefined();
        expect(workspaceShapeError([entry('1', 'shop'), entry('2', 'billing')])).toContain('exactly one primary');
        expect(workspaceShapeError([entry('1', 'shop', 'primary'), entry('2', 'b', 'primary')])).toContain('exactly one primary');
        expect(workspaceShapeError([entry('1', 'shop', 'primary'), entry('1', 'billing')])).toContain('twice');
        expect(workspaceShapeError([entry('1', 'shop', 'primary'), entry('2', 'shop')])).toContain('alias shop twice');
    });
});

const KEY = Buffer.alloc(32, 7);

describe('RuntimeEnvironmentSetupRequested workspace', () => {
    const setupKey = 'env-1:2026-11-11T12:00:00.000Z';
    // Field order of the schema, as the product builds it: a parse writes the keys in the same order.
    const setup = (): RuntimeEnvironmentSetupRequested => ({
        environmentId: 'env-1',
        organizationId: 'org-a',
        teamId: 'team-a',
        repositoryId: '42',
        repositoryName: 'acme/shop',
        requestedBy: { userId: 'u-1' },
        requestedAt: '2026-11-11T12:00:00.000Z',
        key: setupKey,
        ref: { sha: A, branch: 'main' },
        repositoryFullName: 'acme/shop',
        repoToken: sealSecret('ghs_x', KEY, setupKey),
    });
    const member = (patch = {}) => ({
        repositoryId: '43',
        fullName: 'acme/billing',
        alias: 'billing',
        role: 'member' as const,
        sha: B,
        branch: 'main',
        sealedRepoToken: sealSecret('ghs_y', KEY, setupKey),
        ...patch,
    });
    const primary = () => ({ ...member(), repositoryId: '42', fullName: 'acme/shop', alias: 'shop', role: 'primary' as const, sha: A });

    it('a setup of one repository serializes byte for byte as before', () => {
        const old = setup();
        const text = JSON.stringify(old);
        expect(JSON.stringify(RuntimeEnvironmentSetupRequestedSchema.parse(JSON.parse(text)))).toBe(text);
        expect(RuntimeEnvironmentSetupRequestedSchema.parse(old)).not.toHaveProperty('workspace');
    });

    it('takes every repository with its own sealed token', () => {
        const r = RuntimeEnvironmentSetupRequestedSchema.safeParse({ ...setup(), workspace: [primary(), member()] });
        expect(r.success).toBe(true);
    });

    it('refuses a plain token, a bad alias, a second primary, and a primary that is not the setup\'s repository at its ref', () => {
        const refused = (workspace: unknown[]) => RuntimeEnvironmentSetupRequestedSchema.safeParse({ ...setup(), workspace }).success;
        expect(refused([primary(), member({ sealedRepoToken: 'ghs_plain' })])).toBe(false);
        expect(refused([primary(), member({ alias: '../billing' })])).toBe(false);
        expect(refused([primary(), member({ role: 'primary' })])).toBe(false);
        expect(refused([primary(), member({ alias: 'shop' })])).toBe(false);
        expect(refused([{ ...primary(), repositoryId: '99' }, member()])).toBe(false);
        expect(refused([{ ...primary(), sha: B }, member()])).toBe(false);
        expect(refused([])).toBe(false);
    });
});

describe('RuntimeRunRequested workspace', () => {
    const runId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const request = (): RuntimeRunRequested => ({
        runId,
        attempt: 1,
        correlationId: 'c',
        requestedAt: '2026-11-11T12:00:00.000Z',
        organizationId: 'org-a',
        teamId: 'team-a',
        repository: { id: '42', name: 'shop', fullName: 'acme/shop' },
        pullRequest: { number: 7, headSha: A, baseSha: B, baseBranch: 'main', fork: false },
        environment: { environmentId: 'env-1', imageId: 'img-1', expose: [{ service: 'api', port: 3000, kind: 'http' }] },
        diff: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
        repoToken: sealSecret('ghs_x', KEY, runId),
        prRepoToken: sealSecret('ghs_x2', KEY, runId),
        runToken: sealSecret('krt1.x.y', KEY, runId),
        trigger: 'pull_request',
    });
    const own = () => ({ repositoryId: '42', fullName: 'acme/shop', alias: 'shop', role: 'primary' as const, baseSha: B, headSha: A, source: 'pull_request' as const });
    const billing = (patch = {}) => ({
        repositoryId: '43',
        fullName: 'acme/billing',
        alias: 'billing',
        role: 'member' as const,
        baseSha: '3'.repeat(40),
        headSha: '3'.repeat(40),
        source: 'default_branch' as const,
        sealedRepoToken: sealSecret('ghs_y', KEY, runId),
        sealedPrRepoToken: sealSecret('ghs_y2', KEY, runId),
        ...patch,
    });

    it('a Run of one repository serializes byte for byte as before', () => {
        const text = JSON.stringify(request());
        expect(JSON.stringify(RuntimeRunRequestedSchema.parse(JSON.parse(text)))).toBe(text);
    });

    it('takes every repository, the PR\'s own among them, with paired and default-branch ones', () => {
        const paired = billing({ repositoryId: '44', fullName: 'acme/web', alias: 'web', source: 'paired', pairedPrNumber: 9, baseSha: '4'.repeat(40), headSha: '5'.repeat(40) });
        const r = RuntimeRunRequestedSchema.safeParse({ ...request(), workspace: [own(), billing(), paired] });
        expect(r.success).toBe(true);
    });

    it('refuses a workspace that disagrees with the request or with itself', () => {
        const accepted = (workspace: unknown[]) => RuntimeRunRequestedSchema.safeParse({ ...request(), workspace }).success;
        // The PR's own repository is missing, twice, or at other shas.
        expect(accepted([billing({ role: 'primary' })])).toBe(false);
        expect(accepted([own(), billing({ source: 'pull_request', baseSha: B, headSha: A })])).toBe(false);
        expect(accepted([{ ...own(), headSha: '9'.repeat(40) }, billing()])).toBe(false);
        // A default-branch repository runs one commit; only a paired one names a PR.
        expect(accepted([own(), billing({ headSha: '9'.repeat(40) })])).toBe(false);
        expect(accepted([own(), billing({ pairedPrNumber: 3 })])).toBe(false);
        expect(accepted([own(), billing({ source: 'paired' })])).toBe(false);
        // Tokens are sealed; aliases are directory names, once each.
        expect(accepted([own(), billing({ sealedRepoToken: 'ghs_plain' })])).toBe(false);
        expect(accepted([own(), billing({ alias: 'shop' })])).toBe(false);
        expect(accepted([own(), billing({ alias: 'Billing' })])).toBe(false);
        expect(accepted([own(), billing()])).toBe(true);
    });
});
