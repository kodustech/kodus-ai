import { posix } from 'path';

import * as yaml from 'js-yaml';

import { AUTHORED_FILES_LIMITS } from '@libs/runtime/contracts/authored-files';
import { RECIPE_FILE_PATHS } from '@libs/runtime/contracts/enums';
import { type RecipeNeed, recipeNeedsConflict, RECIPE_TEST_VALUES } from '@libs/runtime/protocol/recipe';
import { redactPatterns } from '@libs/runtime/redaction';
import { SECRET_NAME } from '@libs/runtime/run/recipe-inference';

import { sanitiseAuthoredCompose } from './authored-compose-sanitiser';
import { declareMirrorBuildArgs } from './authored-dockerfile-mirror';
import { checkAuthoredRecipe, type AuthoredRecipeCheck } from './authored-recipe-policy';
import { RepoPathError, repoPath } from './repo-reader';
import { UNTRUSTED_YAML } from '@libs/runtime/protocol/yaml-limits';

/**
 * The Dockerfiles and compose files Kody may write next to its recipe. Like
 * the recipe, they come from text the model read, which a pull request or a
 * README can steer, so they pass rules stricter than the cell's: the cell
 * still checks every compose file and builds every Dockerfile in its sandbox
 * (it treats a RUN step as PR code), and these rules never replace that.
 * They only live under .kodus/, never replace a file of the repository, and
 * name only what the cell's mirror serves.
 */

export const AUTHORED_FILES_DIR = '.kodus/';
/** The bounds every hop carries the files under (contracts/authored-files.ts): what Kody submits is what the cell accepts. */
export const AUTHORED_FILE_LIMITS = AUTHORED_FILES_LIMITS;

export interface AuthoredFile {
    /** Repository-relative, under .kodus/. */
    path: string;
    content: string;
}

export type AuthoredFileKind = 'dockerfile' | 'compose';

/** A name directly under .kodus/: one segment, plain characters. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOCKERFILE_NAME = /^(Dockerfile(\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.Dockerfile)$/;
const COMPOSE_NAME = /\.ya?ml$/;

/** What kind of file the name says, or null for a name Kody does not write. */
export function authoredFileKind(path: string): AuthoredFileKind | null {
    const name = posix.basename(path);
    if (DOCKERFILE_NAME.test(name)) return 'dockerfile';
    if (COMPOSE_NAME.test(name)) return 'compose';
    return null;
}

/** A URL with a password in it, and the password. */
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/([^/\s:@]*):([^/\s@]*)@([^/\s:?#]+)/gi;
const KNOWN_SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9_-]{16,}|sk_live_|AKIA[0-9A-Z]{16}|xox[abpr]-|-----BEGIN)/;
const TEST_VALUES = RECIPE_TEST_VALUES as readonly string[];

/** Why a text holds a secret, or null. Credentials of a URL pass only with a test value as the password and a host of `hosts`. */
function secretProblem(text: string, hosts: ReadonlySet<string> = new Set()): string | null {
    if (KNOWN_SECRET.test(text) || redactPatterns(text).text !== text) return 'holds what looks like a secret';
    for (const m of text.matchAll(URL_CREDENTIALS)) {
        if (!TEST_VALUES.includes(m[2]) || !hosts.has(m[3])) {
            return `has a URL with credentials (${m[3]}); only a service of this project with the password ${TEST_VALUES[0]}`;
        }
    }
    return null;
}

/** A variable whose name says secret holds only a test value (or nothing). */
function secretVariable(name: string, value: string): boolean {
    return SECRET_NAME.test(name) && value !== '' && !TEST_VALUES.includes(value);
}

// --- Images -----------------------------------------------------------------------------------

const OCI_NAME = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*){0,3}$/;
const OCI_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Why an image is refused, or null when the cell's mirror serves it: a Docker
 * Hub image (apps/runtime-cell/internal/mirror/images.go DockerHubPin) named
 * by an explicit tag other than latest, or by digest.
 */
export function imageProblem(image: string): string | null {
    let ref = image.trim();
    if (!ref) return 'names no image';
    if (/[$\s]/.test(ref)) return `${JSON.stringify(image)} is not a plain image name; name the image and its tag directly`;
    const slash = ref.indexOf('/');
    if (slash > 0) {
        const first = ref.slice(0, slash);
        if (/[.:]/.test(first) || first === 'localhost') {
            if (!['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(first)) {
                return `${JSON.stringify(image)} is not on Docker Hub; the cell's mirror serves only Docker Hub images`;
            }
            ref = ref.slice(slash + 1);
        }
    }
    const at = ref.indexOf('@');
    let name = at >= 0 ? ref.slice(0, at) : ref;
    const digest = at >= 0 ? ref.slice(at + 1) : undefined;
    let tag: string | undefined;
    const colon = name.lastIndexOf(':');
    if (colon > 0 && !name.slice(colon).includes('/')) {
        tag = name.slice(colon + 1);
        name = name.slice(0, colon);
    }
    if (!OCI_NAME.test(name.includes('/') ? name : `library/${name}`)) return `${JSON.stringify(image)} is not a valid Docker Hub image name`;
    if (digest !== undefined) return OCI_DIGEST.test(digest) ? null : `${JSON.stringify(image)} has a malformed digest`;
    if (tag === undefined) return `${JSON.stringify(image)} has no tag; name a version tag (node:22-bookworm-slim) or a digest`;
    if (!OCI_TAG.test(tag)) return `${JSON.stringify(image)} has a malformed tag`;
    if (tag === 'latest') return `${JSON.stringify(image)} uses latest; name a version tag so every boot builds the same image`;
    return null;
}

// --- Dockerfile -------------------------------------------------------------------------------

/** The instructions an authored Dockerfile may use. ONBUILD, SHELL and MAINTAINER are not needed for a development build. */
const INSTRUCTIONS = new Set(['FROM', 'ARG', 'ENV', 'WORKDIR', 'COPY', 'ADD', 'RUN', 'CMD', 'ENTRYPOINT', 'EXPOSE', 'USER', 'LABEL', 'HEALTHCHECK', 'STOPSIGNAL', 'VOLUME']);
const MOUNT_KEYS = new Set(['type', 'target', 'dst', 'destination', 'source', 'src', 'from', 'id', 'sharing', 'mode', 'uid', 'gid', 'ro', 'readonly', 'rw', 'readwrite']);
const COPY_FLAGS = new Set(['--from', '--chown', '--chmod', '--link', '--exclude', '--parents']);
const PLATFORM = /^(\$BUILDPLATFORM|\$TARGETPLATFORM|\$\{BUILDPLATFORM\}|\$\{TARGETPLATFORM\}|linux\/(amd64|arm64)(\/v8)?)$/;
const STAGE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** An earlier stage, by name or index. */
const isStage = (stages: ReadonlySet<string>, ref: string) => /^\d+$/.test(ref) || stages.has(ref.toLowerCase());
const DOWNLOAD = /\b(curl|wget|fetch|aria2c|http)\b/;
/** A download piped or substituted into an interpreter: `curl … | sh`, `sh -c "$(curl …)"`, `bash <(wget …)`. */
const REMOTE_SCRIPT = [
    /\b(curl|wget|fetch|aria2c)\b[^;&]*\|\s*(sudo(\s+-\S+)*\s+)?(env\s+)?(\w+=\S*\s+)*(\/\S*\/)?(sh|bash|zsh|dash|ash|ksh|fish|python[0-9.]*|perl|ruby|node|php|bun|deno|source|\.)(?=\s|$|;|\))/,
    /[$<]\(\s*(curl|wget|fetch|aria2c)\b/,
    /`\s*(curl|wget|fetch|aria2c)\b/,
];

interface Instruction {
    line: number;
    keyword: string;
    args: string;
}

/** The instructions of a Dockerfile, continuation lines joined, comments dropped. */
function instructionsOf(content: string): Instruction[] {
    const out: Instruction[] = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const start = i;
        let text = lines[i];
        if (/^\s*(#|$)/.test(text)) continue;
        while (/\\\s*$/.test(text) && i + 1 < lines.length) {
            text = text.replace(/\\\s*$/, ' ');
            i++;
            // Comment lines inside a continued instruction are dropped by the parser.
            if (/^\s*#/.test(lines[i])) {
                text += '\\';
                continue;
            }
            text += lines[i];
        }
        const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(text);
        out.push({ line: start + 1, keyword: (m?.[1] ?? text.trim()).toUpperCase(), args: (m?.[2] ?? '').trim() });
    }
    return out;
}

/** Leading `--flag[=value]` words of an instruction, and what follows them. */
function flagsOf(args: string): { flags: Array<{ name: string; value?: string }>; rest: string } {
    const flags: Array<{ name: string; value?: string }> = [];
    let rest = args;
    for (;;) {
        const m = /^(--[A-Za-z-]+)(?:=(\S*))?\s*/.exec(rest);
        if (!m) break;
        flags.push({ name: m[1].toLowerCase(), ...(m[2] !== undefined ? { value: m[2] } : {}) });
        rest = rest.slice(m[0].length);
    }
    return { flags, rest };
}

/** `NAME=value NAME2="v"` or the legacy `NAME value` of ENV and ARG. */
function assignmentsOf(args: string, legacy: boolean): Array<{ name: string; value: string; hasValue: boolean }> {
    const out: Array<{ name: string; value: string; hasValue: boolean }> = [];
    if (legacy && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(args);
        if (m) out.push({ name: m[1], value: (m[2] ?? '').trim().replace(/^["']|["']$/g, ''), hasValue: m[2] !== undefined });
        return out;
    }
    for (const m of args.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:=("(?:[^"\\]|\\.)*"|'[^']*'|\S*))?/g)) {
        const raw = m[2];
        out.push({ name: m[1], value: raw === undefined ? '' : raw.replace(/^["']|["']$/g, ''), hasValue: raw !== undefined });
    }
    return out;
}

/** Each rule an authored Dockerfile breaks, in words the model can act on. */
export function checkAuthoredDockerfile(path: string, content: string): string[] {
    const errors: string[] = [];
    const at = (i: Instruction, why: string) => errors.push(`${path}:${i.line} ${i.keyword} ${why}`);

    for (const [n, l] of content.split(/\r?\n/).entries()) {
        if (/^\s*#\s*(syntax|escape|check)\s*=/i.test(l)) {
            errors.push(`${path}:${n + 1} a parser directive; leave it out (the cell's builder already supports RUN --mount)`);
        }
    }
    const secret = secretProblem(content);
    if (secret) errors.push(`${path} ${secret}; a Dockerfile Kody writes never holds one`);
    if (/--privileged\b|--security(=|\s)|--cap-add\b|--device\b/i.test(content)) {
        errors.push(`${path} asks for privileges (--privileged, --security, --cap-add or --device); the cell builds without them`);
    }

    const instructions = instructionsOf(content);
    const stages = new Set<string>();
    let froms = 0;
    for (const i of instructions) {
        if (!INSTRUCTIONS.has(i.keyword)) {
            at(i, `is not an instruction Kody writes (${[...INSTRUCTIONS].join(', ')})`);
            continue;
        }
        if (froms === 0 && i.keyword !== 'FROM' && i.keyword !== 'ARG') at(i, 'comes before the first FROM');
        if (/<<-?\s*["']?[A-Za-z_]/.test(i.args) && (i.keyword === 'RUN' || i.keyword === 'COPY' || i.keyword === 'ADD')) {
            at(i, 'uses a heredoc; write the commands on the instruction line, joined with &&');
            continue;
        }
        const { flags, rest } = flagsOf(i.args);
        switch (i.keyword) {
            case 'FROM': {
                froms++;
                for (const f of flags) {
                    if (f.name !== '--platform' || !PLATFORM.test(f.value ?? '')) at(i, `flag ${f.name}${f.value ? `=${f.value}` : ''} is refused; only --platform=$BUILDPLATFORM`);
                }
                const m = /^(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(rest);
                if (!m) {
                    at(i, 'is not "FROM image[:tag] [AS name]"');
                    break;
                }
                const [, image, alias] = m;
                if (!stages.has(image.toLowerCase()) && image !== 'scratch') {
                    const p = imageProblem(image);
                    if (p) at(i, p);
                }
                if (alias) {
                    if (!STAGE.test(alias)) at(i, `stage name ${JSON.stringify(alias)} is not plain`);
                    stages.add(alias.toLowerCase());
                }
                break;
            }
            case 'ARG':
            case 'ENV': {
                if (flags.length) at(i, 'takes no flags');
                for (const a of assignmentsOf(rest, i.keyword === 'ENV')) {
                    if (secretVariable(a.name, a.value)) {
                        at(i, `${a.name} looks like a secret; give it no default, or ${TEST_VALUES[0]} if the build only needs it set`);
                    }
                }
                break;
            }
            case 'ADD': {
                if (/:\/\/|\bgit@/.test(rest)) at(i, 'downloads from a URL; an authored Dockerfile only copies files of the repository');
                else at(i, 'is refused; use COPY');
                break;
            }
            case 'COPY': {
                for (const f of flags) {
                    if (!COPY_FLAGS.has(f.name)) {
                        at(i, `flag ${f.name} is refused`);
                        continue;
                    }
                    if (f.name === '--from' && !isStage(stages, f.value ?? '')) {
                        const p = imageProblem(f.value ?? '');
                        if (p) at(i, `--from: ${p}`);
                    }
                }
                if (/:\/\//.test(rest)) at(i, 'names a URL; COPY only files of the repository');
                break;
            }
            case 'RUN': {
                for (const f of flags) {
                    if (f.name !== '--mount') {
                        at(i, `flag ${f.name} is refused; RUN takes only --mount=type=cache or type=bind`);
                        continue;
                    }
                    const opts = new Map<string, string>();
                    for (const kv of (f.value ?? '').split(',')) {
                        const [k, ...v] = kv.split('=');
                        opts.set(k.trim().toLowerCase(), v.join('='));
                    }
                    const type = opts.get('type') ?? 'bind';
                    if (type !== 'cache' && type !== 'bind') at(i, `--mount type=${type} is refused; only type=cache or type=bind (no secret or ssh mounts)`);
                    for (const k of opts.keys()) if (!MOUNT_KEYS.has(k)) at(i, `--mount option ${k} is refused`);
                    const from = opts.get('from');
                    if (from && !isStage(stages, from)) {
                        const p = imageProblem(from);
                        if (p) at(i, `--mount from: ${p}`);
                    }
                    if (!opts.get('target') && !opts.get('dst') && !opts.get('destination')) at(i, '--mount needs a target');
                }
                if (REMOTE_SCRIPT.some((r) => r.test(rest))) {
                    at(i, 'runs a script it downloads; install with the package manager of the image or the project instead');
                } else if (DOWNLOAD.test(rest) && /:\/\/[^\s]*\.(sh|bash|py|pl|rb)\b/.test(rest)) {
                    at(i, 'downloads a script; install with the package manager of the image or the project instead');
                }
                break;
            }
            default:
                break;
        }
    }
    if (froms === 0) errors.push(`${path} has no FROM`);
    return errors;
}

// --- Node builds ------------------------------------------------------------------------------
//
// Rules on how an authored Dockerfile builds a Node project, not on what it may do: each one is a
// build that measured slow or broke on the cell (cal.com copied apps/ and packages/ before `yarn
// install`: a 17-minute install and a 21-minute image export on every source change; next.js let
// corepack pick pnpm 11, which stopped on ERR_PNPM_IGNORED_BUILDS). They read the manifests at the
// Dockerfile's build context and stay silent wherever those do not say enough to name the fix.

/** What the Node build rules read from the manifests at a Dockerfile's build context. */
export interface NodeBuildFacts {
    /** Where the workspace members are: package.json workspaces, pnpm-workspace.yaml or lerna.json packages (negations dropped). */
    workspaceGlobs: string[];
    /** Workspaces, or a Lerna, Nx or Turborepo config: the install reads more than the root manifest. */
    monorepo: boolean;
    /** package.json packageManager, its hash dropped. */
    packageManager?: { name: string; version: string };
    /** The root lockfile's name. */
    lockfile?: string;
    /** lockfileVersion of pnpm-lock.yaml (`9.0`). */
    pnpmLockfileVersion?: string;
    /** The package manager's own files the install reads, as far as the manifests tell (.npmrc, .yarnrc.yml, .yarn/releases, patches). */
    installFiles: string[];
    /** nx.json is there. */
    nx: boolean;
    /** The root package.json scripts, for a RUN that calls one. */
    scripts: Record<string, string>;
}

const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'];
const INSTALL_FILE_NAMES = ['pnpm-workspace.yaml', '.npmrc', '.yarnrc.yml', '.yarnrc', '.pnpmfile.cjs'];
/** What only an install reads: a COPY of one of these (by name, or turbo prune's out/json) never brings source. */
const MANIFEST_NAMES = new Set(['package.json', ...LOCKFILE_NAMES, ...INSTALL_FILE_NAMES]);
const WORKSPACE_GLOB = /^[\w@.*{},/-]{1,80}$/;
/** The pnpm major that writes each lockfileVersion (9.0 is also pnpm 10's, which skips unlisted build scripts). */
const PNPM_FOR_LOCKFILE: Record<string, number> = { '9.0': 9, '6.0': 8, '6.1': 8, '5.4': 7, '5.3': 6 };

/**
 * The facts of the build context `context` (repository-relative, `.` for the
 * root), or null when it has no package.json (not a Node build: no rule applies).
 */
export async function nodeBuildFacts(read: (path: string) => Promise<string | null>, context: string): Promise<NodeBuildFacts | null> {
    const at = (f: string) => (context === '.' || context === '' ? f : posix.join(context, f));
    // Advisory rules for the model (checkNodeBuild): an unreadable file skips them, and the boot still proves the build.
    const text = (f: string) => read(at(f)).catch(() => null);
    const json = async (f: string): Promise<Record<string, any> | null> => {
        const t = await text(f);
        if (t === null) return null;
        try {
            const v = JSON.parse(t);
            return isMap(v) ? v : null;
        } catch {
            // A package.json that does not parse is not a Node build these rules can read.
            return null;
        }
    };
    const pkg = await json('package.json');
    if (!pkg) return null;
    const plain = (list: unknown): string[] =>
        (Array.isArray(list) ? list : []).filter((g): g is string => typeof g === 'string' && !g.startsWith('!') && WORKSPACE_GLOB.test(g)).map((g) => g.replace(/^\.\//, '').replace(/\/+$/, ''));
    let globs = plain(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages);
    const installFiles: string[] = [];
    let pnpmWorkspace: Record<string, unknown> | null = null;
    for (const f of INSTALL_FILE_NAMES) {
        const t = await text(f);
        if (t === null) continue;
        installFiles.push(f);
        if (f === 'pnpm-workspace.yaml') {
            try {
                const doc = yaml.load(t, UNTRUSTED_YAML);
                pnpmWorkspace = isMap(doc) ? doc : null;
            } catch {
                // Unparseable: no pnpm globs, the package.json ones stand.
                pnpmWorkspace = null;
            }
            const pnpmGlobs = plain(pnpmWorkspace?.packages);
            if (pnpmGlobs.length) globs = pnpmGlobs;
        }
        if (f === '.yarnrc.yml') {
            const yarnPath = /^yarnPath:\s*["']?([^"'\s#]+)/m.exec(t)?.[1];
            const dir = yarnPath ? posix.dirname(posix.normalize(yarnPath)) : '';
            if (dir && dir !== '.' && !dir.startsWith('..') && WORKSPACE_GLOB.test(dir)) installFiles.push(dir);
        }
    }
    const lerna = await json('lerna.json');
    if (lerna && !globs.length) globs = plain(lerna.packages ?? ['packages/*']);
    const nx = (await text('nx.json')) !== null;
    const turbo = (await text('turbo.json')) !== null;
    // Patches the install applies (pnpm patchedDependencies, in package.json or pnpm-workspace.yaml): their directory.
    const patched = { ...(isMap(pkg.pnpm?.patchedDependencies) ? pkg.pnpm.patchedDependencies : {}), ...(isMap(pnpmWorkspace?.patchedDependencies) ? pnpmWorkspace.patchedDependencies : {}) };
    for (const p of Object.values(patched)) {
        const dir = typeof p === 'string' ? posix.normalize(p).split('/')[0] : '';
        if (dir && dir !== '.' && dir !== '..' && WORKSPACE_GLOB.test(dir) && !installFiles.includes(dir)) installFiles.push(dir);
    }
    let lockfile: string | undefined;
    let pnpmLockfileVersion: string | undefined;
    for (const f of LOCKFILE_NAMES) {
        const t = await text(f);
        if (t === null) continue;
        lockfile = f;
        if (f === 'pnpm-lock.yaml') pnpmLockfileVersion = /^lockfileVersion:\s*["']?([\d.]+)/m.exec(t)?.[1];
        break;
    }
    const pm = typeof pkg.packageManager === 'string' ? /^([a-z]+)@([\w.-]+)/.exec(pkg.packageManager.trim()) : null;
    const scripts = isMap(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
    return {
        workspaceGlobs: globs,
        monorepo: globs.length > 0 || !!lerna || nx || turbo,
        ...(pm ? { packageManager: { name: pm[1], version: pm[2] } } : {}),
        ...(lockfile ? { lockfile } : {}),
        ...(pnpmLockfileVersion ? { pnpmLockfileVersion } : {}),
        installFiles,
        nx,
        scripts,
    };
}

/** One command of a RUN: its words (quotes dropped), the tool first, and the variables set for it. */
interface Command {
    words: string[];
    env: Map<string, string>;
}

const PREFIX_WORDS = new Set(['env', 'sudo', 'exec', 'time', 'nohup', 'cross-env']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** The commands of a RUN's shell text, split at && || ; | and newlines; `export X=1` carries to the commands after it. */
function commandsOf(text: string): Command[] {
    const out: Command[] = [];
    const exported = new Map<string, string>();
    for (const seg of text.replace(/["'`()]/g, ' ').split(/&&|\|\||[;|\n]/)) {
        let words = seg.trim().split(/\s+/).filter(Boolean);
        const env = new Map(exported);
        // Strip what only sets up the command: VAR=value, env/sudo/cross-env, `sh -c`, and `corepack pnpm` (pnpm runs).
        while (words.length) {
            const w = words[0];
            const assign = ASSIGNMENT.exec(w);
            if (assign) env.set(assign[1], assign[2]);
            else if (w === 'export') {
                for (const a of words.slice(1).map((x) => ASSIGNMENT.exec(x))) if (a) exported.set(a[1], a[2]);
                words = [];
                break;
            } else if (/^(?:\/\S*\/)?(?:sh|bash|dash|ash)$/.test(w) && /^-\w*c\w*$/.test(words[1] ?? '')) words = words.slice(1);
            else if (!PREFIX_WORDS.has(w) && !(w === 'corepack' && /^(pnpm|yarn|npm|npx)$/.test(words[1] ?? ''))) break;
            words = words.slice(1);
        }
        if (words.length) out.push({ words: [posix.basename(words[0]), ...words.slice(1)], env });
    }
    return out;
}

/** Flags that take the next word as their value. */
const VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--cwd', '-w', '--workspace', '--workspace-dir', '--config', '--registry', '--store-dir', '--loglevel', '--network-timeout', '--mode']);
/** Flags that run a command in a package rather than the root. */
const SCOPED_FLAGS = /^(--filter|-F|-C|--dir|--prefix|--cwd|-w|--workspace)(=|$)/;

/** The non-flag words after the tool, in order. */
function operands(words: string[]): string[] {
    const out: string[] = [];
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (w.startsWith('-')) {
            if (VALUE_FLAGS.has(w)) i++;
            continue;
        }
        out.push(w);
    }
    return out;
}

const isGlobal = (words: string[]) => words.includes('-g') || words.includes('--global');

/** What a command does to the project's dependencies: an install, a pnpm fetch, or nothing. */
function installKind(c: Command): 'install' | 'fetch' | null {
    const [tool] = c.words;
    const [sub, next] = operands(c.words);
    if (isGlobal(c.words)) return null;
    if (tool === 'npm') return sub === 'ci' || sub === 'install' || sub === 'i' || sub === 'add' ? 'install' : null;
    if (tool === 'pnpm') return sub === 'install' || sub === 'i' ? 'install' : sub === 'fetch' ? 'fetch' : null;
    if (tool === 'yarn') return sub === undefined || sub === 'install' || (sub === 'workspaces' && next === 'focus') ? 'install' : null;
    if (tool === 'bun') return sub === 'install' || sub === 'i' ? 'install' : null;
    return null;
}

/** The package managers a command installs or activates, as written (`pnpm`, `pnpm@9.15.0`, `yarn@latest`). */
function activations(c: Command): { kind: 'corepack' | 'global'; specs: string[] } | null {
    const [tool] = c.words;
    const ops = operands(c.words);
    const pms = (list: string[]) => list.filter((w) => /^(pnpm|yarn)(@\S*)?$/.test(w));
    if (tool === 'corepack' && ['prepare', 'install', 'use'].includes(ops[0] ?? '')) return { kind: 'corepack', specs: pms(ops.slice(1)) };
    if ((tool === 'npm' && ['install', 'i', 'add'].includes(ops[0] ?? '')) || (tool === 'pnpm' && ops[0] === 'add') || (tool === 'yarn' && ops[0] === 'global')) {
        return isGlobal(c.words) || tool === 'yarn' ? { kind: 'global', specs: pms(ops.slice(tool === 'yarn' ? 2 : 1)) } : null;
    }
    if (tool === 'npx' || tool === 'pnpx' || tool === 'bunx') return /^(pnpm|yarn)(@|$)/.test(ops[0] ?? '') ? { kind: 'global', specs: [ops[0]] } : null;
    return null;
}

const DIST_TAG = /^(latest|next|stable|canary|rc|beta|nightly|\*)$/;
/** The version a spec pins, or null for none or a dist tag. */
function pinnedVersion(spec: string): string | null {
    const at = spec.indexOf('@');
    const v = at < 0 ? '' : spec.slice(at + 1);
    return !v || DIST_TAG.test(v) ? null : v;
}
const majorOf = (v: string) => Number(/^[\^~>=v\s]*(\d+)/.exec(v)?.[1] ?? NaN);

/** The release of `pm` the project names, and where it says so; null when nothing does (the rule then stays silent). */
function pinFor(pm: string, facts: NodeBuildFacts): { spec: string; why: string } | null {
    if (facts.packageManager?.name === pm) return { spec: `${pm}@${facts.packageManager.version}`, why: 'what package.json packageManager names' };
    if (pm === 'pnpm' && !facts.packageManager && facts.pnpmLockfileVersion && PNPM_FOR_LOCKFILE[facts.pnpmLockfileVersion]) {
        return { spec: `pnpm@${PNPM_FOR_LOCKFILE[facts.pnpmLockfileVersion]}`, why: `the major that writes pnpm-lock.yaml lockfileVersion ${facts.pnpmLockfileVersion}` };
    }
    return null;
}

/** pnpm 11 stops on a pnpm 9.0 lockfile's unlisted build scripts unless the project itself moved to pnpm 11. */
const pnpm11Breaks = (facts: NodeBuildFacts) =>
    !!facts.pnpmLockfileVersion?.startsWith('9') && !(facts.packageManager?.name === 'pnpm' && majorOf(facts.packageManager.version) >= 11);
const PNPM11_WHY = 'pnpm 11 stops the install on dependency build scripts pnpm-workspace.yaml does not allow (ERR_PNPM_IGNORED_BUILDS) and needs Node 22.13 or later';

/** One path segment of a glob as a regular expression. */
const segmentRegex = (s: string) => new RegExp(`^${s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, a: string) => `(?:${a.split(',').join('|')})`).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
const hasWildcard = (s: string) => /[*?{[]/.test(s);
function segmentsMatch(source: string, glob: string): boolean {
    if (hasWildcard(source) && hasWildcard(glob)) return true;
    if (hasWildcard(glob)) return segmentRegex(glob).test(source);
    if (hasWildcard(source)) return segmentRegex(source).test(glob);
    return source === glob;
}

/**
 * Whether a COPY source from the build context brings whole workspace
 * members, not only manifests: the context itself (`.`, `*`), a directory
 * that holds members (`apps`, `packages`), or a member (`packages/ui`, `apps/*`).
 * A path inside a member (packages/db/prisma) or a file (apps/*\/package.json)
 * does not. A `**` glob at the top (every directory a member) says nothing about
 * where they are: then only the context itself counts.
 */
export function copiesWorkspaceSource(source: string, globs: readonly string[]): boolean {
    const s = posix.normalize(source.replace(/^\/+/, '')).replace(/\/+$/, '');
    if (s === '.' || s === '' || s === '*' || s === '**') return true;
    const parts = s.split('/');
    if (MANIFEST_NAMES.has(parts[parts.length - 1])) return false;
    for (const g of globs) {
        const gs = g.split('/');
        const deep = gs.indexOf('**');
        if (deep === 0) continue;
        const depth = deep > 0 ? deep + 1 : gs.length;
        if (parts.length > depth) continue;
        if (parts.every((p, i) => (deep >= 0 && i >= deep) || segmentsMatch(p, gs[i]))) return true;
    }
    return false;
}

/** A COPY --from source that holds only manifests: a manifest by name, or turbo prune --docker's out/json. */
function manifestShaped(source: string): boolean {
    const parts = posix.normalize(source).replace(/\/+$/, '').split('/');
    if (MANIFEST_NAMES.has(parts[parts.length - 1])) return true;
    return parts.some((p, i) => p === 'json' && parts[i - 1] === 'out');
}

/** How a Dockerfile's dependency install meets the source: each install, and the COPY of source before it when nothing installed before that COPY. */
export interface InstallLayer {
    line: number;
    /** The COPY that brought source before this install, when no install or pnpm fetch had run on manifests alone before it. */
    afterSource?: { line: number; source: string };
}

interface StageState {
    source?: { line: number; source: string };
    /** An install or pnpm fetch ran on manifests alone: later installs only relink. */
    prepared: boolean;
    env: Map<string, string>;
}

/** The sources of a COPY, JSON or shell form, its destination dropped. */
function copySources(rest: string): string[] {
    const trimmed = rest.trim();
    if (trimmed.startsWith('[')) {
        try {
            const v = JSON.parse(trimmed) as unknown;
            if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').slice(0, -1);
        } catch {
            /* the shell form below */
        }
    }
    return trimmed.split(/\s+/).filter(Boolean).slice(0, -1);
}

/** Walks the stages of a Dockerfile (a FROM of an earlier stage starts from its state): each one's state when an instruction runs. */
function walkStages(content: string, globs: readonly string[], visit: (i: Instruction, stage: StageState) => void): void {
    const stages = new Map<string, StageState>();
    const byIndex: StageState[] = [];
    let stage: StageState = { prepared: false, env: new Map() };
    for (const i of instructionsOf(content)) {
        const { flags, rest } = flagsOf(i.args);
        if (i.keyword === 'FROM') {
            const m = /^(\S+)(?:\s+AS\s+(\S+))?/i.exec(rest);
            const base = m ? stages.get(m[1].toLowerCase()) : undefined;
            stage = base ? { ...(base.source ? { source: base.source } : {}), prepared: base.prepared, env: new Map(base.env) } : { prepared: false, env: new Map() };
            byIndex.push(stage);
            if (m?.[2]) stages.set(m[2].toLowerCase(), stage);
            continue;
        }
        if (i.keyword === 'ENV' || i.keyword === 'ARG') {
            for (const a of assignmentsOf(rest, i.keyword === 'ENV')) if (a.hasValue) stage.env.set(a.name, a.value);
        }
        if (i.keyword === 'COPY' || i.keyword === 'ADD') {
            const fromFlag = flags.find((f) => f.name === '--from')?.value;
            const from = fromFlag === undefined ? undefined : /^\d+$/.test(fromFlag) ? byIndex[Number(fromFlag)] : stages.get(fromFlag.toLowerCase());
            for (const s of copySources(rest)) {
                if (fromFlag !== undefined) {
                    // From an image: tools or binaries, never this repository's source.
                    if (!from) continue;
                    if (s.split('/').includes('node_modules')) stage.prepared = true;
                    else if (from.source && !manifestShaped(s)) stage.source ??= { line: i.line, source: `${s} from stage ${fromFlag}` };
                    else if (from.prepared) stage.prepared = true;
                } else if (!stage.source && copiesWorkspaceSource(s, globs)) stage.source = { line: i.line, source: s };
            }
        }
        visit(i, stage);
    }
}

/** Each dependency install of a Dockerfile and whether source came before it (the eval's "cache-friendly install"). */
export function installLayersOf(content: string, facts: Pick<NodeBuildFacts, 'workspaceGlobs'>): InstallLayer[] {
    const out: InstallLayer[] = [];
    walkStages(content, facts.workspaceGlobs, (i, stage) => {
        if (i.keyword !== 'RUN') return;
        for (const c of commandsOf(flagsOf(i.args).rest)) {
            const kind = installKind(c);
            if (!kind) continue;
            if (kind === 'install') out.push({ line: i.line, ...(stage.source && !stage.prepared ? { afterSource: stage.source } : {}) });
            if (!stage.source) stage.prepared = true;
        }
    });
    return out;
}

/** The COPY --parents line that takes only what the install reads, from the facts. */
function manifestCopyLine(facts: NodeBuildFacts): string {
    const files = ['package.json', ...(facts.lockfile ? [facts.lockfile] : []), ...facts.installFiles, ...facts.workspaceGlobs.slice(0, 12).map((g) => `${g}/package.json`)];
    return `COPY --parents ${files.join(' ')} ./`;
}

/** A RUN that runs Nx, directly or through a root script: what it runs, or null. */
function nxCall(c: Command, scripts: Record<string, string>): string | null {
    const [tool] = c.words;
    const ops = operands(c.words);
    if (tool === 'nx') return c.words.join(' ');
    if ((tool === 'npx' || tool === 'pnpx' || tool === 'bunx') && /^nx(@|$)/.test(ops[0] ?? '')) return c.words.join(' ');
    if (tool !== 'pnpm' && tool !== 'yarn' && tool !== 'npm' && tool !== 'bun') return null;
    if (ops[0] === 'nx' || (ops[0] === 'exec' && ops[1] === 'nx')) return c.words.join(' ');
    if (c.words.some((w) => SCOPED_FLAGS.test(w)) || ops[0] === 'workspace') return null;
    const script = ops[0] === 'run' || ops[0] === 'run-script' ? ops[1] : tool === 'npm' ? undefined : ops[0];
    const text = script ? scripts[script] : undefined;
    return text && /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?nx\s+[\w@:.-]/.test(text) ? `${c.words.join(' ')} (the script runs ${text.slice(0, 80)})` : null;
}

const truthy = (v: string | undefined) => v === 'true' || v === '1';

/** The segments of a path in a stage's filesystem, resolved against `cwd` (COPY --from resolves against the stage root). */
const stageSegments = (p: string, cwd = '/') => posix.normalize(posix.isAbsolute(p) ? p : posix.join(cwd, p)).split('/').filter(Boolean);
const INSTALL_DIR_FLAG = /^(--prefix|-C|--dir|--cwd)(?:=(.+))?$/;

/**
 * Each COPY --from of an earlier stage that brings a dependency tree: a source
 * that is or holds a node_modules directory, or that holds where that stage (or
 * one it is built on) installed the project's dependencies, a workspace
 * member's node_modules included. A COPY from an image (a tool or a binary)
 * and build output (dist, .next, build) beside node_modules do not count.
 */
function dependencyTreeCopies(content: string, globs: readonly string[]): Array<{ line: number; from: string; source: string }> {
    interface Stage {
        workdir: string[];
        /** The node_modules directories an install created, as segment globs. */
        trees: string[][];
    }
    const named = new Map<string, Stage>();
    const byIndex: Stage[] = [];
    let stage: Stage = { workdir: [], trees: [] };
    const out: Array<{ line: number; from: string; source: string }> = [];
    for (const i of instructionsOf(content)) {
        const { flags, rest } = flagsOf(i.args);
        if (i.keyword === 'FROM') {
            const m = /^(\S+)(?:\s+AS\s+(\S+))?/i.exec(rest);
            const base = m ? named.get(m[1].toLowerCase()) : undefined;
            stage = base ? { workdir: [...base.workdir], trees: [...base.trees] } : { workdir: [], trees: [] };
            byIndex.push(stage);
            if (m?.[2]) named.set(m[2].toLowerCase(), stage);
        } else if (i.keyword === 'WORKDIR') {
            stage.workdir = stageSegments(rest.trim(), `/${stage.workdir.join('/')}`);
        } else if (i.keyword === 'RUN') {
            let cwd = `/${stage.workdir.join('/')}`;
            for (const c of commandsOf(rest)) {
                if (c.words[0] === 'cd' && c.words[1]) cwd = `/${stageSegments(c.words[1], cwd).join('/')}`;
                if (installKind(c) !== 'install') continue;
                const flag = c.words.map((w, n) => [INSTALL_DIR_FLAG.exec(w), n] as const).find(([f]) => f);
                const dir = flag ? stageSegments(flag[0]![2] ?? c.words[flag[1] + 1] ?? '.', cwd) : stageSegments(cwd);
                stage.trees.push([...dir, 'node_modules'], ...globs.map((g) => [...dir, ...g.split('/'), 'node_modules']));
            }
        } else if (i.keyword === 'COPY') {
            const fromFlag = flags.find((f) => f.name === '--from')?.value;
            if (fromFlag === undefined) continue;
            const from = /^\d+$/.test(fromFlag) ? byIndex[Number(fromFlag)] : named.get(fromFlag.toLowerCase());
            if (!from) continue;
            const source = copySources(rest).find((s) => {
                const parts = stageSegments(s);
                return parts.includes('node_modules') || from.trees.some((t) => parts.length <= t.length && parts.every((p, n) => segmentsMatch(p, t[n])));
            });
            if (source !== undefined) out.push({ line: i.line, from: fromFlag, source });
        }
    }
    return out;
}

/**
 * Each Node build rule an authored Dockerfile breaks, given the facts of its
 * build context (nodeBuildFacts), in words the model can act on.
 */
export function checkNodeBuild(path: string, content: string, facts: NodeBuildFacts): string[] {
    const errors: string[] = [];

    // Dependencies before source in a monorepo: an install after a COPY of the members installs again on every change.
    if (facts.monorepo) {
        const late = installLayersOf(content, facts).find((l) => l.afterSource);
        if (late?.afterSource) {
            errors.push(
                `${path}:${late.line} RUN installs dependencies after line ${late.afterSource.line} copied ${late.afterSource.source}, so every change to the code installs again (a large monorepo's install and its image layer take more than half an hour on the cell). Before the install copy only what it reads, each file at its path (${manifestCopyLine(facts)}), install, and only then COPY . . for the source. Or prune first: a stage that runs turbo prune <app> --docker, then COPY --from that stage out/json/ and the pruned lockfile, install, then out/full/. Or with pnpm: pnpm fetch on the lockfile, then COPY . . and pnpm install --offline.`,
            );
        }
    }

    const instructions = instructionsOf(content);
    const runs = instructions.filter((i) => i.keyword === 'RUN').map((i) => ({ i, commands: commandsOf(flagsOf(i.args).rest) }));
    const envSet = (name: string, value: (v: string) => boolean) =>
        instructions.some((i) => (i.keyword === 'ENV' || i.keyword === 'ARG') && assignmentsOf(flagsOf(i.args).rest, i.keyword === 'ENV').some((a) => a.name === name && value(a.value))) ||
        runs.some((r) => r.commands.some((c) => value(c.env.get(name) ?? '\0')));

    // The package manager's release: pinned, and not one that breaks the lockfile.
    let pinnedPnpm = false;
    let barePrepare = false;
    for (const { i, commands } of runs) {
        for (const c of commands) {
            const act = activations(c);
            if (!act) continue;
            if (act.kind === 'corepack' && !act.specs.length) barePrepare = true;
            for (const spec of act.specs) {
                const pm = spec.split('@')[0];
                const version = pinnedVersion(spec);
                const pin = pinFor(pm, facts);
                const verb = c.words.join(' ').slice(0, 120);
                const fix = pin && (act.kind === 'corepack' ? `corepack prepare ${pin.spec} --activate` : `npm install -g ${pin.spec}`);
                if (!version) {
                    if (pin) {
                        const breaks = pm === 'pnpm' && pnpm11Breaks(facts) ? `, and ${PNPM11_WHY}` : '';
                        errors.push(`${path}:${i.line} RUN ${verb} names no version, so it takes the latest release${breaks}; write ${fix} (${pin.why}).`);
                    }
                    continue;
                }
                if (pm === 'pnpm') pinnedPnpm = true;
                if (pm === 'pnpm' && majorOf(version) >= 11 && pnpm11Breaks(facts)) {
                    const to = fix ? `write ${fix} instead (${pin!.why})` : 'pin pnpm 9 or 10 instead';
                    errors.push(`${path}:${i.line} RUN installs pnpm ${version}, but this lockfile (lockfileVersion ${facts.pnpmLockfileVersion}) is not pnpm 11's: ${PNPM11_WHY}; ${to}.`);
                }
            }
        }
    }
    const usesPnpm = facts.packageManager ? facts.packageManager.name === 'pnpm' : !!facts.pnpmLockfileVersion;
    const pnpmPin = pinFor('pnpm', facts);
    if (usesPnpm && pnpmPin && !pinnedPnpm && !(barePrepare && facts.packageManager) && !envSet('COREPACK_DEFAULT_TO_LATEST', (v) => v === '0' || v === 'false')) {
        const enable = runs.find((r) => r.commands.some((c) => c.words[0] === 'corepack' && operands(c.words)[0] === 'enable'));
        if (enable) {
            errors.push(
                `${path}:${enable.i.line} RUN corepack enable pins no pnpm release: wherever no package.json naming one is in the working directory, corepack downloads the latest${pnpm11Breaks(facts) ? `, and ${PNPM11_WHY}` : ''}. Add corepack prepare ${pnpmPin.spec} --activate after it (${pnpmPin.why}), or ENV COREPACK_DEFAULT_TO_LATEST=0 before it.`,
            );
        }
    }

    // Nx: Nx Cloud is not reachable from the build.
    if (facts.nx) {
        walkStages(content, facts.workspaceGlobs, (i, stage) => {
            if (i.keyword !== 'RUN' || errors.some((e) => e.includes('without NX_NO_CLOUD'))) return;
            for (const c of commandsOf(flagsOf(i.args).rest)) {
                const nx = nxCall(c, facts.scripts);
                if (!nx || truthy(c.env.get('NX_NO_CLOUD')) || truthy(stage.env.get('NX_NO_CLOUD'))) continue;
                errors.push(
                    `${path}:${i.line} RUN runs Nx (${nx.slice(0, 160)}) without NX_NO_CLOUD=true, so Nx tries Nx Cloud, which the build cannot reach; add ENV NX_NO_CLOUD=true NX_DISABLE_REMOTE_CACHE=true NX_DAEMON=false in this stage before it.`,
                );
                return;
            }
        });
    }

    // No dependency tree copied between stages: under gVisor that copy is a per-file cost (twenty's COPY of /app/node_modules took 439 s).
    for (const c of dependencyTreeCopies(content, facts.workspaceGlobs)) {
        errors.push(
            `${path}:${c.line} COPY --from=${c.from} ${c.source} copies installed dependencies (node_modules) from one stage to another, which takes minutes on the cell. Run the app from the stage that installed them: a test environment needs one build stage. Only if a smaller final image is truly needed, make it inside that stage with the package manager's own command (pnpm deploy --filter <app>, yarn workspaces focus --production <app>, turbo prune <app>) instead of copying node_modules across stages.`,
        );
    }
    return errors;
}

// --- Compose ----------------------------------------------------------------------------------

/** Keys of a service an authored compose file may set; the cell's allowlist (sandbox.go serviceKeys) less what Kody needs not, plus build. */
const SERVICE_KEYS = new Set([
    'image',
    'build',
    'command',
    'entrypoint',
    'environment',
    'ports',
    'expose',
    'depends_on',
    'healthcheck',
    'volumes',
    'working_dir',
    'user',
    'restart',
    'tmpfs',
    'init',
    'stop_signal',
    'stop_grace_period',
    'deploy',
    'mem_limit',
    'cpus',
    'hostname',
    'profiles',
    'cap_drop',
    'read_only',
    'shm_size',
    'pull_policy',
]);
/** Why the cell refuses these (sandbox.go refusedKeys), in the words the model gets back. */
const REFUSED_SERVICE_KEYS: Record<string, string> = {
    privileged: 'privileged containers reach the host',
    cap_add: 'added capabilities reach the host',
    devices: 'host devices',
    device_cgroup_rules: 'host devices',
    network_mode: "host or another container's network",
    pid: "host or another container's pid namespace",
    ipc: "host or another container's ipc namespace",
    uts: 'host uts namespace',
    userns_mode: 'host user namespace',
    cgroup_parent: 'host cgroup',
    cgroup: 'host cgroup',
    runtime: 'the cell chooses the runtime',
    security_opt: 'the cell sets the security options',
    sysctls: 'kernel parameters',
    volumes_from: "another container's mounts",
    extra_hosts: 'name resolution goes through the cell resolver',
    dns: 'name resolution goes through the cell resolver',
    dns_search: 'name resolution goes through the cell resolver',
    dns_opt: 'name resolution goes through the cell resolver',
    container_name: 'names are per claim project',
    group_add: 'host groups',
    isolation: 'the cell chooses the isolation',
    external_links: 'containers outside the project',
    links: 'use depends_on and the project network',
    configs: 'files outside the project',
    secrets: 'secrets come from the cell injector, not the compose file',
    env_file: 'env files hold secrets; set each variable in environment with a test value',
    extends: 'files outside the one checked',
    networks: 'the cell gives the project its network',
    labels: 'the cell sets the labels',
    oom_kill_disable: 'host memory protection',
    oom_score_adj: 'host memory protection',
    mac_address: 'network identity',
    storage_opt: 'host storage driver',
};
const TOP_KEYS = new Set(['services', 'volumes']);
/**
 * Keys whose text the container's shell reads. Compose interpolates a `$`
 * there too, from the cell's environment, before the shell sees it: the
 * container's shell gets a `$` only as `$$`.
 */
const SHELL_KEYS = new Set(['command', 'entrypoint', 'healthcheck']);
const BUILD_KEYS = new Set(['context', 'dockerfile', 'target', 'args']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A path of the compose file, relative to the repository root (the cell's project directory), normalized; null when it leaves the root. */
function insideRoot(p: string): string | null {
    if (!p || p.startsWith('/') || /[$~\\]/.test(p) || p.includes('docker.sock') || p.includes('://')) return null;
    const n = posix.normalize(p).replace(/\/+$/, '');
    if (n === '..' || n.startsWith('../')) return null;
    return n === '' ? '.' : n;
}

/**
 * The repositories of a multi-repository environment, as a compose file Kody
 * writes may name them: `../<alias>` is that repository's directory beside the
 * primary's (the cell's ws/<alias>), the only place outside the primary a
 * build context or a bind may point at.
 */
export interface ComposeWorkspace {
    /** The primary's alias: `../<it>/x` is the primary's x. */
    primary: string;
    /** Every other repository of the environment. */
    members: ReadonlySet<string>;
    /** Filled with each member a compose file builds or binds. */
    used: Set<string>;
}

const aliasList = (ws: ComposeWorkspace) => [...ws.members].map((a) => `../${a}`).join(', ');

/**
 * A compose path, normalized: the primary's as insideRoot has it, or, in a
 * workspace, `../<alias>/…` of a member (recorded in `used`). Null where
 * insideRoot refuses it and there is no workspace (the single-repository
 * message stands); `{ error }` names what a workspace path got wrong.
 */
function composePath(p: string, ws: ComposeWorkspace | undefined): string | null | { error: string } {
    const inside = insideRoot(p);
    if (inside || !ws) return inside;
    if (!p || p.startsWith('/') || /[$~\\]/.test(p) || p.includes('docker.sock') || p.includes('://')) return null;
    const n = posix.normalize(p).replace(/\/+$/, '');
    const rest = n.slice(3);
    const where = `name a path of this repository or ../<alias> of another repository of this environment (${aliasList(ws)})`;
    if (!rest) return { error: `${p} is the workspace itself, not a repository; ${where}` };
    const slash = rest.indexOf('/');
    const alias = slash === -1 ? rest : rest.slice(0, slash);
    if (alias === '..') return { error: `${p} leaves the workspace; ${where}` };
    if (alias === ws.primary) return insideRoot(slash === -1 ? '.' : rest.slice(slash + 1));
    if (!ws.members.has(alias)) return { error: `${p}: ../${alias} is not a repository of this environment; ${where}` };
    ws.used.add(alias);
    return n;
}

/** composePath as a string or null, its error (if any) pushed with `at`. */
function placed(p: string, ws: ComposeWorkspace | undefined, errors: string[], at: string): string | null | undefined {
    const r = composePath(p, ws);
    if (typeof r === 'string') return r;
    if (r) {
        errors.push(`${at}: ${r.error}`);
        return undefined;
    }
    return null;
}

/** A `$` compose would interpolate (not `$$`). */
const interpolates = (s: string) => /(^|[^$])\$(?!\$)/.test(s.replace(/\$\$/g, ''));

function walkStrings(v: unknown, path: string, visit: (s: string, path: string) => void) {
    if (typeof v === 'string') visit(v, path);
    else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, visit));
    else if (isMap(v)) for (const [k, x] of Object.entries(v)) walkStrings(x, `${path}.${k}`, visit);
}

export interface ComposeContext {
    /** Paths of the files Kody submits with this compose file. */
    authored: ReadonlySet<string>;
    /** Whether a repository file is there at the commit. */
    exists: (path: string) => Promise<boolean>;
    /** Filled with each authored Dockerfile's build context, for the COPY source check. */
    buildContexts?: Map<string, string>;
    /** Set when a service takes the repository's code without a Dockerfile of Kody's: a Dockerfile of the repository, or a bind of one of its paths. */
    repositoryCode?: { used: boolean };
    /** A multi-repository environment: build contexts and binds may also name `../<alias>` of a member (its code counts as repository code). */
    workspace?: ComposeWorkspace;
}

/** Each rule an authored compose file breaks, and the Dockerfiles its builds name. */
export async function checkAuthoredCompose(path: string, content: string, ctx: ComposeContext): Promise<{ errors: string[]; dockerfiles: string[] }> {
    const errors: string[] = [];
    const dockerfiles: string[] = [];
    let doc: unknown;
    try {
        doc = yaml.load(content, UNTRUSTED_YAML);
    } catch (e) {
        return { errors: [`${path} is not YAML: ${String((e as Error).message).split('\n')[0].slice(0, 200)}`], dockerfiles };
    }
    if (!isMap(doc) || !isMap(doc.services)) return { errors: [`${path} has no services mapping`], dockerfiles };
    for (const k of Object.keys(doc)) {
        if (!TOP_KEYS.has(k) && !k.startsWith('x-')) errors.push(`${path} ${k}: Kody writes only services, volumes and x- anchors at the top`);
    }
    const declared = new Set<string>();
    if (doc.volumes !== undefined && doc.volumes !== null) {
        if (!isMap(doc.volumes)) errors.push(`${path} volumes: not a mapping`);
        else
            for (const [name, v] of Object.entries(doc.volumes)) {
                if (!NAME.test(name)) errors.push(`${path} volumes.${name}: not a plain name`);
                if (v !== null && !(isMap(v) && Object.keys(v).length === 0)) errors.push(`${path} volumes.${name}: a project volume takes no options (driver, external, name)`);
                declared.add(name);
            }
    }
    const services = doc.services;
    const hosts = new Set(Object.keys(services));
    for (const [name, raw] of Object.entries(services)) {
        const at = `${path} services.${name}`;
        if (!NAME.test(name)) errors.push(`${at}: not a plain service name`);
        if (!isMap(raw)) {
            errors.push(`${at}: not a mapping`);
            continue;
        }
        const svc = raw;
        for (const k of Object.keys(svc)) {
            if (REFUSED_SERVICE_KEYS[k]) errors.push(`${at}.${k}: refused (${REFUSED_SERVICE_KEYS[k]})`);
            else if (!SERVICE_KEYS.has(k) && k !== '<<') errors.push(`${at}.${k}: Kody does not write this key`);
            else {
                const fix = SHELL_KEYS.has(k) ? "write $$ for the container's shell to read a $" : 'write the value itself';
                walkStrings(svc[k], `${at}.${k}`, (s, p) => {
                    if (interpolates(s)) errors.push(`${p}: compose would interpolate the $; ${fix}`);
                });
            }
        }

        // Build: from the checkout only, with a Dockerfile Kody submits or the repository has.
        if (svc.build !== undefined) {
            const b = typeof svc.build === 'string' ? { context: svc.build } : svc.build;
            if (!isMap(b)) errors.push(`${at}.build: neither a path nor a mapping`);
            else {
                for (const k of Object.keys(b)) if (!BUILD_KEYS.has(k)) errors.push(`${at}.build.${k}: the cell builds from the checkout alone (context, dockerfile, target, args)`);
                const context = placed(String(b.context ?? '.'), ctx.workspace, errors, `${at}.build.context`);
                if (context === null) errors.push(`${at}.build.context: must be a directory of the repository, relative to its root`);
                const df = typeof b.dockerfile === 'string' ? b.dockerfile : 'Dockerfile';
                const resolved = context && !df.startsWith('/') ? composePath(posix.join(context, df), ctx.workspace) : null;
                const dockerfile = typeof resolved === 'string' ? resolved : null;
                if (context && !dockerfile) errors.push(`${at}.build.dockerfile: must be inside the build context`);
                if (context && dockerfile && !(dockerfile === context || dockerfile.startsWith(context === '.' ? '' : `${context}/`))) {
                    errors.push(`${at}.build.dockerfile: ${dockerfile} is outside the context ${context}; the cell refuses it`);
                } else if (dockerfile) {
                    if (ctx.authored.has(dockerfile)) {
                        dockerfiles.push(dockerfile);
                        ctx.buildContexts?.set(dockerfile, context);
                    }
                    else if (await ctx.exists(dockerfile)) {
                        if (ctx.repositoryCode) ctx.repositoryCode.used = true;
                    } else if (dockerfile.startsWith('../')) {
                        errors.push(`${at}.build.dockerfile: ${dockerfile} is not in ${dockerfile.split('/')[1]} at its commit`);
                    } else {
                        errors.push(`${at}.build.dockerfile: ${dockerfile} is neither in the repository nor among the files you submit (paths are relative to the repository root)`);
                    }
                }
                if (b.target !== undefined && (typeof b.target !== 'string' || !NAME.test(b.target))) errors.push(`${at}.build.target: not a plain stage name`);
                const args = isMap(b.args)
                    ? Object.entries(b.args).map(([k, v]) => [k, v === null ? '' : String(v)])
                    : Array.isArray(b.args)
                      ? b.args.map((s) => String(s).split(/=(.*)/s).slice(0, 2))
                      : [];
                for (const [k, v = ''] of args) {
                    if (secretVariable(k, v)) errors.push(`${at}.build.args.${k}: looks like a secret; use ${TEST_VALUES[0]}`);
                }
            }
        } else if (typeof svc.image === 'string') {
            const p = imageProblem(svc.image);
            if (p) errors.push(`${at}.image: ${p}`);
        } else {
            errors.push(`${at}: needs an image or a build`);
        }
        if (svc.pull_policy !== undefined && !['missing', 'if_not_present', 'never', 'build'].includes(String(svc.pull_policy))) {
            errors.push(`${at}.pull_policy: only missing, never or build`);
        }

        // Environment: no secret, URLs with credentials only to a service of this project with a test password.
        const env: Array<[string, string]> = isMap(svc.environment)
            ? Object.entries(svc.environment).map(([k, v]) => [k, v === null ? '' : String(v)])
            : Array.isArray(svc.environment)
              ? svc.environment.map((s) => String(s).split(/=(.*)/s).slice(0, 2) as [string, string])
              : [];
        for (const [k, v = ''] of env) {
            if (secretVariable(k, v)) errors.push(`${at}.environment.${k}: looks like a secret; use ${TEST_VALUES[0]}`);
        }

        // Volumes: anonymous, the project's own, tmpfs, or binds inside the repository.
        const vols = svc.volumes === undefined ? [] : Array.isArray(svc.volumes) ? svc.volumes : null;
        if (vols === null) errors.push(`${at}.volumes: not a list`);
        for (const [n, vol] of (vols ?? []).entries()) {
            const vp = `${at}.volumes[${n}]`;
            let type: string;
            let source: string | undefined;
            if (typeof vol === 'string') {
                const parts = vol.split(':');
                if (parts.length > 3) {
                    errors.push(`${vp}: unknown volume syntax`);
                    continue;
                }
                if (parts.length === 1) continue;
                for (const m of (parts[2] ?? '').split(',')) if (!['', 'ro', 'rw', 'nocopy'].includes(m)) errors.push(`${vp}: mount option ${m} is refused`);
                source = parts[0];
                // What the cell takes for a host path (sandbox.go isPath).
                type = /^[/.~]/.test(source) || /[/$]/.test(source) ? 'bind' : 'volume';
            } else if (isMap(vol)) {
                type = String(vol.type ?? '');
                source = typeof vol.source === 'string' ? vol.source : undefined;
                for (const k of Object.keys(vol)) if (!['type', 'source', 'target', 'read_only', 'tmpfs', 'volume'].includes(k)) errors.push(`${vp}.${k}: not in the mount allowlist`);
            } else {
                errors.push(`${vp}: unknown volume syntax`);
                continue;
            }
            if (type === 'bind') {
                const bound = source ? placed(source, ctx.workspace, errors, vp) : null;
                if (bound === null) errors.push(`${vp}: a bind outside the repository (${JSON.stringify(source ?? '')}); bind only paths of the repository, relative to its root`);
                else if (bound && ctx.repositoryCode && !`${bound}/`.startsWith(AUTHORED_FILES_DIR)) ctx.repositoryCode.used = true;
            } else if (type === 'volume') {
                if (source && !declared.has(source)) errors.push(`${vp}: volume ${JSON.stringify(source)} is not declared under volumes`);
            } else if (type !== 'tmpfs') errors.push(`${vp}.type: ${JSON.stringify(type)} is refused`);
        }

        if (isMap(svc.deploy)) {
            for (const k of Object.keys(svc.deploy)) if (k !== 'resources') errors.push(`${at}.deploy.${k}: only deploy.resources`);
            if (/device|generic_resources|capabilities/.test(JSON.stringify(svc.deploy))) errors.push(`${at}.deploy: host devices are refused`);
        } else if (svc.deploy !== undefined) errors.push(`${at}.deploy: not a mapping`);
    }
    const secret = secretProblem(content, hosts);
    if (secret) errors.push(`${path} ${secret}`);
    return { errors, dockerfiles };
}

// --- The submission ---------------------------------------------------------------------------

/** Why the list of files is refused before any content is read, or null. */
function filesShapeProblem(files: unknown): string | null {
    if (files === undefined) return null;
    if (!Array.isArray(files)) return 'files must be a list of { path, content }';
    if (files.length > AUTHORED_FILE_LIMITS.files) return `at most ${AUTHORED_FILE_LIMITS.files} files`;
    let total = 0;
    for (const f of files) {
        if (!isMap(f) || typeof f.path !== 'string' || typeof f.content !== 'string') return 'each file is { path, content } with two strings';
        const bytes = Buffer.byteLength(f.content);
        if (bytes > AUTHORED_FILE_LIMITS.fileBytes) return `${f.path.slice(0, 80)} is larger than ${AUTHORED_FILE_LIMITS.fileBytes} bytes`;
        total += bytes;
    }
    if (total > AUTHORED_FILE_LIMITS.totalBytes) return `the files are larger than ${AUTHORED_FILE_LIMITS.totalBytes} bytes together`;
    return null;
}

export interface AuthoredSubmissionCheck extends AuthoredRecipeCheck {
    /** The files as accepted (normalized paths, Kody's compose files as Kodus rewrote them), when ok. */
    files?: AuthoredFile[];
    /** What Kodus rewrote in Kody's compose files before checking them (authored-compose-sanitiser.ts), accepted or not. */
    adjusted?: string[];
}

/**
 * The repository paths an authored Dockerfile's COPY and ADD read from the
 * build context: not from another stage or image (--from), not a heredoc, not
 * a glob (BuildKit allows an empty match only with a wildcard). Each must be at
 * the commit, else the build stops at that line after a full build up to it
 * (n8n's `.npmrc`, nocodb's missing package dir).
 */
export function copySourcesOf(content: string, opts: { patterns?: boolean } = {}): Array<{ line: number; source: string }> {
    const out: Array<{ line: number; source: string }> = [];
    for (const i of instructionsOf(content)) {
        if (i.keyword !== 'COPY' && i.keyword !== 'ADD') continue;
        const { flags, rest } = flagsOf(i.args);
        if (flags.some((f) => f.name === '--from') || /<<-?/.test(rest) || /:\/\//.test(rest)) continue;
        let parts: string[];
        // Not JSON: the shell form below.
        const json = rest.trim().startsWith('[') ? (() => { try { return JSON.parse(rest.trim()) as unknown; } catch { return null; } })() : null;
        if (Array.isArray(json)) parts = json.filter((x): x is string => typeof x === 'string');
        else parts = rest.trim().split(/\s+/).filter(Boolean);
        for (const s of parts.slice(0, -1)) {
            // Globs and variables cannot be checked against the commit, but they still read the repository.
            if (!opts.patterns && (/[*?[]/.test(s) || s.includes('$'))) continue;
            out.push({ line: i.line, source: s });
        }
    }
    return out;
}

/** Each COPY or ADD source of an authored Dockerfile that is neither at the commit nor among the submitted files. */
export async function missingCopySources(
    path: string,
    content: string,
    context: string,
    has: (repoPath: string) => Promise<boolean>,
): Promise<string[]> {
    const errors: string[] = [];
    for (const { line, source } of copySourcesOf(content)) {
        const p = posix.normalize(posix.join(context === '.' ? '' : context, source.replace(/^\/+/, '')));
        if (p === '.' || p === '' || p.startsWith('..')) continue;
        if (!(await has(p.replace(/\/+$/, '')))) {
            errors.push(`${path}:${line} COPY ${source}: ${p} is not in the repository at this commit (build context ${context}); copy only what is there, list the directory first if unsure`);
        }
    }
    return errors;
}

/**
 * The environment a recipe is written for when it has repositories besides
 * the primary. Absent (or with no member) for one repository: every check
 * and message is then the single-repository one.
 */
export interface AuthoredWorkspace {
    /** The repository the recipe is of (its .kodus/ holds the recipe and Kody's files). */
    primary: { fullName: string; alias: string };
    /** Every other repository of the environment, as its membership names it. */
    members: ReadonlyArray<{ fullName: string; alias: string }>;
}

/** The members a repository compose file builds or binds (`../<alias>`): read only to require their needs, never refused here. */
function membersUsedBy(text: string, ws: ComposeWorkspace): void {
    let doc: unknown;
    try {
        doc = yaml.load(text, UNTRUSTED_YAML);
    } catch {
        // Read only to require needs: a file that does not parse requires none.
        return;
    }
    if (!isMap(doc) || !isMap(doc.services)) return;
    for (const svc of Object.values(doc.services)) {
        if (!isMap(svc)) continue;
        const b = typeof svc.build === 'string' ? { context: svc.build } : svc.build;
        if (isMap(b) && typeof b.context === 'string') composePath(b.context, ws);
        for (const vol of Array.isArray(svc.volumes) ? svc.volumes : []) {
            const source = typeof vol === 'string' ? (vol.split(':').length > 1 ? vol.split(':')[0] : undefined) : isMap(vol) && vol.type === 'bind' ? vol.source : undefined;
            if (typeof source === 'string') composePath(source, ws);
        }
    }
}

/**
 * Why services.needs disagrees with the environment: it names the primary,
 * a repository that is not a member, a member under another alias, or leaves
 * out a member the compose files build or bind.
 */
export function workspaceNeedsErrors(needs: readonly RecipeNeed[] | undefined, ws: AuthoredWorkspace, used: ReadonlySet<string>): string[] {
    const errors: string[] = [];
    const conflict = recipeNeedsConflict(needs, ws.primary);
    if (conflict) errors.push(`${conflict}; list only the other repositories of this environment`);
    const byAlias = new Map(ws.members.map((m) => [m.alias, m]));
    const known = ws.members.map((m) => `${m.alias} (${m.fullName})`).join(', ');
    const declared = new Set<string>();
    for (const [i, n] of (needs ?? []).entries()) {
        if (n.repo.toLowerCase() === ws.primary.fullName.toLowerCase() || n.alias === ws.primary.alias) continue;
        const m = byAlias.get(n.alias);
        if (m && m.fullName.toLowerCase() === n.repo.toLowerCase()) {
            declared.add(n.alias);
            continue;
        }
        const same = ws.members.find((x) => x.fullName.toLowerCase() === n.repo.toLowerCase());
        if (same) errors.push(`services.needs[${i}]: ${n.repo} is in this environment under the alias ${same.alias} (../${same.alias}); write alias: ${same.alias}`);
        else if (m) errors.push(`services.needs[${i}]: alias ${n.alias} is ${m.fullName} in this environment, not ${n.repo}`);
        else errors.push(`services.needs[${i}]: ${n.repo} is not a repository of this environment; the others are ${known}`);
    }
    for (const alias of used) {
        const m = byAlias.get(alias);
        if (m && !declared.has(alias)) errors.push(`services.needs: your compose files build or bind ../${alias}, so the recipe needs it; add - { repo: ${m.fullName}, alias: ${alias} }`);
    }
    return errors;
}

/**
 * Checks a recipe and the files Kody submits with it, on one commit. The
 * files are checked one by one (path, kind, content), then the recipe sees
 * them as if they were in the repository: its compose files may be authored
 * ones, and the public service of an authored compose file must be built.
 * Every authored file must be used: a compose file by the recipe, a
 * Dockerfile by an authored compose file's build.
 */
export async function checkAuthoredSubmission(
    recipe: string,
    files: unknown,
    exists: (path: string) => Promise<boolean>,
    read?: (path: string) => Promise<string | null>,
    /** Whether a directory is at the commit; without it, COPY sources are not checked. */
    dirExists?: (path: string) => Promise<boolean>,
    /**
     * The environment's other repositories. With one, `exists`, `read` and
     * `dirExists` also answer `../<alias>/…` (WorkspaceRepoReader), Kody's
     * compose files may build or bind `../<alias>`, and services.needs must
     * name exactly the members they use (and only members).
     */
    workspace?: AuthoredWorkspace,
    /**
     * nodeBuild: also the Node build rules (checkNodeBuild) on each authored
     * Dockerfile, with the facts `read` gives of its build context. Kody's tool
     * turns them on, so the model fixes a slow or unpinned build in the same run;
     * they stay off by default, so a recipe that booted before them is still
     * reused as is (the use case checks the last recipe again).
     */
    options: { nodeBuild?: boolean } = {},
): Promise<AuthoredSubmissionCheck> {
    const ws = workspace?.members.length ? workspace : undefined;
    const composeWs: ComposeWorkspace | undefined = ws && { primary: ws.primary.alias, members: new Set(ws.members.map((m) => m.alias)), used: new Set() };
    const shape = filesShapeProblem(files);
    if (shape) return { ok: false, errors: [`files: ${shape}`] };
    const list = (files ?? []) as AuthoredFile[];
    const errors: string[] = [];
    const byPath = new Map<string, AuthoredFile>();
    for (const f of list) {
        let p: string;
        try {
            p = repoPath(f.path);
        } catch (e) {
            if (ws && /^\.\.(\/|$)/.test(posix.normalize(f.path.trim()))) {
                errors.push(`files: ${JSON.stringify(f.path.slice(0, 80))} is outside ${ws.primary.alias}; Kody's files go only under this repository's ${AUTHORED_FILES_DIR} (another repository's ${AUTHORED_FILES_DIR} is never applied)`);
                continue;
            }
            errors.push(`files: ${JSON.stringify(f.path.slice(0, 80))} ${e instanceof RepoPathError ? e.message : 'is not a path'}`);
            continue;
        }
        if (!p.startsWith(AUTHORED_FILES_DIR) || !FILE_NAME.test(p.slice(AUTHORED_FILES_DIR.length))) {
            errors.push(`files: ${p} must be a file directly under ${AUTHORED_FILES_DIR} (like .kodus/Dockerfile or .kodus/compose.yaml)`);
            continue;
        }
        // Any recipe path: workspace.runtime.yaml is read before workspace.yaml, so it would replace the recipe once merged.
        if ((RECIPE_FILE_PATHS as readonly string[]).includes(p)) {
            errors.push(`files: ${p} is the recipe itself; submit it as recipe`);
            continue;
        }
        if (!authoredFileKind(p)) {
            errors.push(`files: ${p} is neither a Dockerfile (Dockerfile, Dockerfile.dev, app.Dockerfile) nor a compose file (.yaml)`);
            continue;
        }
        if (byPath.has(p)) {
            errors.push(`files: ${p} is submitted twice`);
            continue;
        }
        if (await exists(p)) {
            errors.push(`files: ${p} is already in the repository; Kody never replaces a repository file, pick another name`);
            continue;
        }
        byPath.set(p, { path: p, content: f.content });
    }
    if (errors.length) return { ok: false, errors };

    // Kody's compose files only (never the repository's): what the cell refuses but Kodus can write itself is rewritten first.
    const adjusted: string[] = [];
    let total = 0;
    const rewritten = new Map<string, string>();
    for (const f of byPath.values()) {
        if (authoredFileKind(f.path) !== 'compose') {
            total += Buffer.byteLength(f.content);
            continue;
        }
        const s = await sanitiseAuthoredCompose(f.path, f.content, exists);
        // A rewrite past the size bounds is not made: the checks refuse the file as written.
        const fits = Buffer.byteLength(s.content) <= AUTHORED_FILE_LIMITS.fileBytes;
        const content = s.changes.length && fits ? s.content : f.content;
        if (content !== f.content) {
            rewritten.set(f.path, content);
            adjusted.push(...s.changes);
        }
        total += Buffer.byteLength(content);
    }
    if (rewritten.size && total <= AUTHORED_FILE_LIMITS.totalBytes) for (const [p, content] of rewritten) byPath.set(p, { path: p, content });
    else adjusted.length = 0;
    const withAdjusted = <T extends AuthoredSubmissionCheck>(c: T): T => (adjusted.length ? { ...c, adjusted } : c);

    const authored = new Set(byPath.keys());
    const overlayExists = async (p: string) => authored.has(p) || exists(p);
    const usedDockerfiles = new Set<string>();
    const buildContexts = new Map<string, string>();
    const repositoryCode = { used: false };
    for (const f of byPath.values()) {
        if (authoredFileKind(f.path) === 'dockerfile') errors.push(...checkAuthoredDockerfile(f.path, f.content));
        else {
            const r = await checkAuthoredCompose(f.path, f.content, { authored, exists, buildContexts, repositoryCode, ...(composeWs ? { workspace: composeWs } : {}) });
            errors.push(...r.errors);
            r.dockerfiles.forEach((d) => usedDockerfiles.add(d));
        }
    }
    if (dirExists) {
        const has = async (p: string) => authored.has(p) || (await exists(p)) || (await dirExists(p));
        for (const [dockerfile, context] of buildContexts) {
            const f = byPath.get(dockerfile);
            if (f) errors.push(...(await missingCopySources(dockerfile, f.content, context, has)));
        }
    }
    if (options.nodeBuild && read) {
        for (const [dockerfile, context] of buildContexts) {
            const f = byPath.get(dockerfile);
            const facts = f ? await nodeBuildFacts(read, context) : null;
            if (f && facts) errors.push(...checkNodeBuild(dockerfile, f.content, facts));
        }
    }

    const check = await checkAuthoredRecipe(recipe, overlayExists, async (p) => byPath.get(p)?.content ?? (read ? read(p) : null), ws ? { needs: true } : undefined);
    errors.push(...check.errors);
    if (check.recipe) {
        const named = new Set(check.recipe.composeFiles.map((f) => posix.normalize(f)));
        if (ws && composeWs) {
            // The repository's own compose files may build a member too: that member is needed as much.
            if (read) for (const f of named) if (!authored.has(f)) membersUsedBy((await read(f)) ?? '', composeWs);
            errors.push(...workspaceNeedsErrors(check.recipe.needs, ws, composeWs.used));
        }
        for (const p of authored) {
            const kind = authoredFileKind(p);
            if (kind === 'compose' && !named.has(p)) errors.push(`files: ${p} is not in services.compose.files; name it there or leave it out`);
            if (kind === 'dockerfile' && !usedDockerfiles.has(p)) errors.push(`files: ${p} is built by no compose file you submit; add a service with build: { context: ., dockerfile: ${p} }`);
        }
        // Only Kody's compose files, and nothing of the repository in them: no Dockerfile of the repository, no bind of
        // its paths, and no COPY of Kody's Dockerfiles reading from it. That boots a placeholder (an nginx answering /
        // passes every other check), not the pull request's code.
        const copiesRepository = [...buildContexts.keys()].some((d) =>
            copySourcesOf(byPath.get(d)?.content ?? '', { patterns: true }).some(({ source }) => !`${posix.normalize(source.replace(/^\/+/, ''))}/`.startsWith(AUTHORED_FILES_DIR)),
        );
        if (named.size && [...named].every((f) => authored.has(f)) && !repositoryCode.used && !copiesRepository) {
            errors.push(
                "files: no service takes the repository's code (no COPY of its files, no Dockerfile or bind of it), so the app booted would hold none of the pull request; COPY the source the app needs (COPY . . or its package directories), or answer that there is nothing to boot",
            );
        }
    }
    if (errors.length) return withAdjusted({ ok: false, errors });
    // Once accepted (so every error names Kody's own lines), Kody's Dockerfiles install only through the cell's
    // read-only mirror: each stage that installs declares its build args (declareMirrorBuildArgs, G1).
    const accepted = [...byPath.values()].map((f) => {
        if (authoredFileKind(f.path) !== 'dockerfile') return f;
        const d = declareMirrorBuildArgs(f.path, f.content);
        if (!d.changes.length || Buffer.byteLength(d.content) > AUTHORED_FILE_LIMITS.fileBytes) return f;
        adjusted.push(...d.changes);
        return { path: f.path, content: d.content };
    });
    return withAdjusted({ ok: true, errors: [], recipe: check.recipe, files: accepted });
}

/**
 * For the eval: each authored Dockerfile's dependency installs, with the build
 * context the authored compose files give it (`.` when none names it) and
 * whether its context is a Node project and a monorepo. An install with no
 * `afterSource` reads only manifests: a change to the code does not run it again.
 */
export async function authoredInstallLayers(
    files: readonly AuthoredFile[],
    read: (path: string) => Promise<string | null>,
): Promise<Array<{ dockerfile: string; context: string; node: boolean; monorepo: boolean; installs: InstallLayer[] }>> {
    const contexts = new Map<string, string>();
    for (const f of files) {
        if (authoredFileKind(f.path) !== 'compose') continue;
        let doc: unknown;
        try {
            doc = yaml.load(f.content, UNTRUSTED_YAML);
        } catch {
            // The compose check reports the parse error; no layers to read here.
            continue;
        }
        for (const svc of isMap(doc) && isMap(doc.services) ? Object.values(doc.services) : []) {
            const b = isMap(svc) ? (typeof svc.build === 'string' ? { context: svc.build } : svc.build) : undefined;
            if (!isMap(b)) continue;
            const context = insideRoot(String(b.context ?? '.'));
            const dockerfile = context && insideRoot(posix.join(context, typeof b.dockerfile === 'string' ? b.dockerfile : 'Dockerfile'));
            if (context && dockerfile) contexts.set(dockerfile, context);
        }
    }
    const out: Array<{ dockerfile: string; context: string; node: boolean; monorepo: boolean; installs: InstallLayer[] }> = [];
    for (const f of files) {
        if (authoredFileKind(f.path) !== 'dockerfile') continue;
        const context = contexts.get(posix.normalize(f.path)) ?? '.';
        const facts = await nodeBuildFacts(read, context);
        out.push({ dockerfile: f.path, context, node: !!facts, monorepo: !!facts?.monorepo, installs: installLayersOf(f.content, facts ?? { workspaceGlobs: [] }) });
    }
    return out;
}
