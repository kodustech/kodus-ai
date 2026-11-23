import { readFileSync } from 'fs';
import { join } from 'path';

import { MIRROR_BUILD_ARGS } from '@libs/runtime/protocol/egress-catalog';

import { declareMirrorBuildArgs } from './authored-dockerfile-mirror';
import { checkAuthoredDockerfile } from './authored-files-policy';

// G1 (docs/runtime/egress-allowlist.md §16): a build reaches registries only through the cell's mirror, which a RUN
// sees only when its stage declares the build args. Without this, Kody's Dockerfile installed from the registry
// itself, which a build may no longer reach (build_needs_inspection).

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/mirror', name), 'utf8');
const argsOf = (stage: string) => stage.split('\n').filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4));

describe("Kody's Dockerfiles declare the mirror's build args", () => {
    it('a Next/Node repo: every stage that runs pnpm declares the npm family right after its FROM', () => {
        const out = declareMirrorBuildArgs('.kodus/Dockerfile', fixture('next.Dockerfile'));
        const [deps, runtime] = out.content.split(/\n(?=FROM )/);
        expect(argsOf(deps)).toEqual([...MIRROR_BUILD_ARGS.npm, ...MIRROR_BUILD_ARGS.ci]);
        expect(argsOf(runtime)).toEqual([...MIRROR_BUILD_ARGS.npm, ...MIRROR_BUILD_ARGS.ci]);
        expect(deps.split('\n')[1]).toBe('ARG npm_config_registry');
        expect(out.changes).toEqual([expect.stringContaining("installs only through the cell's read-only mirror")]);
        expect(checkAuthoredDockerfile('.kodus/Dockerfile', out.content)).toEqual([]);
    });

    it('a Python repo: pip in a continued RUN declares the pip and uv family', () => {
        const out = declareMirrorBuildArgs('.kodus/Dockerfile', fixture('python.Dockerfile'));
        expect(argsOf(out.content)).toEqual([...MIRROR_BUILD_ARGS.pypi, 'CI']);
        expect(checkAuthoredDockerfile('.kodus/Dockerfile', out.content)).toEqual([]);
    });

    it('declares nothing twice, and nothing in a stage that installs nothing', () => {
        const once = declareMirrorBuildArgs('.kodus/Dockerfile', fixture('next.Dockerfile')).content;
        expect(declareMirrorBuildArgs('.kodus/Dockerfile', once)).toEqual({ content: once, changes: [] });
        const plain = 'FROM nginx:1.27\nCOPY dist /usr/share/nginx/html\n';
        expect(declareMirrorBuildArgs('.kodus/Dockerfile', plain)).toEqual({ content: plain, changes: [] });
    });

    it('declares the yarn and pnpm names the cell passes (shared list)', () => {
        expect(MIRROR_BUILD_ARGS.npm).toEqual(expect.arrayContaining(['npm_config_registry', 'pnpm_config_registry', 'YARN_NPM_REGISTRY_SERVER', 'YARN_UNSAFE_HTTP_WHITELIST']));
        expect(MIRROR_BUILD_ARGS.pypi).toEqual(expect.arrayContaining(['PIP_INDEX_URL', 'PIP_TRUSTED_HOST', 'UV_DEFAULT_INDEX', 'UV_INSECURE_HOST']));
    });

    it('a stage that runs prisma also declares the artifact mirrors (Prisma engines, MongoDB test binaries)', () => {
        const out = declareMirrorBuildArgs('.kodus/Dockerfile', 'FROM node:22\nRUN npx prisma generate\n');
        expect(argsOf(out.content)).toEqual([...MIRROR_BUILD_ARGS.npm, 'PRISMA_ENGINES_MIRROR', 'MONGOMS_DOWNLOAD_MIRROR', 'MONGOMS_USE_HTTP', 'CI']);
        expect(MIRROR_BUILD_ARGS.artifacts).toEqual(['PRISMA_ENGINES_MIRROR', 'MONGOMS_DOWNLOAD_MIRROR', 'MONGOMS_USE_HTTP']);
    });

    it('every stage that runs something declares CI, because the cell builds with CI=true like GitHub Actions does', () => {
        expect(MIRROR_BUILD_ARGS.ci).toEqual(['CI']);
        const out = declareMirrorBuildArgs('.kodus/Dockerfile', 'FROM debian:bookworm\nRUN make\n\nFROM scratch\nCOPY --from=0 /a /a\n');
        expect(out.content).toBe('FROM debian:bookworm\nARG CI\nRUN make\n\nFROM scratch\nCOPY --from=0 /a /a\n');
        const own = 'FROM debian:bookworm\nARG CI=false\nRUN make\n';
        expect(declareMirrorBuildArgs('.kodus/Dockerfile', own)).toEqual({ content: own, changes: [] });
    });

    it('the Firebase emulators mirror is a build arg of the shared list', () => {
        expect(MIRROR_BUILD_ARGS.firebase).toEqual(['FIREBASE_EMULATORS_MIRROR']);
    });
});
