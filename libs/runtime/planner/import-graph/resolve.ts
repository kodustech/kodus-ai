import { posix } from 'path';

// How a JS/TS import specifier names a file of the repository (docs §9.8):
// relative paths, tsconfig/jsconfig `paths` and `baseUrl`, and the workspace
// packages of a monorepo by their package.json name. Everything is read as
// data from the commit; nothing of the repository is executed, and a
// specifier that names no file of the tree resolves to nothing.

/** Extensions tried for a specifier without one, in TypeScript's order. */
export const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
/** `./x.js` in TypeScript ESM names `./x.ts`. */
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

export interface PathAliases {
    /** Directory of the tsconfig the aliases apply under ('' is the root). */
    dir: string;
    /** Directory non-relative specifiers resolve against (`baseUrl`), when set. */
    baseUrl?: string;
    /** `paths` patterns, each target already relative to the repository root. */
    paths: { pattern: string; targets: string[] }[];
}

export interface WorkspacePackage {
    name: string;
    dir: string;
    /** Entry files the manifest names (source, main, module, types, exports['.']), relative to the root. */
    entries: string[];
    /** `exports` subpaths ('./money' without the './'), each with its candidate targets relative to the root. */
    subpaths?: Record<string, string[]>;
}

export interface ResolveContext {
    files: ReadonlySet<string>;
    aliases: PathAliases[];
    packages: WorkspacePackage[];
}

const LIMITS = { configBytes: 64 * 1024, extendsDepth: 3, patternsPerConfig: 200, targetsPerPattern: 8 } as const;

/**
 * JSON with comments and trailing commas (tsconfig, jsconfig) as a value, or
 * undefined. One linear pass: comments outside strings are dropped, a comma
 * whose next significant character closes the object or array is dropped.
 */
export function parseJsonc(text: string): unknown {
    if (text.length > LIMITS.configBytes) return undefined;
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 2;
        } else if (ch === ',') {
            // The next significant character, past whitespace and comments.
            let j = i + 1;
            while (j < text.length) {
                if (/\s/.test(text[j])) j++;
                else if (text[j] === '/' && text[j + 1] === '/') {
                    const nl = text.indexOf('\n', j);
                    j = nl < 0 ? text.length : nl;
                } else if (text[j] === '/' && text[j + 1] === '*') {
                    const end = text.indexOf('*/', j + 2);
                    j = end < 0 ? text.length : end + 2;
                } else break;
            }
            if (text[j] !== '}' && text[j] !== ']') out += ch;
            i++;
        } else {
            out += ch;
            i++;
        }
    }
    try {
        return JSON.parse(out);
    } catch {
        return undefined;
    }
}

const dirOf = (path: string) => {
    const d = posix.dirname(path);
    return d === '.' ? '' : d;
};

/** A path joined under the root, or undefined when it leaves the repository. */
function inRepo(...parts: string[]): string | undefined {
    const n = posix.normalize(posix.join(...parts.filter((p) => p !== ''), '.'));
    if (n === '..' || n.startsWith('../') || n.startsWith('/')) return undefined;
    return n === '.' ? '' : n.replace(/\/+$/, '');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The aliases of one tsconfig/jsconfig, following `extends` to configs of the
 * same tree (a package name in `extends` is not followed). `read` returns a
 * config's text, or null.
 */
export async function aliasesOf(configPath: string, read: (path: string) => Promise<string | null>): Promise<PathAliases | undefined> {
    let baseUrl: string | undefined;
    let paths: PathAliases['paths'] | undefined;
    let current: string | undefined = configPath;
    for (let depth = 0; current && depth <= LIMITS.extendsDepth; depth++) {
        const text = await read(current);
        const json = text === null ? undefined : parseJsonc(text);
        if (!isRecord(json)) break;
        const options = isRecord(json.compilerOptions) ? json.compilerOptions : {};
        const here = dirOf(current);
        if (baseUrl === undefined && typeof options.baseUrl === 'string') baseUrl = inRepo(here, options.baseUrl);
        if (paths === undefined && isRecord(options.paths)) {
            // Targets are relative to baseUrl when one is set, else to the config that declares them.
            const pathsBase = typeof options.baseUrl === 'string' ? inRepo(here, options.baseUrl) : here;
            paths = Object.entries(options.paths)
                .slice(0, LIMITS.patternsPerConfig)
                .map(([pattern, targets]) => ({
                    pattern,
                    targets: (Array.isArray(targets) ? targets : [])
                        .filter((t): t is string => typeof t === 'string')
                        .slice(0, LIMITS.targetsPerPattern)
                        .map((t) => (pathsBase === undefined ? undefined : inRepo(pathsBase, t)))
                        .filter((t): t is string => t !== undefined),
                }));
        }
        const ext = typeof json.extends === 'string' ? json.extends : Array.isArray(json.extends) && typeof json.extends[0] === 'string' ? json.extends[0] : undefined;
        current = ext && ext.startsWith('.') ? inRepo(here, ext.endsWith('.json') ? ext : `${ext}.json`) : undefined;
    }
    if (baseUrl === undefined && !paths?.length) return undefined;
    return { dir: dirOf(configPath), ...(baseUrl !== undefined ? { baseUrl } : {}), paths: paths ?? [] };
}

const EXPORT_CONDITIONS = ['source', 'import', 'default', 'require', 'types', 'node'] as const;

/** The file strings an `exports` target names, through nested conditions (bounded depth), most source-like first. */
function exportTargets(target: unknown, depth = 0): string[] {
    if (typeof target === 'string') return [target];
    if (Array.isArray(target) && depth < 4) return target.slice(0, 4).flatMap((t) => exportTargets(t, depth + 1));
    if (!isRecord(target) || depth >= 4) return [];
    return EXPORT_CONDITIONS.flatMap((c) => (c in target ? exportTargets(target[c], depth + 1) : []));
}

const MAX_SUBPATHS = 100;

/** A workspace package from its package.json text, or undefined when it has no name. */
export function packageOf(manifestPath: string, text: string): WorkspacePackage | undefined {
    const json = parseJsonc(text);
    if (!isRecord(json) || typeof json.name !== 'string' || !json.name || json.name.length > 214) return undefined;
    const dir = dirOf(manifestPath);
    const exp = json.exports;
    // `exports` is either a map of subpaths ('.', './x') or, with no key starting with '.', the conditions of '.' itself.
    const map = isRecord(exp) && Object.keys(exp).some((k) => k.startsWith('.')) ? exp : { '.': exp };
    const inPackage = (list: string[]) =>
        list
            .filter((e) => e.length < 512)
            .map((e) => inRepo(dir, e))
            .filter((e): e is string => e !== undefined);
    const entries = inPackage([json.source, ...exportTargets(map['.']), json.module, json.main, json.types, json.typings].filter((e): e is string => typeof e === 'string'));
    const subpaths: Record<string, string[]> = {};
    for (const [key, target] of Object.entries(map).slice(0, MAX_SUBPATHS)) {
        // Patterns ('./features/*') are not followed: a specifier is matched against exact subpaths only.
        if (!key.startsWith('./') || key.includes('*')) continue;
        const list = inPackage(exportTargets(target));
        if (list.length) subpaths[key.slice(2)] = list;
    }
    return { name: json.name, dir, entries, ...(Object.keys(subpaths).length ? { subpaths } : {}) };
}

const globRegex = (glob: string): RegExp | undefined => {
    const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!g || g.length > 200 || g.startsWith('/') || g.includes('..')) return undefined;
    const body = g
        .split(/(\*\*\/?|\*)/)
        .map((part, i, all) => (part.startsWith('**') ? (all.slice(i + 1).every((x) => x === '') ? '.*' : '(?:.*/)?') : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
        .join('');
    return new RegExp(`^${body}$`);
};

/**
 * The workspace directory patterns of a monorepo: the root package.json's `workspaces` (an array, or yarn's
 * `{ packages }`) and pnpm-workspace.yaml's `packages` list. A `!` pattern excludes. Read as data, bounded.
 */
export function workspaceGlobsOf(rootManifest: string | null, pnpmYaml: string | null): string[] {
    const out: string[] = [];
    const json = rootManifest === null ? undefined : parseJsonc(rootManifest);
    if (isRecord(json)) {
        const w = json.workspaces;
        const list = Array.isArray(w) ? w : isRecord(w) && Array.isArray(w.packages) ? w.packages : [];
        out.push(...list.filter((g): g is string => typeof g === 'string'));
    }
    if (pnpmYaml !== null && pnpmYaml.length <= LIMITS.configBytes) {
        let inPackages = false;
        for (const raw of pnpmYaml.split('\n').slice(0, 500)) {
            const line = raw.replace(/\s+#.*$/, '').trimEnd();
            if (/^packages\s*:/.test(line)) inPackages = true;
            else if (/^\S/.test(line)) inPackages = false;
            else if (inPackages) {
                const m = /^\s*-\s*(['"]?)(.+?)\1\s*$/.exec(line);
                if (m) out.push(m[2]);
            }
        }
    }
    return out.slice(0, 100);
}

/** Whether a directory is one of the workspace patterns' (the last pattern that matches decides, so `!` excludes). */
export function isWorkspaceDir(dir: string, globs: string[]): boolean {
    let yes = false;
    for (const g of globs) {
        const neg = g.startsWith('!');
        const re = globRegex(neg ? g.slice(1) : g);
        if (re?.test(dir)) yes = !neg;
    }
    return yes;
}

/** The file a candidate path names: itself, with an extension, its index, or the TS source of a .js path. */
function fileFor(candidate: string, files: ReadonlySet<string>): string | undefined {
    if (files.has(candidate) && CODE_EXTENSIONS.some((e) => candidate.endsWith(e))) return candidate;
    const ext = posix.extname(candidate);
    for (const ts of JS_TO_TS[ext] ?? []) {
        const swapped = candidate.slice(0, -ext.length) + ts;
        if (files.has(swapped)) return swapped;
    }
    for (const e of CODE_EXTENSIONS) if (files.has(candidate + e)) return candidate + e;
    for (const e of CODE_EXTENSIONS) if (files.has(`${candidate}/index${e}`)) return `${candidate}/index${e}`;
    return undefined;
}

/** A built entry (`dist/index.js`, `lib/x.d.ts`) mapped back to its source under `src/`. */
function sourceOfBuilt(entry: string, dir: string): string[] {
    const rel = dir ? entry.slice(dir.length + 1) : entry;
    const stem = rel.replace(/\.d\.[cm]?ts$/, '').replace(/\.[cm]?[jt]sx?$/, '');
    const unbuilt = stem.replace(/^(dist|lib|build|out|esm|cjs)\//, 'src/');
    return [entry, inRepo(dir, unbuilt), inRepo(dir, stem)].filter((p): p is string => p !== undefined);
}

function matchPattern(pattern: string, spec: string): string | undefined {
    const star = pattern.indexOf('*');
    if (star < 0) return pattern === spec ? '' : undefined;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) return undefined;
    return spec.slice(prefix.length, spec.length - suffix.length);
}

/** The nearest aliases above a file: the tsconfig of the deepest directory that holds it. */
function aliasesFor(from: string, aliases: PathAliases[]): PathAliases[] {
    let best = -1;
    let out: PathAliases[] = [];
    for (const a of aliases) {
        if (a.dir !== '' && from !== a.dir && !from.startsWith(`${a.dir}/`)) continue;
        const depth = a.dir === '' ? 0 : a.dir.split('/').length;
        if (depth > best) {
            best = depth;
            out = [a];
        } else if (depth === best) out.push(a);
    }
    return out;
}

/** The repository file a specifier imported from `from` names, or undefined (an external package, a missing file). */
export function resolveSpecifier(spec: string, from: string, ctx: ResolveContext): string | undefined {
    if (!spec || spec.length > 512 || spec.includes('\0')) return undefined;
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
        const p = inRepo(dirOf(from), spec);
        return p === undefined ? undefined : fileFor(p, ctx.files);
    }
    if (spec.startsWith('/') || /^[a-z][\w+.-]*:/i.test(spec)) return undefined;
    for (const a of aliasesFor(from, ctx.aliases)) {
        // The longest matching prefix wins, as in TypeScript.
        const hits = a.paths
            .map((p) => ({ p, rest: matchPattern(p.pattern, spec) }))
            .filter((h): h is { p: PathAliases['paths'][number]; rest: string } => h.rest !== undefined)
            .sort((x, y) => y.p.pattern.indexOf('*') - x.p.pattern.indexOf('*'));
        for (const { p, rest } of hits) {
            for (const t of p.targets) {
                // TypeScript allows one `*` per target; spliced, so a `$&` in the matched part stays literal.
                const star = t.indexOf('*');
                const target = inRepo(star < 0 ? t : t.slice(0, star) + rest + t.slice(star + 1));
                const file = target === undefined ? undefined : fileFor(target, ctx.files);
                if (file) return file;
            }
        }
        if (a.baseUrl !== undefined) {
            const p = inRepo(a.baseUrl, spec);
            const file = p === undefined ? undefined : fileFor(p, ctx.files);
            if (file) return file;
        }
    }
    const pkg = ctx.packages.filter((p) => spec === p.name || spec.startsWith(`${p.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!pkg) return undefined;
    const sub = spec.slice(pkg.name.length + 1);
    const candidates = sub
        ? [...(pkg.subpaths?.[sub] ?? []).flatMap((e) => sourceOfBuilt(e, pkg.dir)), inRepo(pkg.dir, 'src', sub), inRepo(pkg.dir, sub)]
        : [...pkg.entries.flatMap((e) => sourceOfBuilt(e, pkg.dir)), inRepo(pkg.dir, 'src/index'), inRepo(pkg.dir, 'index')];
    for (const c of candidates) {
        const file = c === undefined ? undefined : fileFor(c, ctx.files);
        if (file) return file;
    }
    return undefined;
}
