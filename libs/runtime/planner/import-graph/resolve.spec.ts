import { aliasesOf, isWorkspaceDir, packageOf, parseJsonc, type ResolveContext, resolveSpecifier, workspaceGlobsOf } from './resolve';

const ctx = (files: string[], over: Partial<ResolveContext> = {}): ResolveContext => ({ files: new Set(files), aliases: [], packages: [], ...over });
const readerOf = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe('which repository file an import names', () => {
    it('resolves a relative import without an extension to the .ts file', () => {
        expect(resolveSpecifier('./orders.service', 'src/orders/orders.controller.ts', ctx(['src/orders/orders.service.ts']))).toBe('src/orders/orders.service.ts');
    });

    it('resolves a directory import to its index file', () => {
        expect(resolveSpecifier('../lib', 'src/app/main.ts', ctx(['src/lib/index.tsx']))).toBe('src/lib/index.tsx');
    });

    it('resolves an ESM .js specifier to the .ts source beside it', () => {
        expect(resolveSpecifier('./db.js', 'src/server.ts', ctx(['src/db.ts']))).toBe('src/db.ts');
    });

    it('leaves an external package unresolved', () => {
        expect(resolveSpecifier('express', 'src/server.ts', ctx(['express.ts']))).toBeUndefined();
    });

    it('never resolves a relative import above the repository root', () => {
        expect(resolveSpecifier('../../etc/passwd', 'src/a.ts', ctx(['etc/passwd.ts']))).toBeUndefined();
    });

    it('resolves a tsconfig paths alias through the tsconfig nearest the importer', async () => {
        const aliases = [
            (await aliasesOf('tsconfig.json', readerOf({ 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./other/*"]}}}' })))!,
            (await aliasesOf('apps/web/tsconfig.json', readerOf({ 'apps/web/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}' })))!,
        ];
        const files = ['apps/web/src/components/cart.tsx', 'other/components/cart.tsx'];
        expect(resolveSpecifier('@/components/cart', 'apps/web/src/app/page.tsx', ctx(files, { aliases }))).toBe('apps/web/src/components/cart.tsx');
    });

    it('keeps a $ in the part an alias matched literally', async () => {
        const aliases = [(await aliasesOf('tsconfig.json', readerOf({ 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}' })))!];
        // With a string replacement, `$&` would have become the alias's own `*`.
        expect(resolveSpecifier("@/pay$&ment", 'src/app.ts', ctx(['src/pay$&ment.ts'], { aliases }))).toBe('src/pay$&ment.ts');
    });

    it('resolves a paths alias a tsconfig inherits through extends', async () => {
        const read = readerOf({
            'packages/api/tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
            'tsconfig.base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@libs/*":["libs/*"]}}}',
        });
        const aliases = [(await aliasesOf('packages/api/tsconfig.json', read))!];
        expect(resolveSpecifier('@libs/billing/charge', 'packages/api/src/main.ts', ctx(['libs/billing/charge.ts'], { aliases }))).toBe('libs/billing/charge.ts');
    });

    it('resolves a bare import through baseUrl', async () => {
        const aliases = [(await aliasesOf('tsconfig.json', readerOf({ 'tsconfig.json': '{"compilerOptions":{"baseUrl":"src"}}' })))!];
        expect(resolveSpecifier('utils/money', 'src/routes/pay.ts', ctx(['src/utils/money.ts'], { aliases }))).toBe('src/utils/money.ts');
    });

    it('resolves a workspace package name to the source of its built entry', () => {
        const pkg = packageOf('packages/shared/package.json', '{"name":"@acme/shared","main":"dist/index.js"}')!;
        expect(resolveSpecifier('@acme/shared', 'apps/api/src/main.ts', ctx(['packages/shared/src/index.ts'], { packages: [pkg] }))).toBe('packages/shared/src/index.ts');
    });

    it('resolves a workspace package subpath to the file under its src', () => {
        const pkg = packageOf('packages/shared/package.json', '{"name":"@acme/shared"}')!;
        expect(resolveSpecifier('@acme/shared/money', 'apps/api/src/main.ts', ctx(['packages/shared/src/money.ts'], { packages: [pkg] }))).toBe('packages/shared/src/money.ts');
    });

    it('reads a tsconfig with comments and trailing commas', () => {
        expect(parseJsonc('{\n  // the base\n  "compilerOptions": { "baseUrl": "./src", /* x */ },\n}')).toEqual({ compilerOptions: { baseUrl: './src' } });
    });

    it('keeps a comment marker that sits inside a string', () => {
        expect(parseJsonc('{"paths":{"@/*":["./src/*"]},"url":"http://x"}')).toEqual({ paths: { '@/*': ['./src/*'] }, url: 'http://x' });
    });

    // A package that names its entry only in nested `exports` conditions still resolves to its source.
    it('resolves a workspace package whose entry is a nested exports condition', () => {
        const pkg = packageOf('packages/shared/package.json', '{"name":"@acme/shared","exports":{".":{"import":{"types":"./dist/index.d.ts","default":"./dist/index.js"}}}}')!;
        expect(resolveSpecifier('@acme/shared', 'apps/api/src/main.ts', ctx(['packages/shared/src/index.ts'], { packages: [pkg] }))).toBe('packages/shared/src/index.ts');
    });

    // `exports` with no subpath keys is the conditions of '.' itself.
    it('reads an exports object of bare conditions as the package entry', () => {
        const pkg = packageOf('packages/shared/package.json', '{"name":"shared","exports":{"default":"./src/main.ts"}}')!;
        expect(resolveSpecifier('shared', 'apps/api/src/main.ts', ctx(['packages/shared/src/main.ts'], { packages: [pkg] }))).toBe('packages/shared/src/main.ts');
    });

    // A subpath the manifest maps to a different folder is followed, not guessed under src/.
    it('resolves a workspace subpath through the exports map', () => {
        const pkg = packageOf('packages/shared/package.json', '{"name":"@acme/shared","exports":{"./money":"./dist/lib/money.js"}}')!;
        expect(resolveSpecifier('@acme/shared/money', 'apps/api/src/main.ts', ctx(['packages/shared/src/lib/money.ts'], { packages: [pkg] }))).toBe('packages/shared/src/lib/money.ts');
    });

    it('reads the workspace patterns of npm/yarn (array and packages object) and pnpm', () => {
        expect(workspaceGlobsOf('{"workspaces":["apps/*","libs/*"]}', null)).toEqual(['apps/*', 'libs/*']);
        expect(workspaceGlobsOf('{"workspaces":{"packages":["pkgs/**"]}}', null)).toEqual(['pkgs/**']);
        expect(workspaceGlobsOf(null, "packages:\n  - 'apps/*'\n  - \"libs/*\" # comment\n  - '!libs/legacy'\ncatalog:\n  - x\n")).toEqual(['apps/*', 'libs/*', '!libs/legacy']);
    });

    it('matches a directory against workspace patterns, with ** and ! exclusion', () => {
        const globs = ['packages/*', 'tools/**', '!packages/legacy'];
        expect(isWorkspaceDir('packages/shared', globs)).toBe(true);
        expect(isWorkspaceDir('packages/shared/inner', globs)).toBe(false);
        expect(isWorkspaceDir('tools/a/b', globs)).toBe(true);
        expect(isWorkspaceDir('packages/legacy', globs)).toBe(false);
        expect(isWorkspaceDir('apps/web', globs)).toBe(false);
    });
});
