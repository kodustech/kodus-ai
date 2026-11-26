import { RECIPE_TEST_VALUES } from '@libs/runtime/protocol/recipe';

import { AUTHORED_FILE_LIMITS } from './authored-files-policy';

// The rules for writing a Kody Runtime recipe (.kodus/workspace.yaml and the build files under .kodus/), in one place and
// with no model in it. Kody's author (recipe-author.agent.ts) puts them in its prompt and a developer's own coding agent
// reads them through env_recipe_guide / `kodus env recipe guide`: one source, so what Kody is told and what the
// developer's agent is told cannot drift. The text of each block is Kody's prompt text, word for word: a change here is a
// change of that prompt (bump RECIPE_AUTHOR_REVISIONS, libs/runtime/run/recipe-author-version.ts, when existing recipes
// must be written again).

/** The shape of the recipe: its fields and what each is for. */
export const RECIPE_SHAPE = `The recipe is YAML with only these fields:
version: 1
services:
  compose:
    files: [docker-compose.yml]          # compose files that already exist in the repository, merged in order
    profiles: [web]                       # optional: compose profiles to start
    public: app                           # the service that answers the health check
    health: /health                       # optional: a plain path that returns 200 when the app is up (default /)
    health_timeout: 300s                  # optional: how long the boot may take
    env: { NODE_ENV: development }        # optional: variables the compose file needs and has no default for
  expose:
    - { service: app, port: 3000, kind: http }      # the container port the app listens on, not the host port
    - { service: db, port: 5432, kind: postgres }   # optional: databases the tests may query (postgres, mysql)
data:
  migrate: npm run migrate                # optional: one plain command of the project's tool
  seed: { service: db, sql: db/seed.sql } # optional: an SQL file of the repository, or { service, command }

`;

/** The rules on what to boot and how to write the recipe's fields, shared by Kody and a developer's agent. */
export const RECIPE_RULES = `- Prefer what the repository has: its development compose file, or with no compose file a root Dockerfile fit for development (leave services.compose.files out: the cell builds it as one service named app, public: app). Only when neither fits (none, or only a production build), write your own files (below). With nothing you can build, submit an empty recipe and say why in notes.
- The repository's own way to run comes first: a compose file or Dockerfile it ships for development or self-hosting (at the root, docker/, deploy/, packages/*-docker) goes in services.compose.files, with a compose file of yours beside it adding only what is missing. Read the CI workflow that installs, builds and starts the app and mirror its steps (versions, commands, variables).
- Never put a secret in env. A variable that only has to be set gets ${RECIPE_TEST_VALUES[0]}; a URL gets ${RECIPE_TEST_VALUES[1]}.
- Commands are one plain call of the project's tool (npm, pnpm, yarn, python, bundle, php, make...), with no pipes, quotes, variables or URLs.
- Prefer the development compose file and the fewest services that make the app answer. Leave out frontends and workers the API does not need.
- An app that serves pages a browser loads runs its production server under NODE_ENV=production, built and started the way the framework documents, even where the repository's development compose file or Dockerfile runs a dev server (then write your own files): Next.js next build then next start; React Router react-router build then react-router-serve ./build/server/index.js; Remix remix build (remix vite:build with Vite) then remix-serve on the server build; Nuxt nuxt build then node .output/server/index.mjs; SvelteKit with adapter-node vite build then node build; a Vite or Astro site vite build then vite preview --host 0.0.0.0 (astro preview --host 0.0.0.0). The browser probes load its pages: a dev server compiles each page on its first request and keeps a reload socket open. Start the dev server only when the app has no production start, or its build cannot run here, and then say so in notes.
`;

/** What the build reaches: the head line of the list below. */
export const BUILD_SANDBOX_HEAD = `The build reaches package registries and the read-only hosts of the Kodus recommended list only (npm, PyPI, Docker Hub, Debian and Alpine, Go, Maven, GitHub release downloads, Google Fonts...); any other host fails it:
`;

/**
 * The package manager and platform rules of the build. `kodyOnly` ones read the CI evidence or the Facts block of Kody's
 * first message, or say what Kodus adds to a Dockerfile Kody writes: a developer's agent gets its own words for them.
 */
export const BUILD_SANDBOX_BULLETS: ReadonlyArray<{ text: string; kodyOnly?: true }> = [
    { text: `- Nx: ENV NX_NO_CLOUD=true NX_DISABLE_REMOTE_CACHE=true NX_DAEMON=false NX_SKIP_NX_CACHE=true in every stage that runs nx; an Nx Cloud token in nx.json does not change that.\n` },
    { text: `- Yarn Berry with yarnPath in .yarnrc.yml: copy .yarnrc.yml and .yarn/releases and run that committed release (yarn install --immutable); never corepack enable or corepack prepare, which download Yarn. The node images already ship /usr/local/bin/yarn, which reads yarnPath and runs the committed release by itself: never ln -s over it (the build fails with File exists).\n` },
    { text: `- pnpm: install the version package.json's packageManager names (corepack prepare pnpm@<that version> --activate, or npm install -g pnpm@<that version>). With no packageManager, pin the major the lockfile's lockfileVersion was written by (9.0: pnpm@9) and never let corepack pick the latest (ENV COREPACK_DEFAULT_TO_LATEST=0): pnpm 10 and later skip dependencies' build scripts unless pnpm-workspace.yaml allows them, and pnpm 11 fails on them (ERR_PNPM_IGNORED_BUILDS) and needs Node 22.13 or later. corepack enable alone is refused: follow it with corepack prepare pnpm@<that version> --activate.\n` },
    { text: `- A Next.js app that imports next/font/google builds with next build: the build reaches fonts.googleapis.com and fonts.gstatic.com through the Kodus recommended list. Only when the Facts say the organization turned that list off, run next dev instead and say so in notes.\n`, kodyOnly: true },
    { text: `- The cell builds linux/arm64, where many native Node modules (bcrypt, bufferutil, utf-8-validate, better-sqlite3, node-gyp builds) have no prebuilt binary and compile on install: base a Node image on the full node:<version>-bookworm, which has python3, make and g++, not -slim; and do not apt-get install build-essential or python3 on a slim image, use the full one instead.\n` },
    { text: `- Firebase emulators (an emulators block in firebase.json, firebase emulators:start): firebase-tools downloads each emulator from storage.googleapis.com when they start, which no machine reaches, but the Kodus mirror serves them. Never leave out the emulators the CI starts (logins and data often go through them): run them from a Dockerfile under .kodus/ that installs firebase-tools and Java, and Kodus adds the step that fetches the emulators from its mirror. A service built from the repository's own Dockerfile gets no such step, and its emulators fail to start.\n`, kodyOnly: true },
    { text: `- A Cypress suite in the CI evidence: add a service named e2e to your compose file, built from .kodus/Dockerfile.e2e: FROM cypress/included:<the cypress version the lockfile pins> (it has the Cypress app, its browsers and Xvfb), the same dependency install as the app with ENV CYPRESS_INSTALL_BINARY=0 (the image already has the app), then COPY . . and no CMD; depends_on the public service, and expose nothing of its own. Once the app answers, the setup runs one spec of the suite in that service; when it finds no spec or the runner leaves no result, that is the recipe's failure and its output comes back to you. The suite runs in that container, and Kodus makes it answer localhost for every port the recipe exposes, as the CI runner did: expose each service the tests reach (the app, its API, emulators, a database the tests seed).\n`, kodyOnly: true },
];

/** The monorepo rules. */
export const MONOREPO_RULES = `Monorepos (workspace globs in the Facts):
- Install at the root with the root lockfile and every member's package.json (pnpm install --frozen-lockfile, yarn install --immutable), then start the app with its filter (pnpm --filter <app>... start, yarn workspace <app> start; dev only as the rule on pages says). Never build one package on its own: its workspace dependencies are not on npm.
- Build only the app under test and what it depends on (turbo build --filter=<app>..., nx build <app>, pnpm --filter <app>... build), never the whole monorepo.
- Turborepo: FROM node:<version> AS prune, COPY . ., RUN npx turbo@<the turbo version package.json pins> prune <app> --docker; in the next stage COPY --from=prune /app/out/json/ ./ and the pruned lockfile (/app/out/<lockfile>; Yarn Berry also .yarnrc.yml and .yarn/releases), install, then COPY --from=prune /app/out/full/ ./ and build or start the app. pnpm without Turborepo can fetch from the lockfile alone: COPY pnpm-lock.yaml pnpm-workspace.yaml ./, RUN pnpm fetch, COPY . ., RUN pnpm install --offline --frozen-lockfile.
- A framework or library repository has nothing of its own to serve: when its CI boots an example or demo app, boot that example the same way the CI does.

`;

/** What the build reaches, the package manager rules and the monorepo rules, for Kody's prompt. */
export const BUILD_SANDBOX_RULES = BUILD_SANDBOX_HEAD + BUILD_SANDBOX_BULLETS.map((b) => b.text).join('') + MONOREPO_RULES;

/** The rules for the build files under .kodus/. `where` is how the submitter hands them over. */
export const authoredFilesRules = (where: string): string => `Your own files go in ${where}, at most ${AUTHORED_FILE_LIMITS.files}, each directly under .kodus/ and never a path the repository has: usually .kodus/Dockerfile and a .kodus/compose.yaml that builds it (build: { context: ., dockerfile: .kodus/Dockerfile }), named in services.compose.files. A file named after one of your Dockerfiles plus .dockerignore (.kodus/Dockerfile.e2e.dockerignore) is the .dockerignore that Dockerfile's build reads instead of the repository's. Paths in a compose file are relative to the repository root. The checks refuse: FROM other than a Docker Hub image with a version tag or digest (golang:1.23-bookworm, node:22-bookworm-slim, python:3.12-slim, postgres:16), ADD, downloaded scripts (curl ... | sh), secrets, parser directives, RUN flags other than --mount=type=cache or type=bind, and in compose privileged, cap_add, devices, host namespaces, env_file and binds outside the repository. For a Node project they also refuse an install after a COPY of a monorepo's packages (or COPY . .), a pnpm release left to latest (corepack enable alone, pnpm@latest, pnpm 11 on a lockfile the project did not move to pnpm 11), nx run without NX_NO_CLOUD=true, and a COPY --from of another stage's node_modules.
`;

/** What makes an image build fast, with a cell that rebuilds it for every pull request. */
export const BUILD_SPEED_RULES = `Every pull request rebuilds the image, so write it to build fast:
- Dependencies before source: copy only the manifests, install, then copy the source. Go: go.mod and go.sum, then go mod download (a go.work, or a replace directive to a local path, needs those modules copied first too; when it does, copy the source and download after). Node: package.json and the lockfile, then npm ci, pnpm install --frozen-lockfile or yarn install --frozen-lockfile (a workspace needs every member's package.json). Python: requirements*.txt, or pyproject.toml with its lock, then the install.
- In a monorepo, the install layer takes only what the install reads, with COPY --parents so each file keeps its path: the root package.json and lockfile, the package manager's own files (.npmrc, .yarnrc.yml, .yarn/releases, .yarn/plugins, .yarn/patches, pnpm-workspace.yaml, patches/) and every workspace's package.json by the globs the workspace config names, for example COPY --parents package.json yarn.lock .yarnrc.yml .yarn/releases apps/*/package.json packages/*/package.json ./ . Then the install, then COPY . . Never COPY apps/, packages/ or the whole source before the install: every change to the code would install again, and a large monorepo's install and its image layer take more than half an hour on the cell. When a workspace's install script needs its source (prisma generate, a build), install with scripts skipped (yarn install --immutable --mode=skip-build, pnpm install --frozen-lockfile --ignore-scripts, npm ci --ignore-scripts) and run the rebuild or that step after COPY . . (yarn rebuild, pnpm rebuild, npm rebuild).
- Nuxt (a workspace whose postinstall or prepare script runs nuxt prepare): that step reads nuxt.config, its layers (extends), the app or pages directory and the locale files the config names, so on a manifests-only install layer it exits 1 (it needs no network: Nuxt telemetry is turned off by the env Kody's Dockerfile sets, and its font and icon modules log a failed fetch and go on). Do not let the install layer fail and do not give up the install scripts of the other packages: install with scripts skipped as above, then after COPY . . run pnpm rebuild, npm rebuild or yarn rebuild, and nuxt prepare in that workspace (pnpm --filter <app> exec nuxt prepare, npm --workspace <app> exec nuxt prepare, yarn workspace <app> exec nuxt prepare). Never remove the postinstall from package.json.
- Package and compile caches in RUN --mount=type=cache,target=..., never in a layer: Go /go/pkg/mod and /root/.cache/go-build, npm /root/.npm, pnpm /root/.local/share/pnpm/store, Yarn Berry /root/.yarn/berry/cache, Yarn 1 /usr/local/share/.cache/yarn, pip /root/.cache/pip. Mount the same cache in every RUN that uses it.
- Go: declare ARG GOPROXY in the build stage; the cell passes its module mirror there.
- Multi-stage when the app compiles: build in the full image, copy only the binary or build output into a slim runtime stage.
- Node: for a test environment prefer one build stage that installs and runs the app. Never copy node_modules (or a directory holding it) between stages: on the cell that copy takes minutes.
- No release or all-platform builds, and only the binary or app the API needs, not the whole monorepo. A service without pages gets a development build; an app with pages builds what its production start serves.`;
