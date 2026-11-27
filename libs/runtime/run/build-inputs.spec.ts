import { buildInputContentDigest, buildInputKindOf, buildInputPathsOf, buildInputsDigest, templateKeyOf } from './build-inputs';

describe('which repository paths decide the environment template (build inputs)', () => {
    // A path is a build input when a change to it changes what the build installs or which images it makes.
    it.each([
        ['pnpm-lock.yaml', 'lockfile'],
        ['apps/web/yarn.lock', 'lockfile'],
        ['package-lock.json', 'lockfile'],
        ['go.sum', 'lockfile'],
        ['package.json', 'manifest'],
        ['packages/ui/package.json', 'manifest'],
        ['pnpm-workspace.yaml', 'manifest'],
        ['.npmrc', 'manifest'],
        ['requirements.txt', 'manifest'],
        ['services/api/requirements-dev.txt', 'manifest'],
        ['Dockerfile', 'dockerfile'],
        ['docker/Dockerfile.api', 'dockerfile'],
        ['.kodus/app.Dockerfile', 'dockerfile'],
        ['.kodus/app.dockerfile', 'dockerfile'],
    ])('%s is a %s', (path, kind) => expect(buildInputKindOf(path)).toBe(kind));

    it.each([
        ['apps/api/src/main.ts'],
        ['README.md'],
        ['docs/Dockerfile-notes.md'],
        ['src/requirements.ts'],
        ['node_modules/left-pad/package.json'],
        ['vendor/lib/package.json'],
        ['../package.json'],
        ['/package.json'],
        ['docker-compose.yml'],
    ])('%s is not one', (path) => expect(buildInputKindOf(path)).toBeNull());

    it('counts a compose file as a build input only when the recipe names it, with or without ./', () => {
        expect(buildInputKindOf('docker-compose.yml', ['./docker-compose.yml'])).toBe('compose');
        expect(buildInputKindOf('.kodus/compose.yml', ['.kodus/compose.yml'])).toBe('compose');
        expect(buildInputKindOf('docker-compose.prod.yml', ['docker-compose.yml'])).toBeNull();
    });

    it('lists only the build inputs of a repository listing, sorted', () => {
        expect(buildInputPathsOf(['src/a.ts', 'package.json', 'Dockerfile', 'pnpm-lock.yaml', 'compose.yml'], ['compose.yml'])).toEqual(['Dockerfile', 'compose.yml', 'package.json', 'pnpm-lock.yaml']);
    });
});

describe('the digest of the build inputs', () => {
    const e = (path: string, text: string) => ({ path, digest: buildInputContentDigest(path, text) });

    it('is the same whatever order the files were read in', () => {
        const a = [e('package.json', '{"name":"x"}'), e('pnpm-lock.yaml', 'lock')];
        expect(buildInputsDigest(a)).toBe(buildInputsDigest([...a].reverse()));
    });
    it('changes when a lockfile, a Dockerfile or a manifest changes, and when a file is added or removed', () => {
        const base = [e('package.json', '{"name":"x"}'), e('pnpm-lock.yaml', 'lock'), e('Dockerfile', 'FROM node')];
        const d = buildInputsDigest(base);
        expect(buildInputsDigest([base[0], e('pnpm-lock.yaml', 'lock2'), base[2]])).not.toBe(d);
        expect(buildInputsDigest([base[0], base[1], e('Dockerfile', 'FROM node:22')])).not.toBe(d);
        expect(buildInputsDigest([e('package.json', '{"name":"x","dependencies":{"a":"1"}}'), base[1], base[2]])).not.toBe(d);
        expect(buildInputsDigest(base.slice(0, 2))).not.toBe(d);
        expect(buildInputsDigest([...base, e('apps/web/package.json', '{}')])).not.toBe(d);
    });
    it('does not change when only the version of a package.json moves, or its keys are reordered', () => {
        expect(buildInputContentDigest('package.json', '{"name":"x","version":"1.0.0","dependencies":{"a":"1","b":"2"}}')).toBe(
            buildInputContentDigest('package.json', '{"dependencies":{"b":"2","a":"1"},"version":"2.3.4","name":"x"}'),
        );
    });
    it('does change when a dependency version of a package.json moves', () => {
        expect(buildInputContentDigest('package.json', '{"dependencies":{"a":"1"}}')).not.toBe(buildInputContentDigest('package.json', '{"dependencies":{"a":"2"}}'));
    });
    it('reads a package.json that is not JSON by its bytes, so breaking it still changes the key', () => {
        expect(buildInputContentDigest('package.json', '{oops')).not.toBe(buildInputContentDigest('package.json', '{oops2'));
    });
    it('keeps the version of any file that is not a package.json: a lockfile is its bytes', () => {
        expect(buildInputContentDigest('pnpm-lock.yaml', 'version: 1')).not.toBe(buildInputContentDigest('pnpm-lock.yaml', 'version: 2'));
    });
    it('is undefined for no inputs: no evidence is not a key', () => {
        expect(buildInputsDigest([])).toBeUndefined();
    });
});

describe('the template key', () => {
    const R = `sha256:${'a'.repeat(64)}`;
    const I = 'b'.repeat(64);
    it('is bare hex that changes with the recipe digest and with the inputs digest', () => {
        const k = templateKeyOf(R, I)!;
        expect(k).toMatch(/^[0-9a-f]{64}$/);
        expect(templateKeyOf(R, I)).toBe(k);
        expect(templateKeyOf(`sha256:${'c'.repeat(64)}`, I)).not.toBe(k);
        expect(templateKeyOf(R, 'c'.repeat(64))).not.toBe(k);
    });
    it('takes the recipe digest with or without its sha256: prefix', () => {
        expect(templateKeyOf(R, I)).toBe(templateKeyOf('a'.repeat(64), I));
    });
    it.each([[undefined, I], [R, undefined], ['latest', I], [R, 'short']])('is undefined when a digest is missing or malformed (%s, %s)', (r, i) => expect(templateKeyOf(r, i)).toBeUndefined());
});
