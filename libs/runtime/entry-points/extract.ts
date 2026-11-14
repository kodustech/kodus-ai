import { RECIPE_CHANGED_PATH } from '@libs/runtime/contracts/enums';
// Entry points of a diff, computed without an LLM (docs §9.8, ADR-044).
// success needs a verdict on every one of them, so anything this extractor
// cannot map becomes `unmapped` and keeps the run at partly_tested.

export type EntryPointKind = 'http_route' | 'job' | 'cli' | 'dependency_surface' | 'unmapped';

export interface EntryPoint {
    id: string;
    kind: EntryPointKind;
    match: { method?: string; route?: string; file: string };
}

export interface ChangedFile {
    path: string;
    /** Unified diff of the file; changed lines are read from it. */
    patch?: string;
    /** Content after the change; routes are read from it. */
    content?: string;
}

const DEPENDENCY_SURFACE = [
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|Cargo\.lock)$/,
    /(^|\/)Dockerfile[^/]*$/,
    /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
    /^\.github\/workflows\//,
    /(^|\/)(vendor|third_party)\//,
];

const IGNORED = [/\.(md|mdx|txt|png|jpe?g|svg|gif)$/i, /\.(spec|test)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//];

import { ANY_METHOD } from './coverage';

const CODE = /\.[cm]?[jt]sx?$/;

/**
 * The path the product appends to a diff it had to cut (run-messages.ts
 * DIFF_TRUNCATED_MARKER_PATH): it becomes an entry point that no probe can
 * settle, so the Run stays partly tested.
 */
export const DIFF_TRUNCATED_MARKER_PATH = '.kodus-runtime/diff-truncated';
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function changedLines(patch: string | undefined): number[] {
    if (!patch) return [];
    const out: number[] = [];
    let line = 0;
    for (const row of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (hunk) {
            line = Number(hunk[1]);
            continue;
        }
        if (row.startsWith('+') && !row.startsWith('+++')) out.push(line++);
        else if (row.startsWith('-') && !row.startsWith('---')) out.push(line);
        else line++;
    }
    return out;
}

const ep = (kind: EntryPointKind, file: string, method?: string, route?: string): EntryPoint => ({
    id: kind === 'http_route' ? `${method} ${route}` : `${kind}:${file}`,
    kind,
    match: { file, method, route },
});

function nextRoute(path: string): string | undefined {
    const m = /(?:^|\/)(?:src\/)?(app|pages)\/(.+)$/.exec(path);
    if (!m) return undefined;
    let rest = m[2];
    if (m[1] === 'app') {
        if (!/(^|\/)route\.[cm]?[jt]s$/.test(rest)) return undefined;
        rest = rest.replace(/(^|\/)route\.[cm]?[jt]s$/, '');
    } else {
        if (!rest.startsWith('api/')) return undefined;
        rest = rest.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
    }
    const segments = rest
        .split('/')
        .filter((s) => s && !/^\(.*\)$/.test(s))
        .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*$1').replace(/^\[(.+)\]$/, ':$1'));
    return '/' + segments.join('/');
}

function nextRoutes(file: ChangedFile): EntryPoint[] | undefined {
    const route = nextRoute(file.path);
    if (!route) return undefined;
    const methods = HTTP_METHODS.filter((m) =>
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`).test(file.content ?? ''),
    );
    return (methods.length ? methods : [ANY_METHOD]).map((m) => ep('http_route', file.path, m, route));
}

interface RouteDecl {
    line: number;
    method: string;
    route: string;
    /** Last line of the handler (inclusive); only known for Nest methods, by brace matching. */
    endLine?: number;
}

/**
 * The last line (1-based) of the construct that starts at `start`: the
 * matching close of the first `open` character, counted across lines with
 * string literals and line comments blanked. `skip` drops a leading part of
 * the first line (a decorator's own parentheses or braces).
 */
function blockEnd(lines: string[], start: number, open: string, close: string, skip?: RegExp): number | undefined {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i++) {
        let text = lines[i].replace(/(['"`])(?:\\.|(?!\1).)*?\1/g, '""').replace(/\/\/.*$/, '');
        if (i === start && skip) text = text.replace(skip, '');
        for (const ch of text) {
            if (ch === open) {
                depth++;
                opened = true;
            } else if (ch === close && opened && --depth === 0) {
                return i + 1;
            }
        }
    }
    return undefined;
}

const joinRoute = (prefix: string, path: string) =>
    ('/' + [prefix, path].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')) || '/';

function declaredRoutes(content: string): { decls: RouteDecl[]; controller: boolean } {
    const lines = content.split('\n');
    const decls: RouteDecl[] = [];
    const controller = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(content);
    const prefix = controller?.[1] ?? '';
    lines.forEach((text, i) => {
        const nest = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(text);
        if (controller && nest) {
            decls.push({ line: i + 1, method: nest[1].toUpperCase(), route: joinRoute(prefix, nest[2] ?? ''), endLine: blockEnd(lines, i, '{', '}', /^\s*@\w+\([^)]*\)/) });
            return;
        }
        const call = /\b(?:app|router|fastify|server|api|routes)\.(get|post|put|patch|delete|head|options|all)\(\s*['"`]([^'"`]+)['"`]/.exec(text);
        if (call) decls.push({ line: i + 1, method: call[1].toUpperCase(), route: call[2], endLine: blockEnd(lines, i, '(', ')', /^.*?\b(?=(?:app|router|fastify|server|api|routes)\.)/) });
    });
    return { decls, controller: Boolean(controller) };
}

function handlerRoutes(file: ChangedFile): EntryPoint[] | undefined {
    if (!file.content) return undefined;
    const { decls } = declaredRoutes(file.content);
    if (decls.length === 0) return undefined;
    const touched = changedLines(file.patch);
    // A line inside one handler reaches that route. Any other line (imports,
    // constructor, a helper below the handlers, a route call whose end is
    // unknown) can reach every route of the file.
    const hit = new Map<string, RouteDecl>();
    const all = () => decls.forEach((d) => hit.set(`${d.method} ${d.route}`, d));
    for (const line of touched) {
        const owners = decls.filter((d) => d.line <= line);
        const owner = owners[owners.length - 1];
        if (owner && owner.endLine !== undefined && line <= owner.endLine) hit.set(`${owner.method} ${owner.route}`, owner);
        else all();
    }
    if (touched.length === 0) decls.forEach((d) => hit.set(`${d.method} ${d.route}`, d));
    return [...hit.values()].map((d) => ep('http_route', file.path, d.method, d.route));
}

/**
 * `recipe`: the changed recipe files whose PR copy the Run never boots
 * (recipeFilesChangedBy): no entry point, the Run says so through S-19. Any
 * other root `.kodus/` file (a compose, a Dockerfile the workspace builds
 * with) is booted from the PR's checkout, so it is dependency surface.
 */
export function extractEntryPoints(files: ChangedFile[], opts: { recipe?: Iterable<string> } = {}): EntryPoint[] {
    const out = new Map<string, EntryPoint>();
    const add = (e: EntryPoint) => out.set(e.id, e);
    const recipe = new Set(opts.recipe ?? []);
    for (const file of files) {
        if (file.path === DIFF_TRUNCATED_MARKER_PATH) {
            add({ id: 'unmapped:diff-truncated', kind: 'unmapped', match: { file: file.path } });
            continue;
        }
        if (recipe.has(file.path)) continue;
        const kodusBuildFile = RECIPE_CHANGED_PATH.test(file.path) && !IGNORED.some((r) => r.test(file.path));
        if (kodusBuildFile || DEPENDENCY_SURFACE.some((r) => r.test(file.path))) {
            add(ep('dependency_surface', file.path));
            continue;
        }
        if (IGNORED.some((r) => r.test(file.path))) continue;
        if (!CODE.test(file.path)) {
            add(ep('unmapped', file.path));
            continue;
        }
        const routes = nextRoutes(file) ?? handlerRoutes(file);
        if (routes?.length) routes.forEach(add);
        else add(ep('unmapped', file.path));
    }
    return [...out.values()];
}
