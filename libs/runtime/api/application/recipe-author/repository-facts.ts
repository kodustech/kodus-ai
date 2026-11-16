import * as yaml from 'js-yaml';

import type { RepoReader } from './repo-reader';
import { UNTRUSTED_YAML } from '@libs/runtime/protocol/yaml-limits';

/**
 * What the recipe author knows before it reads anything: computed from the
 * root listing and a few small manifests, no model involved (Railpack's
 * detection order). Runs that read until the tokens ran out (calcom, nocodb),
 * built one package of a monorepo without its workspace (nextjs, payload) or
 * needed a host the sandbox does not reach (Google Fonts, Nx Cloud, the Yarn
 * download) all spent their reads finding these.
 */
export interface RepositoryFact {
    fact: string;
    /** The file (or listing) the fact was read from. */
    source: string;
}

const MANIFEST_BYTES = 32 * 1024;
const LISTED = 10;
/** Files read to look for `next/font/google`: layouts, _app/_document and font modules. */
const FONT_READS = 6;
const FONT_FILE = /(?:^|\/)(?:app\/layout|pages\/_app|pages\/_document|fonts?)\.[cm]?[jt]sx?$/;
/** Vendored or generated trees: no fact comes from a path inside them. */
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|vendor|dist|\.next)\//;
/** Build output is no place for a font import, but `build/` also holds Dockerfiles and packaging (build/package/Dockerfile), so it is skipped only here. */
const FONT_SKIPPED_DIR = /(?:^|\/)build\//;

/** Repository text goes in the prompt only when it is a plain token: no sentence can pass as a fact. */
const VERSION = /^(?:lts\/[a-z*-]{1,20}|[\dvx.*=<>~^|\s-]{1,40})$/i;
const GLOB = /^[\w@.*!{},/-]{1,80}$/;
const PACKAGE_MANAGER = /^[a-z]{2,8}@[\w.+-]{1,120}$/;
const PLAIN_PATH = /^[\w@.+/-]{1,200}$/;
const matching = (re: RegExp) => (v: unknown): string | null => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : null);
const version = matching(VERSION);
const glob = matching(GLOB);

const LOCKFILES: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
];
const DOCKERFILE = /(?:^|\/)(?:Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.Dockerfile)$/;
const COMPOSE = /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;
const NEXT_CONFIG = /(?:^|\/)next\.config\.[cm]?[jt]s$/;

async function readJson(reader: RepoReader, path: string): Promise<Record<string, any> | null> {
    // Facts are prompt hints (repositoryFacts): a file unreadable or not JSON only leaves its fact out.
    const text = await reader.read(path, MANIFEST_BYTES).catch(() => null);
    if (text === null) return null;
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

// As readJson: an unreadable file only leaves its fact out.
const readText = (reader: RepoReader, path: string) => reader.read(path, MANIFEST_BYTES).catch(() => null);

function shownPaths(paths: string[]): string {
    const safe = paths.filter((p) => PLAIN_PATH.test(p));
    const more = safe.length - LISTED;
    return `${safe.slice(0, LISTED).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/** The facts of one commit; a read that fails only leaves its fact out. */
export async function repositoryFacts(reader: RepoReader): Promise<RepositoryFact[]> {
    const facts: RepositoryFact[] = [];
    const add = (fact: string, source: string) => facts.push({ fact, source });
    // An unreadable listing leaves the facts it would have given out, as any failed read here.
    const root = new Set(await reader.list('').catch(() => [] as string[]));
    // The whole tree when the reader has it (one call), else only the root.
    const tree = reader.paths ? await reader.paths().catch(() => null) : null;
    const all = (tree ?? [...root]).filter((p) => !SKIPPED_DIR.test(p));

    const pkg = root.has('package.json') ? await readJson(reader, 'package.json') : null;

    // Package manager: the packageManager field, then the lockfile.
    const pm = matching(PACKAGE_MANAGER)(pkg?.packageManager);
    if (pm) add(`package manager ${pm.split('+')[0]} (corepack downloads it unless the version is committed)`, 'package.json packageManager');
    const lock = LOCKFILES.find(([f]) => root.has(f));
    if (lock) add(`${lock[1]} lockfile`, lock[0]);
    if (root.has('.yarnrc.yml')) {
        const yarnPath = (await readText(reader, '.yarnrc.yml'))?.match(/^yarnPath:\s*["']?([^"'\s#]+)/m)?.[1];
        if (yarnPath && PLAIN_PATH.test(yarnPath)) add(`Yarn release committed at ${yarnPath}`, '.yarnrc.yml yarnPath');
        else add('Yarn Berry, no committed release (yarnPath unset)', '.yarnrc.yml');
    }

    // Node version.
    for (const f of ['.nvmrc', '.node-version']) {
        if (!root.has(f)) continue;
        const v = version((await readText(reader, f))?.split('\n')[0]);
        if (v) add(`Node ${v}`, f);
    }
    const engine = version(pkg?.engines?.node);
    if (engine) add(`Node ${engine}`, 'package.json engines.node');

    const install = ['preinstall', 'install', 'postinstall', 'prepare'].filter((s) => typeof pkg?.scripts?.[s] === 'string');
    if (install.length) add(`root install scripts: ${install.join(', ')} (they run during install)`, 'package.json scripts');

    // Workspaces.
    const pkgWorkspaces = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : [];
    let globs = pkgWorkspaces.map(glob).filter(Boolean) as string[];
    let globSource = 'package.json workspaces';
    if (root.has('pnpm-workspace.yaml')) {
        try {
            const doc = yaml.load((await readText(reader, 'pnpm-workspace.yaml')) ?? '', UNTRUSTED_YAML) as { packages?: unknown };
            const pnpmGlobs = (Array.isArray(doc?.packages) ? doc.packages : []).map(glob).filter(Boolean) as string[];
            if (pnpmGlobs.length) [globs, globSource] = [pnpmGlobs, 'pnpm-workspace.yaml'];
        } catch {
            /* an unreadable workspace file only leaves the fact out */
        }
    }
    if (globs.length) add(`workspace monorepo: ${globs.slice(0, 12).join(', ')}`, globSource);

    for (const [f, tool] of [
        ['turbo.json', 'Turborepo'],
        ['nx.json', 'Nx'],
        ['lerna.json', 'Lerna'],
    ] as const)
        if (root.has(f)) add(tool, f);
    if (root.has('nx.json')) {
        const nx = await readJson(reader, 'nx.json');
        const runner = nx?.tasksRunnerOptions?.default?.runner;
        const cloud = ['nxCloudAccessToken', 'nxCloudId', 'nxCloudUrl'].filter((k) => nx?.[k]);
        if (typeof runner === 'string' && /nx-cloud/.test(runner)) cloud.push('tasksRunnerOptions nx-cloud runner');
        if (cloud.length) add(`Nx Cloud configured (${cloud.join(', ')}): cloud.nx.app is not reachable`, 'nx.json');
    }

    // Next.js, and whether it fetches Google Fonts at build time.
    const nextConfigs = all.filter((p) => NEXT_CONFIG.test(p));
    const nextDep = pkg?.dependencies?.next ?? pkg?.devDependencies?.next;
    if (nextConfigs.length) add(`Next.js apps: ${shownPaths(nextConfigs.map((p) => p.replace(/\/?next\.config\.[^/]+$/, '') || '.'))}`, 'next.config.*');
    else if (nextDep) add('Next.js', 'package.json dependencies.next');
    if (nextConfigs.length || nextDep) {
        const fontFiles: string[] = [];
        for (const p of all.filter((f) => FONT_FILE.test(f) && !FONT_SKIPPED_DIR.test(f)).slice(0, FONT_READS)) {
            if ((await readText(reader, p))?.includes('next/font/google')) fontFiles.push(p);
        }
        if (fontFiles.length) add('imports next/font/google: `next build` fetches fonts.googleapis.com and fonts.gstatic.com', shownPaths(fontFiles));
    }

    const dockerfiles = all.filter((p) => DOCKERFILE.test(p));
    if (dockerfiles.length) add(`Dockerfiles: ${shownPaths(dockerfiles)}`, tree ? 'tree listing' : 'root listing');
    const compose = all.filter((p) => COMPOSE.test(p));
    if (compose.length) add(`compose files: ${shownPaths(compose)}`, tree ? 'tree listing' : 'root listing');
    if (all.some((p) => p.startsWith('.devcontainer/')) || root.has('.devcontainer/')) add('devcontainer', '.devcontainer/');

    // No listing, no CI fact.
    const workflows = (await reader.list('.github/workflows').catch(() => [] as string[])).filter((f) => /\.ya?ml$/.test(f) && PLAIN_PATH.test(f));
    if (workflows.length) add(`CI workflows: ${shownPaths(workflows)}`, '.github/workflows/');
    return facts;
}

/** The block the agent's first message carries; empty when nothing was found. */
export function factsBlock(facts: RepositoryFact[]): string {
    if (!facts.length) return '';
    return `Facts (verified, computed from the commit before you started; each names its file):\n${facts.map((f) => `- ${f.fact} [${f.source}]`).join('\n')}`;
}

/**
 * The block of a multi-repository environment: each repository's facts under
 * its alias and where it is (the primary at the root, another at
 * ../<alias>/), each source a path inside that repository. Empty when no
 * repository gave a fact.
 */
export function workspaceFactsBlock(repositories: ReadonlyArray<{ alias: string; fullName: string; primary?: boolean; facts: RepositoryFact[] }>): string {
    if (!repositories.some((r) => r.facts.length)) return '';
    const sections = repositories
        .filter((r) => r.facts.length)
        .map(
            (r) =>
                `${r.alias} (${r.fullName}, ${r.primary ? 'the primary, at the root' : `at ../${r.alias}/`}):\n${r.facts.map((f) => `- ${f.fact} [${f.source}]`).join('\n')}`,
        );
    return `Facts (verified, computed from each repository's commit before you started; each names its file inside that repository):\n${sections.join('\n')}`;
}
