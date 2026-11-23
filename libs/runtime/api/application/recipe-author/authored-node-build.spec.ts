import {
    authoredInstallLayers,
    checkAuthoredSubmission,
    checkNodeBuild,
    copiesWorkspaceSource,
    installLayersOf,
    nodeBuildFacts,
} from './authored-files-policy';

/** A reader over a map of repository files. */
const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? null;
const factsOf = async (files: Record<string, string>, context = '.') => (await nodeBuildFacts(reader(files), context))!;
const lint = async (files: Record<string, string>, dockerfile: string) => checkNodeBuild('.kodus/Dockerfile', dockerfile, await factsOf(files));

/** cal.com's shape: Yarn Berry workspaces with a committed release, Turborepo. */
const YARN_MONOREPO = {
    'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*', 'packages/*'], packageManager: 'yarn@4.12.0', devDependencies: { turbo: '2.7.1' } }),
    'yarn.lock': '# yarn lockfile v8\n',
    '.yarnrc.yml': 'nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.12.0.cjs\n',
    'turbo.json': '{}',
};
/** next.js's shape: pnpm workspace, packageManager pnpm 10, a pnpm 9.0 lockfile. */
const PNPM_MONOREPO = {
    'package.json': JSON.stringify({ name: 'root', packageManager: 'pnpm@10.33.0' }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!**/test/**'\n",
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n",
};
const SINGLE_PACKAGE = { 'package.json': JSON.stringify({ name: 'api', scripts: { start: 'node index.js' } }), 'package-lock.json': '{}' };

const FROM = 'FROM node:22-bookworm\nWORKDIR /app\n';
const PINNED_PNPM = 'RUN corepack enable && corepack prepare pnpm@10.33.0 --activate\n';

describe('Node build facts', () => {
    it('reads workspaces, the package manager, the lockfile and the files the install reads', async () => {
        expect(await factsOf(YARN_MONOREPO)).toMatchObject({
            workspaceGlobs: ['apps/*', 'packages/*'],
            monorepo: true,
            packageManager: { name: 'yarn', version: '4.12.0' },
            lockfile: 'yarn.lock',
            installFiles: ['.yarnrc.yml', '.yarn/releases'],
            nx: false,
        });
        expect(await factsOf(PNPM_MONOREPO)).toMatchObject({ workspaceGlobs: ['apps/*', 'packages/*'], pnpmLockfileVersion: '9.0', lockfile: 'pnpm-lock.yaml' });
    });

    it('reads the build context, and is null where it has no package.json (not a Node build)', async () => {
        expect(await nodeBuildFacts(reader({ 'go.mod': 'module x' }), '.')).toBeNull();
        expect(await factsOf({ 'web/package.json': JSON.stringify({ packageManager: 'pnpm@9.15.0+sha512.abc' }) }, 'web')).toMatchObject({
            monorepo: false,
            packageManager: { name: 'pnpm', version: '9.15.0' },
        });
    });

    it('a single-package repository is no monorepo; Lerna, Nx or Turborepo make one', async () => {
        expect((await factsOf(SINGLE_PACKAGE)).monorepo).toBe(false);
        expect((await factsOf({ ...SINGLE_PACKAGE, 'lerna.json': '{}' })).workspaceGlobs).toEqual(['packages/*']);
        expect((await factsOf({ ...SINGLE_PACKAGE, 'nx.json': '{}' })).monorepo).toBe(true);
    });
});

describe('which COPY sources bring workspace source', () => {
    const globs = ['apps/*', 'packages/*', 'packages/embeds/*', 'tools/**'];
    it.each(['.', './', '*', 'apps', 'apps/', 'packages', 'packages/ui', 'apps/*', 'packages/embeds/react', 'tools', 'tools/x'])('%s does', (s) => {
        expect(copiesWorkspaceSource(s, globs)).toBe(true);
    });
    it.each(['apps/*/package.json', 'package.json', 'yarn.lock', '.yarn/releases', 'patches', 'packages/db/prisma', 'prisma', 'tsconfig.json', 'src'])('%s does not', (s) => {
        expect(copiesWorkspaceSource(s, globs)).toBe(false);
    });
    it('a glob that makes every directory a member says nothing: only the context itself counts', () => {
        expect(copiesWorkspaceSource('src', ['**'])).toBe(false);
        expect(copiesWorkspaceSource('.', ['**'])).toBe(true);
    });
});

describe('Node build: dependencies before source in a monorepo', () => {
    it("refuses an install after a COPY of the members (cal.com's 17-minute reinstall), with the COPY --parents line to write", async () => {
        const errors = await lint(
            YARN_MONOREPO,
            `${FROM}COPY package.json yarn.lock .yarnrc.yml ./\nCOPY .yarn ./.yarn\nCOPY apps ./apps\nCOPY packages ./packages\nRUN yarn install --immutable\nRUN yarn turbo build --filter=@calcom/web...\n`,
        );
        expect(errors).toEqual([
            expect.stringContaining('.kodus/Dockerfile:7 RUN installs dependencies after line 5 copied apps, so every change to the code installs again'),
        ]);
        expect(errors[0]).toContain('COPY --parents package.json yarn.lock .yarnrc.yml .yarn/releases apps/*/package.json packages/*/package.json ./');
        expect(errors[0]).toContain('turbo prune <app> --docker');
    });

    it('refuses COPY . . before pnpm install, and a bare yarn or yarn workspaces focus counts as an install', async () => {
        expect(await lint(PNPM_MONOREPO, `${FROM}${PINNED_PNPM}COPY . .\nRUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile\n`)).toEqual([
            expect.stringContaining('.kodus/Dockerfile:5 RUN installs dependencies after line 4 copied .'),
        ]);
        expect(await lint(YARN_MONOREPO, `${FROM}COPY . .\nRUN yarn\n`)).toHaveLength(1);
        expect(await lint(YARN_MONOREPO, `${FROM}COPY . .\nRUN yarn workspaces focus @calcom/web\n`)).toHaveLength(1);
        expect(await lint(YARN_MONOREPO, `${FROM}COPY . .\nRUN cd apps/web && npm ci\n`)).toHaveLength(1);
    });

    it('refuses source copied from an earlier stage that holds it', async () => {
        const errors = await lint(YARN_MONOREPO, `FROM node:22-bookworm AS src\nWORKDIR /app\nCOPY . .\nFROM node:22-bookworm\nWORKDIR /app\nCOPY --from=src /app ./\nRUN yarn install --immutable\n`);
        expect(errors).toEqual([expect.stringContaining('after line 6 copied /app from stage src')]);
    });

    it('accepts manifests with COPY --parents, the install, then COPY . . (and an install script step after it)', async () => {
        expect(
            await lint(
                YARN_MONOREPO,
                `${FROM}COPY --parents package.json yarn.lock .yarnrc.yml .yarn/releases apps/*/package.json packages/*/package.json ./\nRUN --mount=type=cache,target=/root/.yarn/berry/cache yarn install --immutable --mode=skip-build\nCOPY . .\nRUN yarn rebuild\n`,
            ),
        ).toEqual([]);
    });

    it("accepts turbo prune --docker: out/json and the pruned lockfile before the install, out/full after", async () => {
        const dockerfile = `FROM node:22-bookworm AS prune
WORKDIR /app
COPY . .
RUN npx turbo@2.7.1 prune @calcom/web --docker

FROM node:22-bookworm AS install
WORKDIR /app
COPY .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/yarn.lock ./yarn.lock
RUN yarn install --immutable
COPY --from=prune /app/out/full/ .
RUN yarn turbo build --filter=@calcom/web...
`;
        expect(await lint(YARN_MONOREPO, dockerfile)).toEqual([]);
        expect(installLayersOf(dockerfile, await factsOf(YARN_MONOREPO))).toEqual([{ line: 12 }]);
    });

    it('accepts pnpm fetch on the lockfile, COPY . ., then pnpm install --offline', async () => {
        expect(
            await lint(
                PNPM_MONOREPO,
                `${FROM}${PINNED_PNPM}COPY pnpm-lock.yaml pnpm-workspace.yaml ./\nRUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch\nCOPY . .\nRUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile\n`,
            ),
        ).toEqual([]);
    });

    it('accepts a stage built on an installed one that copies members, then prunes to production (twenty)', async () => {
        const dockerfile = `FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY packages/twenty-server/package.json packages/twenty-server/
RUN yarn workspaces focus twenty-server
FROM deps AS build
COPY packages/twenty-server packages/twenty-server
RUN yarn workspaces focus --production twenty-server
`;
        expect(await lint({ ...YARN_MONOREPO, 'package.json': JSON.stringify({ workspaces: ['packages/*'], packageManager: 'yarn@4.13.0' }) }, dockerfile)).toEqual([]);
    });

    it('lets through what is not an install of the project: a global tool, an install in an image stage', async () => {
        expect(await lint(PNPM_MONOREPO, `${FROM}COPY . .\nRUN npm install -g pnpm@10.33.0 && pnpm --filter web build\n`)).toEqual([]);
        expect(await lint(PNPM_MONOREPO, `${FROM}${PINNED_PNPM}COPY --from=node:22-bookworm /usr/local/bin /usr/local/bin\nCOPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\nRUN pnpm install\nCOPY . .\n`)).toEqual([]);
    });

    it('never refuses a single-package repository, whatever its order (no false refusal outside monorepos)', async () => {
        expect(await lint(SINGLE_PACKAGE, `${FROM}COPY . .\nRUN npm ci\nCMD ["npm", "start"]\n`)).toEqual([]);
        // ...but the eval still sees the install is not cache-friendly.
        expect(installLayersOf(`${FROM}COPY . .\nRUN npm ci\n`, await factsOf(SINGLE_PACKAGE))).toEqual([{ line: 4, afterSource: { line: 3, source: '.' } }]);
    });
});

describe('Node build: the package manager release', () => {
    it('refuses corepack enable with nothing pinning pnpm (the next.js pnpm 11 failure), naming the packageManager release', async () => {
        const errors = await lint(PNPM_MONOREPO, `${FROM}RUN corepack enable\nCOPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\nRUN pnpm install --frozen-lockfile\nCOPY . .\n`);
        expect(errors).toEqual([
            '.kodus/Dockerfile:3 RUN corepack enable pins no pnpm release: wherever no package.json naming one is in the working directory, corepack downloads the latest, and pnpm 11 stops the install on dependency build scripts pnpm-workspace.yaml does not allow (ERR_PNPM_IGNORED_BUILDS) and needs Node 22.13 or later. Add corepack prepare pnpm@10.33.0 --activate after it (what package.json packageManager names), or ENV COREPACK_DEFAULT_TO_LATEST=0 before it.',
        ]);
    });

    it('accepts corepack enable with a pinned prepare, a bare prepare that reads packageManager, or COREPACK_DEFAULT_TO_LATEST=0', async () => {
        const rest = 'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\nRUN pnpm install --frozen-lockfile\n';
        expect(await lint(PNPM_MONOREPO, `${FROM}${PINNED_PNPM}${rest}`)).toEqual([]);
        expect(await lint(PNPM_MONOREPO, `${FROM}COPY package.json ./\nRUN corepack enable && corepack prepare --activate\n${rest}`)).toEqual([]);
        expect(await lint(PNPM_MONOREPO, `${FROM}ENV COREPACK_DEFAULT_TO_LATEST=0\nRUN corepack enable\n${rest}`)).toEqual([]);
        expect(await lint(PNPM_MONOREPO, `${FROM}RUN COREPACK_DEFAULT_TO_LATEST=0 corepack enable\n${rest}`)).toEqual([]);
    });

    it('refuses an unpinned or latest pnpm, with the release to write', async () => {
        expect(await lint(PNPM_MONOREPO, `${FROM}RUN corepack prepare pnpm@latest --activate\n`)).toEqual([
            expect.stringMatching(/^\.kodus\/Dockerfile:3 RUN corepack prepare pnpm@latest --activate names no version, so it takes the latest release, and pnpm 11 .*; write corepack prepare pnpm@10\.33\.0 --activate \(what package\.json packageManager names\)\.$/),
        ]);
        // No packageManager: the major that writes the lockfile.
        const noPm = { ...PNPM_MONOREPO, 'package.json': JSON.stringify({ name: 'root' }) };
        expect(await lint(noPm, `${FROM}RUN npm install -g pnpm\n`)).toEqual([
            expect.stringContaining("RUN npm install -g pnpm names no version, so it takes the latest release, and pnpm 11 stops the install on dependency build scripts pnpm-workspace.yaml does not allow (ERR_PNPM_IGNORED_BUILDS) and needs Node 22.13 or later; write npm install -g pnpm@9 (the major that writes pnpm-lock.yaml lockfileVersion 9.0)."),
        ]);
    });

    it('refuses pnpm 11 on a 9.0 lockfile the project did not move to pnpm 11', async () => {
        expect(await lint(PNPM_MONOREPO, `${FROM}RUN npm install -g pnpm@11.0.9\n`)).toEqual([
            ".kodus/Dockerfile:3 RUN installs pnpm 11.0.9, but this lockfile (lockfileVersion 9.0) is not pnpm 11's: pnpm 11 stops the install on dependency build scripts pnpm-workspace.yaml does not allow (ERR_PNPM_IGNORED_BUILDS) and needs Node 22.13 or later; write npm install -g pnpm@10.33.0 instead (what package.json packageManager names).",
        ]);
        const noPm = { ...PNPM_MONOREPO, 'package.json': JSON.stringify({ name: 'root' }) };
        expect(await lint(noPm, `${FROM}RUN corepack enable && corepack prepare pnpm@11 --activate\n`)).toEqual([expect.stringContaining('write corepack prepare pnpm@9 --activate instead')]);
    });

    it('accepts pnpm 11 where packageManager names it, and pnpm 9 or 10 on a 9.0 lockfile', async () => {
        const pnpm11 = { ...PNPM_MONOREPO, 'package.json': JSON.stringify({ packageManager: 'pnpm@11.6.0' }) };
        expect(await lint(pnpm11, `${FROM}RUN corepack enable && corepack prepare pnpm@11.6.0 --activate\n`)).toEqual([]);
        expect(await lint(PNPM_MONOREPO, `${FROM}RUN npm install -g pnpm@10.12.1\n`)).toEqual([]);
        expect(await lint(PNPM_MONOREPO, `${FROM}RUN npm install -g pnpm@9\n`)).toEqual([]);
    });

    it('stays silent where nothing names the release to use: Yarn through packageManager, a repository with no pnpm', async () => {
        expect(await lint(YARN_MONOREPO, `${FROM}RUN corepack enable\nCOPY --parents package.json yarn.lock .yarnrc.yml .yarn/releases apps/*/package.json ./\nRUN yarn install\n`)).toEqual([]);
        expect(await lint(SINGLE_PACKAGE, `${FROM}RUN corepack enable && npm install -g pnpm\n`)).toEqual([]);
    });
});

describe('Node build: Nx without Nx Cloud', () => {
    const NX = { ...PNPM_MONOREPO, 'nx.json': '{"nxCloudId":"x"}', 'package.json': JSON.stringify({ packageManager: 'pnpm@10.33.0', scripts: { 'build:api': 'nx build api', lint: 'eslint .' } }) };
    const BASE = `${FROM}${PINNED_PNPM}COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml apps/*/package.json packages/*/package.json ./\nRUN pnpm install --frozen-lockfile\nCOPY . .\n`;

    it('refuses Nx run directly or through a root script without NX_NO_CLOUD=true', async () => {
        expect(await lint(NX, `${BASE}RUN npx nx build api\n`)).toEqual([
            '.kodus/Dockerfile:7 RUN runs Nx (npx nx build api) without NX_NO_CLOUD=true, so Nx tries Nx Cloud, which the build cannot reach; add ENV NX_NO_CLOUD=true NX_DISABLE_REMOTE_CACHE=true NX_DAEMON=false in this stage before it.',
        ]);
        expect(await lint(NX, `${BASE}RUN pnpm build:api\n`)).toEqual([expect.stringContaining('RUN runs Nx (pnpm build:api (the script runs nx build api))')]);
        expect(await lint(NX, `${BASE}RUN pnpm nx run api:build\n`)).toHaveLength(1);
        expect(await lint(NX, `${BASE}RUN yarn nx build api\n`)).toHaveLength(1);
    });

    it('accepts NX_NO_CLOUD in an ENV of the stage or one it is built on, or inline', async () => {
        expect(await lint(NX, `${BASE}ENV NX_NO_CLOUD=true NX_DISABLE_REMOTE_CACHE=true NX_DAEMON=false\nRUN npx nx build api\n`)).toEqual([]);
        expect(await lint(NX, `FROM node:22-bookworm AS base\nENV NX_NO_CLOUD=true\nFROM base\nRUN npx nx build api\n`)).toEqual([]);
        expect(await lint(NX, `${BASE}RUN NX_NO_CLOUD=true npx nx build api\n`)).toEqual([]);
        expect(await lint(NX, `${BASE}RUN export NX_NO_CLOUD=1 && pnpm build:api\n`)).toEqual([]);
    });

    it('an ENV of another stage does not count', async () => {
        expect(await lint(NX, `FROM node:22-bookworm AS a\nENV NX_NO_CLOUD=true\nFROM node:22-bookworm\nRUN npx nx build api\n`)).toHaveLength(1);
    });

    it('stays silent without nx.json, or for a command that does not run Nx', async () => {
        expect(await lint(PNPM_MONOREPO, `${BASE}RUN npx nx build api\n`)).toEqual([]);
        expect(await lint(NX, `${BASE}RUN pnpm lint && pnpm --filter api build && pnpm --filter api build:api\n`)).toEqual([]);
    });
});

describe('Node build: no dependency tree copied between stages', () => {
    /** The lines the Node build rules refuse. */
    const refusedLines = (errors: string[]) => errors.map((e) => Number(/^\.kodus\/Dockerfile:(\d+) /.exec(e)?.[1]));
    const DEPS = `FROM node:22-bookworm AS deps\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\n`;

    it("refuses copying an installed stage's node_modules into another stage (twenty's 439 s COPY on the cell)", async () => {
        expect(refusedLines(await lint(SINGLE_PACKAGE, `${DEPS}FROM node:22-bookworm\nWORKDIR /app\nCOPY --from=deps /app/node_modules /app/node_modules\nCOPY . .\n`))).toEqual([7]);
        expect(refusedLines(await lint(SINGLE_PACKAGE, `${DEPS}FROM node:22-bookworm\nWORKDIR /app\nCOPY --from=0 app/node_modules ./node_modules\n`))).toEqual([7]);
    });

    it('refuses copying the whole directory or root of a stage that installed, also when it inherits the install', async () => {
        expect(refusedLines(await lint(SINGLE_PACKAGE, `${DEPS}FROM node:22-bookworm\nCOPY --from=deps /app /app\n`))).toEqual([6]);
        expect(refusedLines(await lint(SINGLE_PACKAGE, `${DEPS}FROM deps AS build\nCOPY . .\nFROM node:22-bookworm\nCOPY --from=build . /\n`))).toEqual([8]);
    });

    it("refuses copying a workspace member's node_modules, or the whole member, from the stage that installed the workspace", async () => {
        const deps = `FROM node:22-bookworm AS deps\nWORKDIR /app\nCOPY --parents package.json yarn.lock .yarnrc.yml .yarn/releases apps/*/package.json packages/*/package.json ./\nRUN yarn install --immutable\n`;
        expect(refusedLines(await lint(YARN_MONOREPO, `${deps}FROM node:22-bookworm\nCOPY --from=deps /app/packages/*/node_modules /app/packages/\nCOPY --from=deps /app/apps/web /app/apps/web\n`))).toEqual([6, 7]);
    });

    it('accepts build output copied from the stage that installed (dist, .next, build), and a binary from another image', async () => {
        const build = `${DEPS}COPY . .\nRUN npm run build\nFROM node:22-bookworm-slim\nWORKDIR /app\n`;
        expect(await lint(SINGLE_PACKAGE, `${build}COPY --from=deps /app/dist ./dist\nCOPY --from=deps /app/.next/standalone ./\nCOPY --from=deps /app/build ./build\nCOPY --from=golang:1.23-bookworm /usr/local/go/bin/go /usr/local/bin/go\n`)).toEqual([]);
    });

    it('accepts a single build stage that installs and runs the app (the test environment shape)', async () => {
        expect(await lint(SINGLE_PACKAGE, `${FROM}COPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nCMD ["npm", "start"]\n`)).toEqual([]);
    });

    it('accepts copying from a stage that installed nothing (a source or prune stage)', async () => {
        expect(await lint(SINGLE_PACKAGE, `FROM node:22-bookworm AS src\nWORKDIR /app\nCOPY . .\nFROM node:22-bookworm\nCOPY --from=src /app /app\nWORKDIR /app\nRUN npm ci\n`)).toEqual([]);
    });
});

describe('Node build rules in the submission', () => {
    const files = [
        { path: '.kodus/Dockerfile', content: `${FROM}RUN corepack enable\nCOPY . .\nRUN pnpm install --frozen-lockfile\nCMD ["pnpm", "dev"]\n` },
        { path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n' },
    ];
    const recipe = 'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
    const exists = async (p: string) => p in PNPM_MONOREPO;

    it("refuse in Kody's tool (nodeBuild), and stay off by default so a recipe that booted is still reused as is", async () => {
        const on = await checkAuthoredSubmission(recipe, files, exists, reader(PNPM_MONOREPO), undefined, undefined, { nodeBuild: true });
        expect(on.ok).toBe(false);
        expect(on.errors).toEqual([expect.stringContaining('RUN installs dependencies after line 4 copied .'), expect.stringContaining('RUN corepack enable pins no pnpm release')]);
        expect((await checkAuthoredSubmission(recipe, files, exists, reader(PNPM_MONOREPO))).errors).toEqual([]);
    });

    it('the eval reads the install layer of each authored Dockerfile at the context its compose file gives', async () => {
        expect(await authoredInstallLayers(files, reader(PNPM_MONOREPO))).toEqual([
            { dockerfile: '.kodus/Dockerfile', context: '.', node: true, monorepo: true, installs: [{ line: 5, afterSource: { line: 4, source: '.' } }] },
        ]);
        const web = [{ path: '.kodus/web.Dockerfile', content: 'FROM node:22-bookworm\nCOPY package.json ./\nRUN npm ci\nCOPY . .\n' }, { path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: web, dockerfile: ../.kodus/web.Dockerfile }\n' }];
        expect(await authoredInstallLayers(web, reader({ 'web/package.json': '{}' }))).toEqual([
            { dockerfile: '.kodus/web.Dockerfile', context: 'web', node: true, monorepo: false, installs: [{ line: 3 }] },
        ]);
    });
});

// kr-nocodb on release v1l: three recipes on node:22, each build stopped on pnpm downloading Node 24.14.0
// from nodejs.org, which a build never reaches. pnpm downloads nothing when the image runs that very Node.
describe("Node build: the Node release the repository's .npmrc pins", () => {
    const NOCODB = {
        'package.json': JSON.stringify({ name: 'root', engines: { node: '>=18' } }),
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        '.npmrc': 'engine-strict=true\nshamefully-hoist=true\nuse-node-version=24.14.0\n',
    };
    const build = (from: string) => `FROM ${from}\nWORKDIR /app\n${PINNED_PNPM}COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc packages/*/package.json ./\nRUN pnpm install --frozen-lockfile\nCOPY . .\n`;

    it('reads use-node-version from .npmrc', async () => {
        expect(await factsOf(NOCODB)).toMatchObject({ useNodeVersion: '24.14.0' });
        expect((await factsOf(PNPM_MONOREPO)).useNodeVersion).toBeUndefined();
    });

    it('refuses a node image of another release, naming the image to build from', async () => {
        const errors = await lint(NOCODB, build('node:22.22.1-bookworm'));
        expect(errors).toEqual([expect.stringContaining('use-node-version=24.14.0')]);
        expect(errors[0]).toContain('FROM node:24.14.0-bookworm-slim');
        expect(errors[0]).toContain('nodejs.org');
    });

    it('accepts the very release, with any variant, or the setting overridden to the image release', async () => {
        expect(await lint(NOCODB, build('node:24.14.0-bookworm-slim'))).toEqual([]);
        expect(await lint(NOCODB, build('node:24.14.0'))).toEqual([]);
        expect(await lint(NOCODB, `ENV npm_config_use_node_version=22.22.1\n${build('node:22.22.1-bookworm')}`.replace(/^ENV.*\n(FROM.*\n)/, '$1ENV npm_config_use_node_version=22.22.1\n'))).toEqual([]);
    });

    it('never speaks of a repository that pins no Node, nor of a stage that is no node image', async () => {
        expect(await lint(PNPM_MONOREPO, build('node:22-bookworm'))).not.toEqual(expect.arrayContaining([expect.stringContaining('use-node-version')]));
        expect(await lint(NOCODB, `FROM nginx:1.27 AS web\n${build('node:24.14.0-bookworm-slim')}`)).toEqual([]);
    });
});
