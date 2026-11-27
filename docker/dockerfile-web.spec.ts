/**
 * The web image builds from a context that holds apps/web and only the libs
 * Dockerfile.web copies one by one. An `@libs/*` import the Dockerfile does
 * not copy builds in dev and in CI tests, then fails only in `next build`
 * inside the image ("Module not found"), which is how #2702 broke the web
 * image of main without any check going red.
 *
 * Only runtime imports count: the build erases type-only ones and skips type
 * checks (apps/web/next.config, `ignoreBuildErrors`). A lib file the web
 * reaches is followed into its own runtime imports, since those must be in
 * the image too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, posix, relative } from 'path';
import * as ts from 'typescript';

const ROOT = join(__dirname, '..');

function webSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return name === 'node_modules' || name === '__tests__'
                ? []
                : webSourceFiles(path);
        }
        // Tests may import any lib: they never run inside the image.
        return /\.tsx?$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)
            ? [path]
            : [];
    });
}

function onlyTypes(clause: ts.ImportClause): boolean {
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
        !clause.name &&
        !!bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
    );
}

/** Module specifiers the file needs at runtime, comments and strings aside. */
export function runtimeImports(path: string, text?: string): string[] {
    const source = ts.createSourceFile(
        path,
        text ?? readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            !(node.importClause && onlyTypes(node.importClause))
        ) {
            found.push(node.moduleSpecifier.text);
        } else if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            !node.isTypeOnly
        ) {
            found.push(node.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) &&
                    node.expression.text === 'require')) &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            found.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** The repo file a lib specifier lands on, as a repo-relative posix path. */
function resolveLib(specifier: string, fromFile?: string): string | undefined {
    let base: string;
    if (specifier.startsWith('@libs/')) {
        base = join(ROOT, 'libs', specifier.slice('@libs/'.length));
    } else if (specifier.startsWith('.') && fromFile) {
        base = join(fromFile, '..', specifier);
    } else {
        return undefined; // a package from node_modules
    }
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.json`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
    ];
    const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    return file && relative(ROOT, file).split('\\').join('/');
}

/** Every lib file the web needs at runtime, with the file that pulls it in. */
function libFilesTheWebNeeds(): Map<string, string> {
    const needed = new Map<string, string>();
    const queue: string[] = [];
    for (const file of webSourceFiles(join(ROOT, 'apps/web/src'))) {
        for (const specifier of runtimeImports(file)) {
            if (!specifier.startsWith('@libs/')) continue;
            const lib = resolveLib(specifier) ?? `libs/${specifier.slice(6)}`;
            if (!needed.has(lib)) {
                needed.set(lib, relative(ROOT, file));
                queue.push(lib);
            }
        }
    }
    while (queue.length > 0) {
        const lib = queue.shift() as string;
        if (!/\.tsx?$/.test(lib) || !existsSync(join(ROOT, lib))) continue;
        for (const specifier of runtimeImports(join(ROOT, lib))) {
            const next = resolveLib(specifier, join(ROOT, lib));
            if (next && next.startsWith('libs/') && !needed.has(next)) {
                needed.set(next, lib);
                queue.push(next);
            }
        }
    }
    return needed;
}

/**
 * Lib paths the image holds where the web build looks for them: copied from
 * `libs/...` to the same path under the build's working directory.
 */
function copiedLibs(): string[] {
    const dockerfile = readFileSync(
        join(ROOT, 'docker/Dockerfile.web'),
        'utf8',
    );
    return [...dockerfile.matchAll(/^COPY\s+(libs\/\S+)\s+(\S+)\s*$/gm)]
        .filter(
            ([, from, to]) =>
                posix.normalize(to).replace(/\/$/, '') ===
                posix.normalize(from).replace(/\/$/, ''),
        )
        .map(([, from]) => posix.normalize(from).replace(/\/$/, ''));
}

describe('docker/Dockerfile.web', () => {
    it('copies every lib file the web needs at runtime, to where the build resolves it', () => {
        const copied = copiedLibs();
        const missing = [...libFilesTheWebNeeds()]
            .filter(
                ([lib]) =>
                    !copied.some(
                        (path) => lib === path || lib.startsWith(`${path}/`),
                    ),
            )
            .map(([lib, by]) => `${lib} (needed by ${by})`);

        expect(missing).toEqual([]);
    });
});

describe('runtimeImports', () => {
    const imports = (text: string) => runtimeImports('x.tsx', text);

    it('reads every form that loads a module at runtime', () => {
        expect(
            imports(`
                import a from '@libs/a';
                import { b } from '@libs/b';
                import '@libs/side-effect';
                export { c } from '@libs/c';
                export * from '@libs/d';
                const e = await import('@libs/e');
                const f = require('@libs/f');
            `),
        ).toEqual([
            '@libs/a',
            '@libs/b',
            '@libs/side-effect',
            '@libs/c',
            '@libs/d',
            '@libs/e',
            '@libs/f',
        ]);
    });

    it('leaves out what the build erases, comments and strings', () => {
        expect(
            imports(`
                import type { A } from '@libs/type-only';
                import { type B, type C } from '@libs/inline-types';
                export type { D } from '@libs/type-export';
                // import x from '@libs/in-a-comment';
                const s = "import y from '@libs/in-a-string'";
            `),
        ).toEqual([]);
    });

    it('keeps a value imported next to types', () => {
        expect(imports(`import { type A, b } from '@libs/mixed';`)).toEqual([
            '@libs/mixed',
        ]);
    });
});
