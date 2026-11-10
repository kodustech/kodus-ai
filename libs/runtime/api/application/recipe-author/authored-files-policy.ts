import { posix } from 'path';

import * as yaml from 'js-yaml';

import { AUTHORED_FILES_LIMITS } from '@libs/runtime/contracts/authored-files';
import { RECIPE_FILE_PATHS } from '@libs/runtime/contracts/enums';
import { RECIPE_TEST_VALUES } from '@libs/runtime/protocol/recipe';
import { redactPatterns } from '@libs/runtime/redaction';
import { SECRET_NAME } from '@libs/runtime/run/recipe-inference';

import { checkAuthoredRecipe, type AuthoredRecipeCheck } from './authored-recipe-policy';
import { RepoPathError, repoPath } from './repo-reader';

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
/** Keys whose text is the container's shell's, where a `$` is not compose interpolation. */
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
}

/** Each rule an authored compose file breaks, and the Dockerfiles its builds name. */
export async function checkAuthoredCompose(path: string, content: string, ctx: ComposeContext): Promise<{ errors: string[]; dockerfiles: string[] }> {
    const errors: string[] = [];
    const dockerfiles: string[] = [];
    let doc: unknown;
    try {
        doc = yaml.load(content);
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
            else if (!SHELL_KEYS.has(k)) {
                walkStrings(svc[k], `${at}.${k}`, (s, p) => {
                    if (interpolates(s)) errors.push(`${p}: compose would interpolate the $; write the value itself`);
                });
            }
        }

        // Build: from the checkout only, with a Dockerfile Kody submits or the repository has.
        if (svc.build !== undefined) {
            const b = typeof svc.build === 'string' ? { context: svc.build } : svc.build;
            if (!isMap(b)) errors.push(`${at}.build: neither a path nor a mapping`);
            else {
                for (const k of Object.keys(b)) if (!BUILD_KEYS.has(k)) errors.push(`${at}.build.${k}: the cell builds from the checkout alone (context, dockerfile, target, args)`);
                const context = insideRoot(String(b.context ?? '.'));
                if (!context) errors.push(`${at}.build.context: must be a directory of the repository, relative to its root`);
                const df = typeof b.dockerfile === 'string' ? b.dockerfile : 'Dockerfile';
                const dockerfile = context && !df.startsWith('/') ? insideRoot(posix.join(context, df)) : null;
                if (context && !dockerfile) errors.push(`${at}.build.dockerfile: must be inside the build context`);
                if (context && dockerfile && !(dockerfile === context || dockerfile.startsWith(context === '.' ? '' : `${context}/`))) {
                    errors.push(`${at}.build.dockerfile: ${dockerfile} is outside the context ${context}; the cell refuses it`);
                } else if (dockerfile) {
                    if (ctx.authored.has(dockerfile)) dockerfiles.push(dockerfile);
                    else if (!(await ctx.exists(dockerfile))) {
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
                if (!source || !insideRoot(source)) errors.push(`${vp}: a bind outside the repository (${JSON.stringify(source ?? '')}); bind only paths of the repository, relative to its root`);
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
    /** The files as accepted (normalized paths), when ok. */
    files?: AuthoredFile[];
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
): Promise<AuthoredSubmissionCheck> {
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

    const authored = new Set(byPath.keys());
    const overlayExists = async (p: string) => authored.has(p) || exists(p);
    const usedDockerfiles = new Set<string>();
    for (const f of byPath.values()) {
        if (authoredFileKind(f.path) === 'dockerfile') errors.push(...checkAuthoredDockerfile(f.path, f.content));
        else {
            const r = await checkAuthoredCompose(f.path, f.content, { authored, exists });
            errors.push(...r.errors);
            r.dockerfiles.forEach((d) => usedDockerfiles.add(d));
        }
    }

    const check = await checkAuthoredRecipe(recipe, overlayExists, async (p) => byPath.get(p)?.content ?? (read ? read(p) : null));
    errors.push(...check.errors);
    if (check.recipe) {
        const named = new Set(check.recipe.composeFiles.map((f) => posix.normalize(f)));
        for (const p of authored) {
            const kind = authoredFileKind(p);
            if (kind === 'compose' && !named.has(p)) errors.push(`files: ${p} is not in services.compose.files; name it there or leave it out`);
            if (kind === 'dockerfile' && !usedDockerfiles.has(p)) errors.push(`files: ${p} is built by no compose file you submit; add a service with build: { context: ., dockerfile: ${p} }`);
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, errors: [], recipe: check.recipe, files: [...byPath.values()] };
}
