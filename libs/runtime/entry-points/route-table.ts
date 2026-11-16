import ts from 'typescript';

import { ANY_METHOD } from './coverage';
import type { RouteDecl } from './extract';
import { parseSource } from './no-effect';

// A route table file (`app/routes.ts`) declares the routes of a Remix or
// React Router app in one place:
// - Remix 3 (`remix/routes`, @remix-run/fetch-router): `route({...})` maps
//   names to patterns. A plain string serves any method; `get('/x')`,
//   `post`, `put`, `del`… one; `form('x')` a GET and a POST (or its
//   `formMethod`); `resources('x', {only, exclude, param})` the REST set;
//   `resource('x')` the singleton set; `route('prefix', {...})` nests under
//   a prefix (github.com/remix-run/remix, packages/fetch-router README).
// - React Router v7 (`@react-router/dev/routes`): `route('path', file,
//   [children])`, `index(file)`, `layout(file, [children])`,
//   `prefix('p', [children])` (reactrouter.com, "Routing").
// Each route's declaration is its property or call, so a changed line inside
// one reaches that route.

const TABLE_FILE = /(^|\/)routes\.[cm]?[jt]sx?$/;
const REMIX_MODULES = new Set(['remix/routes', '@remix-run/fetch-router', '@remix-run/fetch-router/routes']);
const REACT_ROUTER_MODULES = new Set(['@react-router/dev/routes']);
const METHOD_HELPERS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE', head: 'HEAD', options: 'OPTIONS' };
const MAX_ROUTES = 150;

const join = (prefix: string, path: string) => '/' + [prefix, path].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** REST actions of `resources('x')`: [action, method, suffix after the collection, with `:param`]. */
const COLLECTION: [string, string, string][] = [
    ['index', 'GET', ''],
    ['new', 'GET', 'new'],
    ['show', 'GET', ':param'],
    ['create', 'POST', ''],
    ['edit', 'GET', ':param/edit'],
    ['update', 'PUT', ':param'],
    ['destroy', 'DELETE', ':param'],
];
const SINGLETON: [string, string, string][] = [
    ['new', 'GET', 'new'],
    ['show', 'GET', ''],
    ['create', 'POST', ''],
    ['edit', 'GET', 'edit'],
    ['update', 'PUT', ''],
    ['destroy', 'DELETE', ''],
];

const textOf = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
const unwrap = (n: ts.Expression): ts.Expression =>
    ts.isSatisfiesExpression(n) || ts.isAsExpression(n) || ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;

function optionsOf(n: ts.Node | undefined): Map<string, ts.Expression> {
    const out = new Map<string, ts.Expression>();
    if (n && ts.isObjectLiteralExpression(n))
        for (const p of n.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.set(p.name.text, p.initializer);
    return out;
}
const stringsOf = (n: ts.Expression | undefined) => (n && ts.isArrayLiteralExpression(n) ? n.elements.map(textOf).filter((s): s is string => !!s) : undefined);

/** The routes a route table file declares, or undefined when the file is not one. */
export function routeTableRoutes(path: string, content: string): RouteDecl[] | undefined {
    if (!TABLE_FILE.test(path)) return undefined;
    const sf = parseSource(path, content);
    if (!sf) return undefined;
    // Local name -> helper name, for the helpers imported from a route table module.
    const helpers = new Map<string, { name: string; flavor: 'remix' | 'rr' }>();
    for (const s of sf.statements) {
        if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
        const flavor = REMIX_MODULES.has(s.moduleSpecifier.text) ? 'remix' : REACT_ROUTER_MODULES.has(s.moduleSpecifier.text) ? 'rr' : undefined;
        const b = s.importClause?.namedBindings;
        if (!flavor || !b || !ts.isNamedImports(b)) continue;
        for (const e of b.elements) helpers.set(e.name.text, { name: (e.propertyName ?? e.name).text, flavor });
    }
    if (!helpers.size) return undefined;
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const out: RouteDecl[] = [];
    const add = (method: string, route: string, at: ts.Node) => {
        if (out.length < MAX_ROUTES) out.push({ line: lineOf(at.getStart(sf)), method, route, endLine: lineOf(at.getEnd()) });
    };
    const helperOf = (n: ts.Node) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? helpers.get(n.expression.text) : undefined);

    // `at`: the node that declares the route (its property in a map), whose lines reach it.
    const walk = (node: ts.Expression, prefix: string, at: ts.Node): void => {
        node = unwrap(node);
        const text = textOf(node);
        if (text !== undefined) return add(ANY_METHOD, join(prefix, text), at);
        if (ts.isArrayLiteralExpression(node)) {
            for (const el of node.elements) walk(ts.isSpreadElement(el) ? el.expression : el, prefix, el);
            return;
        }
        if (ts.isObjectLiteralExpression(node)) {
            const opts = optionsOf(node);
            const method = textOf(opts.get('method'));
            const pattern = textOf(opts.get('pattern'));
            if (method && pattern !== undefined) return add(method.toUpperCase(), join(prefix, pattern), at);
            for (const p of node.properties) if (ts.isPropertyAssignment(p)) walk(p.initializer, prefix, p);
            return;
        }
        const helper = helperOf(node);
        if (!helper || !ts.isCallExpression(node)) return;
        const [a0, a1, a2] = node.arguments;
        const first = textOf(a0);
        if (helper.flavor === 'rr') {
            if (helper.name === 'index') return add(ANY_METHOD, join(prefix, ''), at);
            if (helper.name === 'route' && first !== undefined) {
                add(ANY_METHOD, join(prefix, first), at);
                if (a2) walk(a2, join(prefix, first), at);
                return;
            }
            if (helper.name === 'layout' && a1) return walk(a1, prefix, at);
            if (helper.name === 'prefix' && first !== undefined && a1) return walk(a1, join(prefix, first), at);
            return;
        }
        if (METHOD_HELPERS[helper.name] && first !== undefined) return add(METHOD_HELPERS[helper.name], join(prefix, first), at);
        if (helper.name === 'form' && first !== undefined) {
            add('GET', join(prefix, first), at);
            add((textOf(optionsOf(a1).get('formMethod')) ?? 'POST').toUpperCase(), join(prefix, first), at);
            return;
        }
        if ((helper.name === 'resources' || helper.name === 'resource') && first !== undefined) {
            const opts = optionsOf(a1);
            const only = stringsOf(opts.get('only'));
            const exclude = stringsOf(opts.get('exclude')) ?? [];
            const param = textOf(opts.get('param')) ?? 'id';
            for (const [action, method, suffix] of helper.name === 'resources' ? COLLECTION : SINGLETON) {
                if ((only && !only.includes(action)) || exclude.includes(action)) continue;
                add(method, join(join(prefix, first), suffix.replace(':param', `:${param}`)), at);
            }
            return;
        }
        if (helper.name === 'route') {
            if (first !== undefined && a1) return walk(a1, join(prefix, first), at);
            if (a0) return walk(a0, prefix, at);
        }
    };

    for (const s of sf.statements) {
        if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) if (d.initializer && helperOf(unwrap(d.initializer))) walk(d.initializer, '', d);
        } else if (ts.isExportAssignment(s)) {
            walk(s.expression, '', s);
        }
    }
    return out;
}
