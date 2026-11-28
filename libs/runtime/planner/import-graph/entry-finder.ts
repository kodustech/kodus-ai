import { posix } from 'path';
import ts from 'typescript';

// The HTTP entry points that reach a changed function, found by parsers (never
// a model). `reach.ts` says which route files import a changed file; this adds
// what a file-level walk cannot: which of those routes calls the changed
// function (a name followed through the imports and the calls of each file on
// the way), the mount prefixes between the route's router and the app, and,
// for a Firebase onRequest export, the URL the functions emulator serves it
// under: /<project>/<region>/<export names joined by "-">/<route>.
// File content is untrusted: every walk and parse here is bounded, and nothing
// of the repository runs.

export const ENTRY_FINDER_LIMITS = {
    /** Route files one changed file keeps, nearest first. */
    routeFiles: 8,
    /** Files one upward walk visits. */
    upNodes: 400,
    /** Import hops of an upward walk. */
    upDepth: 6,
    /** Files read again (parsed) for one changed file. */
    texts: 60,
    /** Syntax nodes visited per file. */
    nodesPerFile: 40_000,
    /** Importers of one file read per level, when looking for the export that names a function. */
    importersPerLevel: 12,
    /** Levels of re-exports followed from a function file to its codebase's index. */
    exportLevels: 4,
    /** Candidates kept per changed file. */
    candidates: 8,
    /** Names a change may seed the walk with. */
    seedNames: 20,
    /** Time one call spends, on top of the reads. */
    millis: 5_000,
} as const;

export interface FinderNode {
    imports: string[];
    routes: string[];
    /** The file declares a Firebase `onRequest` function. */
    http?: true;
}
export type FinderNodes = Map<string, FinderNode | null>;

/** Whether the route's handler reaches the changed function: followed through the code (yes, no) or not followable (unknown). */
export type CallsChanged = 'yes' | 'no' | 'unknown';

export interface EntryCandidate {
    /** `METHOD /path` as the route file declares it. */
    declared: string;
    /** The route as the app serves it, mount prefixes applied; the same as `declared` when no mount was found. */
    route: string;
    /** The file that declares the route. */
    file: string;
    /** Imports between the changed file and the route file. */
    hops: number;
    /** From the changed file up to the route file, and on to the function file when one was found. */
    chain: string[];
    calls: CallsChanged;
    /** The Firebase function that serves the route, when the walk found one. */
    function?: { file: string; exportName: string; region: string };
    /** Path under the functions emulator host: /<project>/<region>/<exportName><route path>. The project is `<project>` when unknown. */
    urlPath?: string;
}

// ---- what one file says -----------------------------------------------------

interface ImportFact {
    local: string;
    /** '*' for a namespace (or a whole `require`), 'default', else the exported name. */
    imported: string;
    spec: string;
}
interface ReexportFact {
    spec: string;
    kind: 'star' | 'ns' | 'named';
    ns?: string;
    names?: { exported: string; imported: string }[];
}
export interface Facts {
    /** Top-level declarations (functions, variables, class members, object members): name to the names its code mentions. */
    fns: Map<string, Set<string>>;
    /** Exported name to the local name that holds it. */
    exports: Map<string, string>;
    reexports: ReexportFact[];
    imports: ImportFact[];
    /** `.use(prefix?, ref)`: a router mounted under a prefix. */
    uses: { prefix: string; ref: string }[];
    /** `METHOD /path` of each route call or decorated method to the names its handler mentions. */
    routes: Map<string, Set<string>>;
    httpExports: { name: string; region?: string; refs: Set<string> }[];
    /** CommonJS exports: names are not followed, so a "no" about this file is not certain. */
    opaque: boolean;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const NEST_METHODS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', All: 'ALL' };

function kindOf(path: string): ts.ScriptKind {
    if (/\.[cm]?tsx$/.test(path)) return ts.ScriptKind.TSX;
    if (/\.[cm]?jsx$/.test(path)) return ts.ScriptKind.JSX;
    if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}

const joinRoute = (...parts: string[]) => {
    const joined = `/${parts.join('/')}`.replace(/\/{2,}/g, '/');
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
};

const stringOf = (n: ts.Node | undefined): string | undefined => (n && ts.isStringLiteralLike(n) ? n.text : undefined);

/** Every identifier under `node` (property names included): the names its code mentions. */
function refsOf(node: ts.Node | undefined, into: Set<string> = new Set(), budget = { left: ENTRY_FINDER_LIMITS.nodesPerFile }): Set<string> {
    if (!node) return into;
    const visit = (n: ts.Node) => {
        if (budget.left-- <= 0) return;
        if (ts.isIdentifier(n)) into.add(n.text);
        ts.forEachChild(n, visit);
    };
    visit(node);
    return into;
}

const addAll = (to: Set<string>, from: Iterable<string>) => {
    for (const x of from) to.add(x);
};

function addFn(fns: Map<string, Set<string>>, name: string, refs: Set<string>) {
    const cur = fns.get(name);
    if (cur) addAll(cur, refs);
    else fns.set(name, refs);
}

const isExportedStatement = (s: ts.Node) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const isDefaultStatement = (s: ts.Node) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** A call of `onRequest(...)` or `<x>.https.onRequest(...)` inside `init`. */
function onRequestCall(init: ts.Node): boolean {
    let found = false;
    const budget = { left: 2_000 };
    const visit = (n: ts.Node) => {
        if (found || budget.left-- <= 0) return;
        if (ts.isCallExpression(n)) {
            const c = n.expression;
            if ((ts.isIdentifier(c) && c.text === 'onRequest') || (ts.isPropertyAccessExpression(c) && c.name.text === 'onRequest')) found = true;
        }
        ts.forEachChild(n, visit);
    };
    visit(init);
    return found;
}

function regionOf(init: ts.Node, source: string): string | undefined {
    const text = source.slice(init.getStart(), Math.min(init.getEnd(), init.getStart() + 600));
    return /\bregion\(\s*['"`]([\w-]+)['"`]/.exec(text)?.[1] ?? /\bregion\s*:\s*['"`]([\w-]+)['"`]/.exec(text)?.[1];
}

/** What the code of one file says about names, imports, routes and Firebase exports. Never throws. */
export function parseFacts(path: string, text: string): Facts {
    const facts: Facts = { fns: new Map(), exports: new Map(), reexports: [], imports: [], uses: [], routes: new Map(), httpExports: [], opaque: /\bmodule\.exports\b|(^|[^\w.])exports\.\w+\s*=/.test(text) };
    let sf: ts.SourceFile;
    try {
        sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
    } catch {
        facts.opaque = true;
        return facts;
    }
    for (const s of sf.statements) {
        if (ts.isImportDeclaration(s)) {
            const spec = stringOf(s.moduleSpecifier);
            const c = s.importClause;
            if (!spec || !c) continue;
            if (c.name) facts.imports.push({ local: c.name.text, imported: 'default', spec });
            const b = c.namedBindings;
            if (b && ts.isNamespaceImport(b)) facts.imports.push({ local: b.name.text, imported: '*', spec });
            if (b && ts.isNamedImports(b)) for (const e of b.elements) facts.imports.push({ local: e.name.text, imported: (e.propertyName ?? e.name).text, spec });
        } else if (ts.isExportDeclaration(s)) {
            const spec = stringOf(s.moduleSpecifier);
            const clause = s.exportClause;
            if (spec) {
                if (!clause) facts.reexports.push({ spec, kind: 'star' });
                else if (ts.isNamespaceExport(clause)) facts.reexports.push({ spec, kind: 'ns', ns: clause.name.text });
                else facts.reexports.push({ spec, kind: 'named', names: clause.elements.map((e) => ({ exported: e.name.text, imported: (e.propertyName ?? e.name).text })) });
            } else if (clause && ts.isNamedExports(clause)) {
                for (const e of clause.elements) facts.exports.set(e.name.text, (e.propertyName ?? e.name).text);
            }
        } else if (ts.isExportAssignment(s)) {
            const local = ts.isIdentifier(s.expression) ? s.expression.text : 'default';
            if (local === 'default') addFn(facts.fns, 'default', refsOf(s.expression));
            facts.exports.set('default', local);
        } else if (ts.isFunctionDeclaration(s)) {
            const name = s.name?.text ?? (isDefaultStatement(s) ? 'default' : undefined);
            if (!name) continue;
            addFn(facts.fns, name, refsOf(s));
            if (isExportedStatement(s)) facts.exports.set(isDefaultStatement(s) ? 'default' : name, name);
        } else if (ts.isClassDeclaration(s)) {
            const name = s.name?.text ?? (isDefaultStatement(s) ? 'default' : undefined);
            for (const m of s.members) if (m.name && ts.isIdentifier(m.name)) addFn(facts.fns, m.name.text, refsOf(m));
            if (name && isExportedStatement(s)) facts.exports.set(isDefaultStatement(s) ? 'default' : name, name);
            if (name && !facts.fns.has(name)) facts.fns.set(name, new Set());
            nestRoutes(s, facts);
        } else if (ts.isVariableStatement(s)) {
            const exported = isExportedStatement(s);
            for (const d of s.declarationList.declarations) {
                const init = d.initializer;
                if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' && stringOf(init.arguments[0])) {
                    const spec = stringOf(init.arguments[0])!;
                    if (ts.isIdentifier(d.name)) facts.imports.push({ local: d.name.text, imported: '*', spec });
                    else if (ts.isObjectBindingPattern(d.name)) for (const e of d.name.elements) if (ts.isIdentifier(e.name)) facts.imports.push({ local: e.name.text, imported: (e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName : e.name).text, spec });
                    continue;
                }
                if (!ts.isIdentifier(d.name)) continue;
                const name = d.name.text;
                addFn(facts.fns, name, refsOf(init));
                if (init && ts.isObjectLiteralExpression(init)) {
                    for (const p of init.properties) if (p.name && ts.isIdentifier(p.name)) addFn(facts.fns, p.name.text, refsOf(p));
                }
                if (exported) {
                    facts.exports.set(name, name);
                    if (init && onRequestCall(init)) facts.httpExports.push({ name, region: regionOf(init, sf.text), refs: refsOf(init) });
                }
            }
        }
    }
    const budget = { left: ENTRY_FINDER_LIMITS.nodesPerFile };
    const visit = (n: ts.Node) => {
        if (budget.left-- <= 0) return;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const method = n.expression.name.text;
            const first = stringOf(n.arguments[0]);
            if (HTTP_METHODS.has(method) && first?.startsWith('/')) {
                const key = `${method.toUpperCase()} ${first}`;
                const refs = facts.routes.get(key) ?? new Set<string>();
                n.arguments.slice(1).forEach((a) => refsOf(a, refs));
                facts.routes.set(key, refs);
            } else if (method === 'use' && n.arguments.length) {
                const last = n.arguments[n.arguments.length - 1];
                if (ts.isIdentifier(last)) facts.uses.push({ prefix: first ?? '', ref: last.text });
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return facts;
}

/** `@Controller('p')` with `@Get('x')` methods: route `GET /p/x` to what the method's code mentions. */
function nestRoutes(cls: ts.ClassDeclaration, facts: Facts) {
    const decorators = (n: ts.Node) => (ts.canHaveDecorators(n) ? (ts.getDecorators(n) ?? []) : []);
    const callOf = (d: ts.Decorator) => (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) ? { name: d.expression.expression.text, arg: stringOf(d.expression.arguments[0]) } : undefined);
    const controller = decorators(cls).map(callOf).find((c) => c?.name === 'Controller');
    if (!controller) return;
    for (const m of cls.members) {
        for (const d of decorators(m)) {
            const c = callOf(d);
            const method = c ? NEST_METHODS[c.name] : undefined;
            if (c && method) facts.routes.set(`${method} ${joinRoute(controller.arg ?? '', c.arg ?? '')}`, refsOf(m));
        }
    }
}

// ---- which names a change reaches ------------------------------------------

/**
 * The top-level names a change at `lines` of a file sits in: a function, a
 * variable, a method of a class or a function of an object. `undefined` when
 * none is found (changed lines only in imports or statements that run at
 * load): the change then reaches whatever imports the file.
 */
export function changedNamesOf(path: string, text: string, lines: readonly number[]): string[] | undefined {
    if (!lines.length) return undefined;
    let sf: ts.SourceFile;
    try {
        sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
    } catch {
        return undefined;
    }
    const span = (n: ts.Node) => ({ from: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, to: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1 });
    const hit = (n: ts.Node) => {
        const { from, to } = span(n);
        return lines.some((l) => l >= from && l <= to);
    };
    const names = new Set<string>();
    for (const s of sf.statements) {
        if (!hit(s)) continue;
        if (ts.isFunctionDeclaration(s) && s.name) {
            names.add(s.name.text);
        } else if (ts.isClassDeclaration(s)) {
            const members = s.members.filter((m) => m.name && ts.isIdentifier(m.name) && hit(m));
            members.forEach((m) => names.add((m.name as ts.Identifier).text));
            if (!members.length && s.name) names.add(s.name.text);
        } else if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
                if (!hit(d) || !ts.isIdentifier(d.name)) continue;
                const members = d.initializer && ts.isObjectLiteralExpression(d.initializer) ? d.initializer.properties.filter((p) => p.name && ts.isIdentifier(p.name) && hit(p)) : [];
                if (members.length) members.forEach((p) => names.add((p.name as ts.Identifier).text));
                else names.add(d.name.text);
            }
        }
    }
    return names.size ? [...names].slice(0, ENTRY_FINDER_LIMITS.seedNames) : undefined;
}

/** The names that reach `seeds` inside one file: a declaration whose code mentions a name already in the set joins it. */
function closure(facts: Facts, seeds: ReadonlySet<string>): Set<string> {
    const names = new Set(seeds);
    for (let again = true, rounds = 0; again && rounds < 50; rounds++) {
        again = false;
        for (const [name, refs] of facts.fns) {
            if (names.has(name)) continue;
            for (const r of refs) {
                if (names.has(r)) {
                    names.add(name);
                    again = true;
                    break;
                }
            }
        }
    }
    return names;
}

const exportsOf = (facts: Facts, names: ReadonlySet<string>) => new Set([...facts.exports].filter(([, local]) => names.has(local)).map(([exported]) => exported));

type Resolve = (spec: string, from: string) => string | undefined;

/**
 * Follow `seed` (names the change sits in, in `chain[0]`) up the chain of
 * importers to its last file; the names that reach each file at the end, or
 * `dead` when an importer on the way does not use any of them.
 */
export function followNames(chain: readonly string[], facts: ReadonlyMap<string, Facts>, seed: readonly string[], resolve: Resolve): { names: Set<string>; dead: boolean; opaque: boolean } | undefined {
    const first = facts.get(chain[0]);
    if (!first) return undefined;
    let names = closure(first, new Set(seed));
    let exported = exportsOf(first, names);
    let opaque = first.opaque;
    for (let i = 1; i < chain.length; i++) {
        const f = facts.get(chain[i]);
        if (!f) return undefined;
        opaque ||= f.opaque;
        const from = chain[i - 1];
        const seeds = new Set<string>();
        for (const imp of f.imports) {
            if (resolve(imp.spec, chain[i]) !== from) continue;
            if (imp.imported === '*') {
                if (exported.size) (seeds.add(imp.local), addAll(seeds, exported));
            } else if (exported.has(imp.imported)) seeds.add(imp.local);
        }
        const through = new Set<string>();
        for (const re of f.reexports) {
            if (resolve(re.spec, chain[i]) !== from) continue;
            if (re.kind === 'star') addAll(through, exported);
            else if (re.kind === 'ns') exported.size && through.add(re.ns!);
            else for (const n of re.names ?? []) if (exported.has(n.imported)) through.add(n.exported);
        }
        if (!seeds.size && !through.size) return { names: new Set(), dead: true, opaque };
        names = closure(f, seeds);
        exported = new Set([...exportsOf(f, names), ...through]);
    }
    return { names, dead: false, opaque };
}

// ---- walking the graph ------------------------------------------------------

interface Visit {
    parent: string | undefined;
    hops: number;
}

/** Importers breadth first from `start`; `stopAt` files are kept but not passed through. */
function walkUp(start: string, rev: ReadonlyMap<string, string[]>, opts: { stopAt?: (f: string, hops: number) => boolean; depth: number; nodes: number }): Map<string, Visit> {
    const seen = new Map<string, Visit>([[start, { parent: undefined, hops: 0 }]]);
    let frontier = [start];
    for (let hops = 1; hops <= opts.depth && frontier.length && seen.size < opts.nodes; hops++) {
        const next: string[] = [];
        for (const f of frontier) {
            for (const importer of [...(rev.get(f) ?? [])].sort()) {
                if (seen.has(importer) || seen.size >= opts.nodes) continue;
                seen.set(importer, { parent: f, hops });
                if (!opts.stopAt?.(importer, hops)) next.push(importer);
            }
        }
        frontier = next;
    }
    return seen;
}

const chainTo = (file: string, seen: ReadonlyMap<string, Visit>): string[] => {
    const out: string[] = [];
    for (let f: string | undefined = file; f !== undefined && out.length < 50; f = seen.get(f)?.parent) out.push(f);
    return out.reverse();
};

export interface FindEntriesInput {
    target: string;
    /** The target at the head and the new-side lines the change touches; absent: no name is followed. */
    head?: { text: string; lines: readonly number[] };
    nodes: FinderNodes;
    rev: ReadonlyMap<string, string[]>;
    /** Route files with this many imports, two or more hops away, are app roots that say nothing about the target. */
    hubImports: number;
    depth: number;
    nodesLimit: number;
    read: (paths: string[]) => Promise<Map<string, string | null>>;
    resolve: Resolve;
    /** The Firebase project id (`.firebaserc`), when known. */
    project?: string;
    outOfTime?: () => boolean;
}

const rank = (c: EntryCandidate) => [c.calls === 'yes' ? 0 : c.calls === 'unknown' ? 1 : 2, c.hops, c.chain.length] as const;

/**
 * The routes that reach `target`, the one whose handler calls the changed
 * function first, then nearest first; with the Firebase URL when the route's
 * app is an onRequest export. Never throws: [] when nothing is found.
 */
export async function findEntries(input: FindEntriesInput): Promise<EntryCandidate[]> {
    try {
        return await find(input);
    } catch {
        return [];
    }
}

async function find(input: FindEntriesInput): Promise<EntryCandidate[]> {
    const { target, nodes, rev } = input;
    const L = ENTRY_FINDER_LIMITS;
    const started = Date.now();
    const outOfTime = () => Date.now() - started > L.millis || input.outOfTime?.() === true;
    const declares = (f: string) => (nodes.get(f)?.routes.length ?? 0) > 0;
    const up = walkUp(target, rev, {
        depth: input.depth,
        nodes: input.nodesLimit,
        stopAt: declares,
    });
    const hub = (f: string, hops: number) => hops > 1 && (nodes.get(f)?.imports.length ?? 0) >= input.hubImports;
    const routeFiles = [...up]
        .filter(([f, v]) => declares(f) && !hub(f, v.hops))
        .sort((a, b) => a[1].hops - b[1].hops || (a[0] < b[0] ? -1 : 1))
        .slice(0, L.routeFiles)
        .map(([f]) => f);
    if (!routeFiles.length) return [];

    const texts = new Map<string, string | null>();
    if (input.head) texts.set(target, input.head.text);
    const load = async (paths: Iterable<string>) => {
        const missing = [...new Set(paths)].filter((p) => !texts.has(p)).slice(0, Math.max(0, L.texts - texts.size));
        if (!missing.length || outOfTime()) return;
        for (const [p, t] of await input.read(missing)) texts.set(p, t);
    };
    const factsMemo = new Map<string, Facts>();
    const factsOf = (f: string) => {
        const hit = factsMemo.get(f);
        if (hit) return hit;
        const t = texts.get(f);
        if (t == null) return undefined;
        const parsed = parseFacts(f, t);
        factsMemo.set(f, parsed);
        return parsed;
    };

    const chains = new Map(routeFiles.map((r) => [r, chainTo(r, up)]));
    await load([...chains.values()].flat());
    const seed = input.head ? changedNamesOf(target, input.head.text, input.head.lines) : undefined;
    const out: EntryCandidate[] = [];
    for (const r of routeFiles) {
        if (outOfTime()) break;
        const chain = chains.get(r)!;
        const routes = nodes.get(r)?.routes ?? [];
        const followed = seed ? followNames(chain, new Map(chain.flatMap((f) => (factsOf(f) ? [[f, factsOf(f)!] as const] : []))), seed, input.resolve) : undefined;
        const rf = factsOf(r);
        const serving = await servingOf(r, input, load, factsOf, outOfTime);
        for (const declared of routes) {
            const refs = rf?.routes.get(declared);
            const calls: CallsChanged = !followed || !refs ? 'unknown' : [...refs].some((n) => followed.names.has(n)) ? 'yes' : followed.opaque ? 'unknown' : 'no';
            const mount = serving?.mounts ?? '';
            const [method, path] = [declared.slice(0, declared.indexOf(' ')), declared.slice(declared.indexOf(' ') + 1)];
            const served = serving ? joinRoute(mount, path) : path;
            out.push({
                declared,
                route: `${method} ${served}`,
                file: r,
                hops: up.get(r)!.hops,
                chain: serving ? [...chain, ...serving.chain.slice(1)] : chain,
                calls,
                ...(serving?.fn ? { function: serving.fn, urlPath: `/${input.project ?? '<project>'}/${serving.fn.region}/${serving.fn.exportName}${served === '/' ? '' : served}` } : {}),
            });
        }
    }
    return out
        .sort((a, b) => {
            const [x, y] = [rank(a), rank(b)];
            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
        })
        .slice(0, L.candidates);
}

interface Serving {
    /** Mount prefixes between the route file and the app, outermost first, joined. */
    mounts: string;
    chain: string[];
    fn?: { file: string; exportName: string; region: string };
}

/** The Firebase function that serves a route file's router, through the mounts between them. */
async function servingOf(route: string, input: FindEntriesInput, load: (p: Iterable<string>) => Promise<void>, factsOf: (f: string) => Facts | undefined, outOfTime: () => boolean): Promise<Serving | undefined> {
    const L = ENTRY_FINDER_LIMITS;
    const http = (f: string) => nodes(f)?.http === true;
    const nodes = (f: string) => input.nodes.get(f);
    const up = walkUp(route, input.rev, { depth: input.depth, nodes: L.upNodes, stopAt: http });
    const fnFile = [...up].filter(([f]) => http(f)).sort((a, b) => a[1].hops - b[1].hops || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    if (!fnFile || outOfTime()) return undefined;
    const chain = chainTo(fnFile, up);
    await load(chain);
    const mounts: string[] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
        const parent = factsOf(chain[i + 1]);
        const locals = new Set((parent?.imports ?? []).filter((imp) => input.resolve(imp.spec, chain[i + 1]) === chain[i]).map((imp) => imp.local));
        mounts.unshift(parent?.uses.find((u) => locals.has(u.ref))?.prefix ?? '');
    }
    const ff = factsOf(fnFile);
    if (!ff?.httpExports.length) return undefined;
    const prev = chain.length > 1 ? chain[chain.length - 2] : undefined;
    const locals = new Set((ff.imports ?? []).filter((imp) => prev && input.resolve(imp.spec, fnFile) === prev).map((imp) => imp.local));
    const exp = ff.httpExports.find((e) => [...e.refs].some((r) => locals.has(r))) ?? ff.httpExports[0];
    const exportName = await exportedAs(fnFile, exp.name, input, load, factsOf, outOfTime);
    return { mounts: joinRoute(...mounts), chain, fn: { file: fnFile, exportName, region: exp.region ?? 'us-central1' } };
}

/**
 * The name the Firebase CLI deploys an export under: its own, with the group a
 * `export * as <group> from` gives it (joined with "-"), through re-exports up
 * to the codebase's index.
 */
async function exportedAs(file: string, name: string, input: FindEntriesInput, load: (p: Iterable<string>) => Promise<void>, factsOf: (f: string) => Facts | undefined, outOfTime: () => boolean): Promise<string> {
    const L = ENTRY_FINDER_LIMITS;
    const names = [name];
    let at = file;
    for (let level = 0; level < L.exportLevels && !outOfTime(); level++) {
        const importers = [...(input.rev.get(at) ?? [])].sort((a, b) => Number(posix.basename(b).startsWith('index.')) - Number(posix.basename(a).startsWith('index.')) || (a < b ? -1 : 1)).slice(0, L.importersPerLevel);
        await load(importers);
        let moved = false;
        for (const imp of importers) {
            const f = factsOf(imp);
            const re = f?.reexports.find((r) => input.resolve(r.spec, imp) === at && (r.kind !== 'named' || r.names?.some((n) => n.imported === names[names.length - 1])));
            if (!f || !re) continue;
            if (re.kind === 'ns') names.unshift(re.ns!);
            else if (re.kind === 'named') names[names.length - 1] = re.names!.find((n) => n.imported === names[names.length - 1])!.exported;
            at = imp;
            moved = true;
            break;
        }
        if (!moved) break;
    }
    return names.join('-');
}
