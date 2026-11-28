import { posix } from 'path';

import { extractEntryPoints } from '@libs/runtime/entry-points/extract';

// The routes one JS/TS file declares, by framework convention (docs §9.8):
// Next.js app and pages routers (pages, layouts and route handlers), Remix
// route modules, Nest controllers and GraphQL resolvers, Express/Koa/Hono
// route calls, Fastify route objects, and `.get('/path', …)` on any router-named
// receiver as the generic fallback. Each route is `METHOD /path`, the shape of an entry point
// id. File content is untrusted: it is cut and normalized before any pattern
// runs, and every pattern here is bounded, so no file can make a scan hang.

export const ROUTE_LIMITS = {
    /** Bytes of a file the patterns read. */
    fileBytes: 128 * 1024,
    /** Longer lines are blanked: minified or generated text declares no route worth probing. */
    lineChars: 400,
    /** Route calls or decorators past which the entry-point extractor (which matches each one's block) is not run. */
    extractorDecls: 150,
    /** `@Controller(` past which the extractor is not run (its prefix pattern spans the file). */
    extractorControllers: 5,
    routesPerFile: 40,
} as const;

const HTTP_CALL = /\.(get|post|put|patch|delete|head|options|all)\(\s{0,20}(['"`])(\/[^'"`\n]{0,200})\2/g;
/** Receivers that declare routes (`app`, `router`, `this.app`, `adminRouter`, `r`), never an HTTP client sending one. */
const SERVER_RECEIVER = /^(app|router|server|fastify|routes?|r|express|koa|hono|\w*(Router|App|Server|Routes))$/;
const DECL_LINE = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(|\.(get|post|put|patch|delete|head|options|all)\(/;

/**
 * The text the patterns read: cut at the byte limit, long lines blanked,
 * runs of spaces and tabs collapsed to one and runs of blank lines to one,
 * in one linear pass. Line numbers are not kept: the routes of the whole file
 * are wanted.
 */
export function normalizedSource(text: string): string {
    const src = text.length > ROUTE_LIMITS.fileBytes ? text.slice(0, ROUTE_LIMITS.fileBytes) : text;
    const out: string[] = [];
    let blank = false;
    for (const raw of src.split('\n')) {
        if (raw.length > ROUTE_LIMITS.lineChars) continue;
        let line = '';
        let space = false;
        for (const ch of raw) {
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                space = true;
                continue;
            }
            if (space && line) line += ' ';
            space = false;
            line += ch;
        }
        if (!line) {
            if (!blank) out.push('');
            blank = true;
            continue;
        }
        blank = false;
        out.push(line);
    }
    return out.join('\n');
}

/** `[id]` → `:id`, `[...slug]`/`[[...slug]]` → `*slug`; route groups, parallel slots and private folders are not segments. */
function nextSegments(dirs: string[]): string[] | undefined {
    const out: string[] = [];
    for (const s of dirs) {
        if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue;
        if (s.startsWith('_')) return undefined;
        out.push(s.replace(/^\[\[?\.\.\.([^\]]+)\]\]?$/, '*$1').replace(/^\[([^\]]+)\]$/, ':$1'));
    }
    return out;
}

const route = (segments: string[]) => '/' + segments.filter(Boolean).join('/');

const CONFIG_EXT = ['js', 'mjs', 'cjs', 'ts', 'mts'];

/**
 * Whether the app dir or pages dir at `parts[at]` belongs to a Next app: a
 * next.config sits in the directory above it (or above its `src`). A `pages`
 * folder of a Vite SPA or of an admin panel is no router.
 */
function isNextRoot(parts: string[], at: number, files: ReadonlySet<string>): boolean {
    const root = parts.slice(0, at);
    const roots = root[root.length - 1] === 'src' ? [root, root.slice(0, -1)] : [root];
    return roots.some((r) => CONFIG_EXT.some((e) => files.has([...r, `next.config.${e}`].join('/'))));
}

/** The route of a Next page, a layout (the route it wraps) or a pages-router page. */
function nextPageRoute(path: string, files: ReadonlySet<string>): string | undefined {
    const parts = path.split('/');
    const file = parts[parts.length - 1];
    const stem = file.replace(/\.[cm]?[jt]sx?$|\.mdx$/, '');
    if (stem === file) return undefined;
    const app = parts.lastIndexOf('app');
    if (app >= 0 && (stem === 'page' || stem === 'layout') && parts[app + 1] !== 'routes' && isNextRoot(parts, app, files)) {
        const segs = nextSegments(parts.slice(app + 1, -1));
        return segs ? route(segs) : undefined;
    }
    const pages = parts.lastIndexOf('pages');
    if (pages >= 0 && parts[pages + 1] !== 'api' && !stem.startsWith('_') && /\.[jt]sx?$/.test(file) && isNextRoot(parts, pages, files)) {
        const dirs = parts.slice(pages + 1, -1);
        const segs = nextSegments(stem === 'index' ? dirs : [...dirs, stem]);
        return segs ? route(segs) : undefined;
    }
    return undefined;
}

/** A Remix route module under app/routes: flat (`users.$id.tsx`), folder (`users.$id/route.tsx`) or nested v1 (`users/$id.tsx`). */
function remixRoute(path: string, files: ReadonlySet<string>): string | undefined {
    const at = path.indexOf('app/routes/');
    if (at < 0 || (at > 0 && path[at - 1] !== '/')) return undefined;
    // A Remix (or React Router framework) app has its root module beside app/routes.
    if (!['tsx', 'jsx', 'ts', 'js'].some((e) => files.has(`${path.slice(0, at)}app/root.${e}`))) return undefined;
    let rest = path.slice(at + 'app/routes/'.length);
    if (!/\.[cm]?[jt]sx?$/.test(rest)) return undefined;
    rest = rest.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/route$/, '');
    const segments: string[] = [];
    for (const raw of rest.split(/[/.]/)) {
        const s = raw.replace(/^\((.+)\)$/, '$1');
        if (!s || s === 'index' || s === '_index' || s.startsWith('_')) continue;
        if (s === '$') segments.push('*');
        else if (s.startsWith('$')) segments.push(`:${s.slice(1).replace(/_$/, '')}`);
        else segments.push(s.replace(/_$/, '').replace(/^\[(.+)\]$/, '$1'));
    }
    return route(segments);
}

const exportsName = (text: string, name: string) =>
    new RegExp(`\\bexport (?:async )?(?:function|const|let|var) ${name}\\b`).test(text) || new RegExp(`\\bexport \\{[^}\\n]{0,300}\\b${name}\\b`).test(text);

function remixRoutes(path: string, text: string, files: ReadonlySet<string>): string[] {
    const r = remixRoute(path, files);
    if (!r) return [];
    return exportsName(text, 'action') ? [`GET ${r}`, `POST ${r}`] : [`GET ${r}`];
}

function graphqlRoutes(text: string): string[] {
    return text.includes('@Resolver(') && /@(Query|Mutation|Subscription|ResolveField)\(/.test(text) ? ['POST /graphql'] : [];
}

function fastifyRoutes(text: string): string[] {
    const out: string[] = [];
    let at = text.indexOf('.route(');
    for (let n = 0; at >= 0 && n < 50; n++, at = text.indexOf('.route(', at + 7)) {
        const window = text.slice(at, at + 600);
        const method = /\bmethod ?: ?\[? ?['"`]([A-Za-z]{3,7})['"`]/.exec(window)?.[1];
        const url = /\b(?:url|path) ?: ?['"`](\/[^'"`\n]{0,200})['"`]/.exec(window)?.[1];
        if (method && url) out.push(`${method.toUpperCase()} ${url}`);
    }
    return out;
}

/** The identifier right before the `.` at `dot`, read backward over at most 40 characters. */
function receiverBefore(text: string, dot: number): string {
    let i = dot;
    while (i > 0 && dot - i < 40 && /[\w$]/.test(text[i - 1])) i--;
    return text.slice(i, dot);
}

function genericRoutes(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(HTTP_CALL)) {
        // A query string is a request being sent, not a route being declared.
        if (!SERVER_RECEIVER.test(receiverBefore(text, m.index ?? 0)) || m[3].includes('?')) continue;
        out.push(`${m[1].toUpperCase()} ${m[3]}`);
        if (out.length >= ROUTE_LIMITS.routesPerFile) break;
    }
    return out;
}

function extractorRoutes(path: string, text: string): string[] {
    const decls = text.split('\n').filter((l) => DECL_LINE.test(l)).length;
    const controllers = text.split('@Controller(').length - 1;
    // Without a patch every declared route of the file comes back.
    if (decls > ROUTE_LIMITS.extractorDecls || controllers > ROUTE_LIMITS.extractorControllers) return [];
    return extractEntryPoints([{ path, content: text }])
        .filter((e) => e.kind === 'http_route')
        .map((e) => e.id);
}

/**
 * The routes (`METHOD /path`) a JS/TS file declares, by its path and its
 * text, in a fixed order; [] when none. `files` is the tree: the file-system
 * routers count only beside their framework's marker (next.config, app/root).
 */
export function routesOf(path: string, text: string, files: ReadonlySet<string>): string[] {
    if (posix.basename(path).endsWith('.d.ts')) return [];
    const src = normalizedSource(text);
    const page = nextPageRoute(path, files);
    const found = [...extractorRoutes(path, src), ...(page ? [`GET ${page}`] : []), ...remixRoutes(path, src, files), ...graphqlRoutes(src), ...fastifyRoutes(src), ...genericRoutes(src)];
    return [...new Set(found)].slice(0, ROUTE_LIMITS.routesPerFile);
}
