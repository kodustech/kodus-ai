import ts from 'typescript';

import { RECIPE_CHANGED_PATH } from '@libs/runtime/contracts/enums';
// Entry points of a diff, computed without an LLM (docs §9.8, ADR-044).
// success needs a verdict on every one of them, so anything this extractor
// cannot map becomes `unmapped` and keeps the run at partly_tested.

export type EntryPointKind = 'http_route' | 'job' | 'cli' | 'dependency_surface' | 'unmapped';

export interface EntryPoint {
    id: string;
    kind: EntryPointKind;
    match: { method?: string; route?: string; file: string };
    /**
     * An http_route the diff adds: its declaration is an added line and no
     * removed line of the diff declares the same method and route. Read from
     * the diff only; the Run calls the route new only when main also answers
     * it as absent (gate decideNewEndpoint).
     */
    added?: true;
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
    // pip's requirement and constraint files, and the runtime pin of a buildpack: text files that install what runs.
    /(^|\/)(requirements|constraints)[^/]*\.txt$/,
    /(^|\/)runtime\.txt$/,
    /(^|\/)Dockerfile[^/]*$/,
    /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
    /^\.github\/workflows\//,
    /(^|\/)(vendor|third_party)\//,
];

const NOTE_OR_MEDIA = /\.(md|mdx|txt|png|jpe?g|svg|gif)$/i;
/** Tests, and notes or images outside every directory an app serves: no request reaches them. Served ones stay unmapped. */
const isIgnored = (path: string) => isTestFile(path) || (NOTE_OR_MEDIA.test(path) && !isServedPath(path));

import { ANY_METHOD } from './coverage';
import { codeChangedLines, isDocumentation, isServedPath, isTestFile, noEffectReason, parseSource } from './no-effect';
import { helperReach } from './helper-reach';
import { routeTableRoutes } from './route-table';

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

/** The new-side line numbers of a patch's added rows, and the text of its removed rows. */
function patchRows(patch: string | undefined): { added: Set<number>; removed: string[]; newFile: boolean } {
    const added = new Set<number>();
    const removed: string[] = [];
    let newFile = false;
    if (!patch) return { added, removed, newFile };
    let line = 0;
    for (const row of patch.split('\n')) {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (hunk) {
            if (hunk[1] === '0' && hunk[2] === '0') newFile = true;
            line = Number(hunk[3]);
            continue;
        }
        if (row.startsWith('+') && !row.startsWith('+++')) added.add(line++);
        else if (row.startsWith('-') && !row.startsWith('---')) removed.push(row.slice(1));
        else line++;
    }
    return { added, removed, newFile };
}

const ep = (kind: EntryPointKind, file: string, method?: string, route?: string, added?: boolean): EntryPoint => ({
    id: kind === 'http_route' ? `${method} ${route}` : `${kind}:${file}`,
    kind,
    match: { file, method, route },
    ...(added ? { added: true as const } : {}),
});

/** A Next.js App Router page: `page.tsx` (or .jsx/.ts/.js/.mdx) makes its folder a route served with GET. */
const NEXT_PAGE = /(^|\/)page\.([cm]?[jt]sx?|mdx?)$/;
const NEXT_ROUTE_HANDLER = /(^|\/)route\.[cm]?[jt]s$/;

/**
 * The URL of a Next.js route file, by the App Router's and Pages Router's
 * file conventions (nextjs.org/docs/app/getting-started/project-structure):
 * a route group `(name)` and a parallel-route slot `@name` are not part of
 * the URL; `[id]` is a param, `[...slug]` and `[[...slug]]` a catch-all; a
 * private folder `_name` is not routable, and an intercepting route
 * (`(.)x`, `(..)x`) serves a URL another file owns, so neither maps here.
 */
function nextRoute(path: string): { route: string; page: boolean } | undefined {
    const m = /(?:^|\/)(?:src\/)?(app|pages)\/(.+)$/.exec(path);
    if (!m) return undefined;
    let rest = m[2];
    let page = false;
    if (m[1] === 'app') {
        if (NEXT_ROUTE_HANDLER.test(rest)) rest = rest.replace(NEXT_ROUTE_HANDLER, '');
        else if (NEXT_PAGE.test(rest)) {
            rest = rest.replace(NEXT_PAGE, '');
            page = true;
        } else return undefined;
    } else {
        if (!rest.startsWith('api/')) return undefined;
        rest = rest.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
    }
    const raw = rest.split('/').filter(Boolean);
    if (raw.some((s) => s.startsWith('_') || /^\(\.{1,3}\)/.test(s))) return undefined;
    const segments = raw
        .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'))
        .map((s) => s.replace(/^\[\[\.\.\.(.+)\]\]$/, '*$1').replace(/^\[\.\.\.(.+)\]$/, '*$1').replace(/^\[(.+)\]$/, ':$1'));
    return { route: '/' + segments.join('/'), page };
}

/**
 * What the extractor reads of a changed file. The content comes from the
 * pull request, so the patterns below run on bounded text: a file past
 * MAX_CONTENT_CHARS is not read (it stays unmapped), a line past
 * MAX_LINE_CHARS is blanked (minified or generated code declares no route
 * we could map), and a file declaring more than MAX_ROUTE_DECLS routes is
 * not mapped either.
 */
const MAX_CONTENT_CHARS = 128 * 1024;
const MAX_LINE_CHARS = 400;
const MAX_ROUTE_DECLS = 150;

function readable(content: string | undefined): string | undefined {
    if (!content || content.length > MAX_CONTENT_CHARS) return undefined;
    return content
        .split('\n')
        .map((line) => (line.length > MAX_LINE_CHARS ? '' : line))
        .join('\n');
}

/** Whitespace runs as one space, so a pattern that spans lines cannot backtrack over a run. */
const flat = (content: string) => content.replace(/\s+/g, ' ');

const nextExport = (m: string) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`);

function nextRoutes(file: ChangedFile): EntryPoint[] | undefined {
    const next = nextRoute(file.path);
    if (!next) return undefined;
    const rows = patchRows(file.patch);
    // A page answers GET; it is new with its file.
    if (next.page) return [ep('http_route', file.path, 'GET', next.route, rows.newFile)];
    const route = next.route;
    const content = flat(readable(file.content) ?? '');
    const methods = HTTP_METHODS.filter((m) => nextExport(m).test(content));
    // A Next route is new with its file; an exported method is new when its export line is added and no removed line exported it.
    const lines = (readable(file.content) ?? '').split('\n');
    const addedExport = (m: string) =>
        lines.some((l, i) => rows.added.has(i + 1) && nextExport(m).test(l)) && !rows.removed.some((r) => nextExport(m).test(r));
    return (methods.length ? methods : [ANY_METHOD]).map((m) =>
        ep('http_route', file.path, m, route, rows.newFile || (m !== ANY_METHOD && addedExport(m))),
    );
}

export interface RouteDecl {
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

const NEST_DECORATOR = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/;
const ROUTE_CALL = /\b(?:app|router|fastify|server|api|routes)\.(get|post|put|patch|delete|head|options|all)\(\s*['"`]([^'"`]+)['"`]/;
/** `router.get(` at the end of its line, the path on the next one (directus' controllers). */
const ROUTE_CALL_OPEN = /\b(?:app|router|fastify|server|api|routes)\.(get|post|put|patch|delete|head|options|all)\(\s*$/;
const PATH_LINE = /^\s*['"`]([^'"`]+)['"`]\s*,/;
/**
 * A route a plain node:http handler declares on one line, the method and the
 * path compared in either order: `if (req.method === 'GET' && path === '/health')`.
 */
const NODE_METHOD = /\.method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/;
const NODE_PATH = /\b(?:path|pathname|url)\s*===?\s*['"`](\/[^'"`\s]*)['"`]/;
function nodeRoute(text: string): { method: string; route: string } | undefined {
    const method = NODE_METHOD.exec(text);
    const path = method && NODE_PATH.exec(text);
    return method && path ? { method: method[1], route: path[1] } : undefined;
}

/** The routes a file declares; undefined past MAX_ROUTE_DECLS. `content` is readable(). */
function declaredRoutes(content: string): RouteDecl[] | undefined {
    const lines = content.split('\n');
    const decls: RouteDecl[] = [];
    const controller = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(flat(content));
    const prefix = controller?.[1] ?? '';
    for (const [i, text] of lines.entries()) {
        if (decls.length > MAX_ROUTE_DECLS) return undefined;
        const nest = NEST_DECORATOR.exec(text);
        if (controller && nest) {
            decls.push({ line: i + 1, method: nest[1].toUpperCase(), route: joinRoute(prefix, nest[2] ?? ''), endLine: blockEnd(lines, i, '{', '}', /^\s*@\w+\([^)]*\)/) });
            continue;
        }
        const open = ROUTE_CALL_OPEN.exec(text);
        const next = open ? lines.slice(i + 1).find((l) => l.trim() !== '') : undefined;
        const call = ROUTE_CALL.exec(text) ?? (open && next && PATH_LINE.test(next) ? [open[0], open[1], PATH_LINE.exec(next)![1]] : null);
        if (call) {
            decls.push({ line: i + 1, method: call[1].toUpperCase(), route: call[2], endLine: blockEnd(lines, i, '(', ')', /^.*?\b(?=(?:app|router|fastify|server|api|routes)\.)/) });
            continue;
        }
        const node = nodeRoute(text);
        if (node) decls.push({ line: i + 1, method: node.method, route: node.route, endLine: blockEnd(lines, i, '{', '}') });
    }
    return decls.length > MAX_ROUTE_DECLS ? undefined : decls;
}

function handlerRoutes(file: ChangedFile): EntryPoint[] | undefined {
    const content = readable(file.content);
    if (!content) return undefined;
    const decls = declaredRoutes(content);
    if (!decls?.length) return undefined;
    return routesReachedBy(file, content, withMethodEnds(file.path, content, decls));
}

/**
 * A Nest handler ends where its method ends, read from the parsed file: the
 * brace count from the route decorator stops at the first object literal
 * when another decorator with one sits between the route and the method
 * (`@Get('ping') @Endpoint({...}) ping() {...}`, demo-immich).
 */
function withMethodEnds(path: string, content: string, decls: RouteDecl[]): RouteDecl[] {
    const sf = CODE.test(path) ? parseSource(path, content) : undefined;
    if (!sf) return decls;
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const methods: { from: number; to: number; end: number }[] = [];
    const visit = (n: ts.Node) => {
        if (ts.isMethodDeclaration(n) && ts.getDecorators(n)?.length) methods.push({ from: lineOf(n.getStart(sf)), to: lineOf(n.name.getStart(sf)), end: lineOf(n.getEnd()) });
        n.forEachChild(visit);
    };
    visit(sf);
    return decls.map((d) => {
        const m = methods.find((x) => x.from <= d.line && d.line <= x.to);
        return m ? { ...d, endLine: m.end } : d;
    });
}

/**
 * The routes of `decls` the diff's lines reach. Only rows that touch code
 * count (a comment or a blank line reaches nothing, no-effect.ts). A line
 * inside one handler reaches that route. A line outside every handler, in a
 * helper, a constant or an import, reaches the handlers that use what it
 * declares (helper-reach.ts), and is `unmapped` too when that is exported;
 * any other line, or one in a file that does not parse, can reach every
 * route of the file.
 */
function routesReachedBy(file: ChangedFile, content: string, decls: RouteDecl[]): EntryPoint[] {
    const touched = codeChangedLines(file) ?? changedLines(file.patch);
    const hit = new Map<string, RouteDecl>();
    const all = () => decls.forEach((d) => hit.set(`${d.method} ${d.route}`, d));
    const ownerOf = (line: number) => {
        const owners = decls.filter((d) => d.line <= line);
        const owner = owners[owners.length - 1];
        return owner && owner.endLine !== undefined && line <= owner.endLine ? owner : undefined;
    };
    const outside: number[] = [];
    for (const line of touched) {
        const owner = ownerOf(line);
        if (owner) hit.set(`${owner.method} ${owner.route}`, owner);
        else outside.push(line);
    }
    let unmapped = false;
    if (outside.length) {
        const sf = CODE.test(file.path) ? parseSource(file.path, content) : undefined;
        const reach = sf ? helperReach(sf, outside, decls) : undefined;
        if (!reach || reach.all) all();
        else {
            reach.handlers.forEach((d) => hit.set(`${d.method} ${d.route}`, d));
            unmapped = reach.exported;
        }
    }
    if (touched.length === 0) all();
    const { added } = patchRows(file.patch);
    const routes = [...hit.values()].map((d) => ep('http_route', file.path, d.method, d.route, added.has(d.line)));
    return unmapped ? [...routes, ep('unmapped', file.path)] : routes;
}

/**
 * Every route a file declares or serves, whatever its diff touched: what
 * the extractor can see of the file at all (the eval's route mapping).
 */
export function routesServedBy(file: ChangedFile): string[] {
    const next = nextRoute(file.path);
    if (next) {
        if (next.page) return [`GET ${next.route}`];
        const content = flat(readable(file.content) ?? '');
        const methods = HTTP_METHODS.filter((m) => nextExport(m).test(content));
        return (methods.length ? methods : [ANY_METHOD]).map((m) => `${m} ${next.route}`);
    }
    const content = readable(file.content);
    if (!content || !CODE.test(file.path)) return [];
    const table = routeTableRoutes(file.path, content);
    if (table) return [...new Set(table.map((d) => `${d.method} ${d.route}`))];
    return [...new Set((declaredRoutes(content) ?? []).map((d) => `${d.method} ${d.route}`))];
}

/** A Remix or React Router route table (`app/routes.ts`): its routes, the ones the diff's lines reach. */
function tableRoutes(file: ChangedFile): EntryPoint[] | undefined {
    const content = readable(file.content);
    if (!content) return undefined;
    const decls = routeTableRoutes(file.path, content);
    if (!decls?.length) return undefined;
    return routesReachedBy(file, content, decls);
}

/**
 * The routes a file's removed lines declared (`METHOD /path`): a route the
 * diff moves or rewrites is not one it adds. A Nest decorator takes the
 * prefix of the file's controller after the change.
 */
function removedRoutes(file: ChangedFile): string[] {
    const removed = patchRows(file.patch).removed.filter((r) => r.length <= MAX_LINE_CHARS);
    if (!removed.length) return [];
    const next = nextRoute(file.path);
    if (next) return next.page ? [] : HTTP_METHODS.filter((m) => removed.some((r) => nextExport(m).test(r))).map((m) => `${m} ${next.route}`);
    const prefix = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(flat(readable(file.content) ?? ''))?.[1] ?? '';
    const out: string[] = [];
    for (const row of removed) {
        const nest = NEST_DECORATOR.exec(row);
        if (nest) out.push(`${nest[1].toUpperCase()} ${joinRoute(prefix, nest[2] ?? '')}`);
        const call = ROUTE_CALL.exec(row);
        if (call) out.push(`${call[1].toUpperCase()} ${call[2]}`);
        const node = nodeRoute(row);
        if (node) out.push(`${node.method} ${node.route}`);
    }
    return out;
}

/**
 * `recipe`: the changed recipe files whose PR copy the Run never boots
 * (recipeFilesChangedBy): no entry point, the Run says so through S-19. Any
 * other root `.kodus/` file (a compose, a Dockerfile the workspace builds
 * with) is booted from the PR's checkout, so it is dependency surface.
 */
export function extractEntryPoints(files: ChangedFile[], opts: { recipe?: Iterable<string> } = {}): EntryPoint[] {
    const recipe = new Set(opts.recipe ?? []);
    return mergeEntryPoints(files, files.map((file) => entryPointsOfFile(file, recipe)));
}

/**
 * The entry points one changed file gives, in the order extractEntryPoints
 * adds them; mergeEntryPoints joins the files'. Split so that a caller can
 * give the event loop back between files (diff-analysis.ts).
 */
export function entryPointsOfFile(file: ChangedFile, recipe: ReadonlySet<string>): EntryPoint[] {
    if (file.path === DIFF_TRUNCATED_MARKER_PATH) return [{ id: 'unmapped:diff-truncated', kind: 'unmapped', match: { file: file.path } }];
    if (recipe.has(file.path)) return [];
    const kodusBuildFile = RECIPE_CHANGED_PATH.test(file.path) && !isIgnored(file.path);
    if (kodusBuildFile || DEPENDENCY_SURFACE.some((r) => r.test(file.path))) return [ep('dependency_surface', file.path)];
    // An MDX page of the App Router is a route, though no parser here reads it.
    if (/\.mdx?$/i.test(file.path) && nextRoute(file.path)?.page) return nextRoutes(file)!;
    if (isIgnored(file.path)) return [];
    // Documentation, or code whose tokens did not change (a comment, a blank line, layout): no request reaches a change.
    if (isDocumentation(file.path) || (CODE.test(file.path) && noEffectReason(file))) return [];
    if (!CODE.test(file.path)) return [ep('unmapped', file.path)];
    const routes = nextRoutes(file) ?? tableRoutes(file) ?? handlerRoutes(file);
    return routes?.length ? routes : [ep('unmapped', file.path)];
}

/** The diff's entry points from each file's (entryPointsOfFile, in file order): one per id, `added` only where no file removes it. */
export function mergeEntryPoints(files: ChangedFile[], perFile: EntryPoint[][]): EntryPoint[] {
    const out = new Map<string, EntryPoint>();
    // Two files that declare one route: it is added only if both declarations are.
    const add = (e: EntryPoint) => {
        const prior = out.get(e.id);
        out.set(e.id, prior && !prior.added && e.added ? { ...e, added: undefined } : e);
    };
    perFile.forEach((eps) => eps.forEach(add));
    const removed = new Set(files.flatMap(removedRoutes));
    return [...out.values()].map((e) => (e.added && !removed.has(e.id) ? e : withoutAdded(e)));
}

const withoutAdded = ({ added: _added, ...e }: EntryPoint): EntryPoint => e;
