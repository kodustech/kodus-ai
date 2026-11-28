import ts from 'typescript';

import type { RouteDecl } from './extract';

// A changed line outside every handler of a route file: which handlers does it
// reach? The top-level statement it sits in declares names (a helper
// function, a constant, an import, a method of the controller); the handlers
// whose code uses one of them, directly or through other helpers of the file,
// are reached, and nothing else is. Statements that run at load (app.use, a
// middleware, an if at the top level) or names the file cannot follow can
// reach every route, as before (planner-eval.md P5). A constant whose
// initializer calls code at load (`const limiter = app.use(rateLimit(…))`)
// is one of them.

export interface HelperReach {
    /** The line can reach every route of the file. */
    all: boolean;
    handlers: RouteDecl[];
    /** A name the change declares leaves the file (export, module.exports): its routes elsewhere are the planner's to find. */
    exported: boolean;
}

/** Names followed per change before the answer falls back to every route. */
const MAX_NAMES = 50;

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function bindingNames(name: ts.BindingName, out: string[]): void {
    if (ts.isIdentifier(name)) out.push(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

const isExported = (s: ts.Statement) => !!ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * The names a top-level statement declares at `line`, and the node that
 * declares them (a class member for a class); undefined when it declares
 * none the file can follow.
 */
function namesAt(sf: ts.SourceFile, s: ts.Statement, line: number): { names: string[]; node: ts.Node } | undefined {
    const names = declaredAt(sf, s, line);
    if (!names) return undefined;
    const member = ts.isClassDeclaration(s) ? s.members.find((m) => lineOf(sf, m.getStart(sf)) <= line && line <= lineOf(sf, m.getEnd())) : undefined;
    return { names, node: member ?? s };
}

function declaredAt(sf: ts.SourceFile, s: ts.Statement, line: number): string[] | undefined {
    if (ts.isImportDeclaration(s)) {
        const c = s.importClause;
        if (!c) return undefined;
        const out: string[] = [];
        if (c.name) out.push(c.name.text);
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) out.push(b.name.text);
        if (b && ts.isNamedImports(b)) b.elements.forEach((e) => out.push(e.name.text));
        return out.length ? out : undefined;
    }
    if (ts.isFunctionDeclaration(s)) return s.name ? [s.name.text] : undefined;
    if (ts.isVariableStatement(s)) {
        // An initializer that calls code at load (app.use(...), new Store(...)) acts on every route, whoever reads the name.
        if (s.declarationList.declarations.some((d) => d.initializer && runsAtLoad(d.initializer))) return undefined;
        const out: string[] = [];
        s.declarationList.declarations.forEach((d) => bindingNames(d.name, out));
        return out.length ? out : undefined;
    }
    if (ts.isClassDeclaration(s)) {
        // A member of the class (a helper method of a controller): its name, as `this.name` uses it.
        const member = s.members.find((m) => lineOf(sf, m.getStart(sf)) <= line && line <= lineOf(sf, m.getEnd()));
        if (member && (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isGetAccessor(member)) && member.name && ts.isIdentifier(member.name)) {
            return [member.name.text];
        }
        return undefined;
    }
    if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) return [s.name.text];
    return undefined;
}

/** `require('x')`: a module import written as a call, followed by its names like an import. */
const isRequire = (n: ts.CallExpression) => ts.isIdentifier(n.expression) && n.expression.text === 'require' && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0]);

/**
 * Whether an expression calls code when the module loads: a call, a `new`, a
 * tagged template or an await outside every function body it holds. A
 * function or class it only defines runs when called, and a `require` is an
 * import.
 */
function runsAtLoad(node: ts.Node): boolean {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    if (ts.isCallExpression(node) && !isRequire(node)) return true;
    if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isAwaitExpression(node)) return true;
    return !!node.forEachChild((c) => (runsAtLoad(c) ? true : undefined));
}

/** `module.exports = …` or `exports.x = …`: the statement hands names to other files. */
const exportsStatement = (s: ts.Statement, sf: ts.SourceFile) => ts.isExpressionStatement(s) && /^(module\.)?exports\b/.test(s.getText(sf));

/**
 * The handlers the changed `lines` (outside every handler) reach, or
 * undefined when a line sits where no name can be followed.
 */
export function helperReach(sf: ts.SourceFile, lines: number[], decls: RouteDecl[]): HelperReach | undefined {
    const handlerAt = (line: number) => {
        const owners = decls.filter((d) => d.line <= line);
        const owner = owners[owners.length - 1];
        return owner && owner.endLine !== undefined && line <= owner.endLine ? owner : undefined;
    };
    const statementAt = (line: number) => sf.statements.find((s) => lineOf(sf, s.getStart(sf)) <= line && line <= lineOf(sf, s.getEnd()));
    const identifiers: ts.Identifier[] = [];
    const collect = (n: ts.Node) => {
        if (ts.isIdentifier(n)) identifiers.push(n);
        n.forEachChild(collect);
    };
    collect(sf);

    const handlers = new Map<string, RouteDecl>();
    let exported = false;
    const queue: { names: string[]; from: ts.Node }[] = [];
    for (const line of lines) {
        const s = statementAt(line);
        if (!s) return undefined;
        const declared = namesAt(sf, s, line);
        if (!declared) return { all: true, handlers: [], exported: false };
        // A member of an exported class (a controller's helper method) is the class's own business.
        if (isExported(s) && declared.node === s) exported = true;
        queue.push({ names: declared.names, from: declared.node });
    }
    const seen = new Set<string>();
    while (queue.length) {
        const { names, from } = queue.shift()!;
        for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            if (seen.size > MAX_NAMES) return { all: true, handlers: [], exported: false };
            for (const id of identifiers) {
                if (id.text !== name) continue;
                const at = id.getStart(sf);
                if (from.getStart(sf) <= at && at < from.getEnd()) continue;
                const line = lineOf(sf, at);
                const handler = handlerAt(line);
                if (handler) {
                    handlers.set(`${handler.method} ${handler.route}`, handler);
                    continue;
                }
                const user = statementAt(line);
                if (!user) continue;
                if (exportsStatement(user, sf) || ts.isExportDeclaration(user) || ts.isExportAssignment(user)) {
                    exported = true;
                    continue;
                }
                const more = namesAt(sf, user, line);
                // Used by code that runs at load (a middleware, app.use, a top-level call): every route.
                if (!more) return { all: true, handlers: [], exported: false };
                if (isExported(user) && more.node === user) exported = true;
                queue.push({ names: more.names, from: more.node });
            }
        }
    }
    return { all: false, handlers: [...handlers.values()], exported };
}
