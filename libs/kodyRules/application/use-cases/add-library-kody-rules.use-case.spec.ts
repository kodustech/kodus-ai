import { extensionScopeAppliesToFile } from '@libs/common/utils/kody-rules/file-patterns';
import { AddLibraryKodyRulesDto } from '@libs/kodyRules/dtos/add-library-kody-rules.dto';

import {
    AddLibraryKodyRulesUseCase,
    resolveLibraryRuleFileScope,
} from './add-library-kody-rules.use-case';

/**
 * The Ruby semicolon entry as the library payload carries it: a declared
 * `language`, no `path`. Its text never names Ruby either, which is why the
 * language has to come from the payload.
 */
const rubySemicolonRule = {
    title: 'Semicolons are not needed in Ruby',
    rule: 'Do not end a Ruby statement with a semicolon.',
    severity: 'low',
    language: 'ruby',
    repositoriesIds: ['repo-1'],
} as unknown as AddLibraryKodyRulesDto;

/**
 * Wire the real use-case over the real boundaries it talks to, capturing what
 * it hands to `createOrUpdate` — that object is what lands in the rules store.
 */
function makeUseCase() {
    const created: any[] = [];
    const createOrUpdate = {
        execute: jest.fn(async (rule: any) => {
            created.push(rule);
            return { uuid: 'rule-1', ...rule };
        }),
    };
    const authorization = { ensure: jest.fn(async () => undefined) };
    const request = { user: { organization: { uuid: 'org-1' } } };

    const useCase = new AddLibraryKodyRulesUseCase(
        request as any,
        createOrUpdate as any,
        authorization as any,
    );

    return { useCase, created };
}

describe('library import persists a language scope (#1832)', () => {
    it('scopes the Ruby semicolon rule away from non-Ruby files', async () => {
        const { useCase, created } = makeUseCase();

        await useCase.execute(rubySemicolonRule);

        const persisted = created[0];
        // No path is invented: the import leaves the author's `path` alone and
        // narrows through the scope instead.
        expect(persisted.path).toBeUndefined();

        const extensions = persisted.fileScope?.extensions;
        expect(extensions).toEqual(expect.arrayContaining(['.rb']));
        expect(extensionScopeAppliesToFile('lib/semicolons.rb', extensions)).toBe(
            true,
        );
        expect(extensionScopeAppliesToFile('src/index.ts', extensions)).toBe(
            false,
        );
        // Extensionless Ruby files (Gemfile, Rakefile) must stay covered: the
        // scope abstains rather than excluding them.
        expect(extensionScopeAppliesToFile('Rakefile', extensions)).toBe(true);

        // Declared by the library rule, so a later inference cannot replace it.
        expect(persisted.fileScope.source).toBe('author');
        expect(typeof persisted.fileScope.sourceHash).toBe('string');
        expect(persisted.fileScope.sourceHash).toHaveLength(64);
    });

    it('keeps the directory path and adds the language scope on top', async () => {
        const { useCase, created } = makeUseCase();

        await useCase.execute({
            ...rubySemicolonRule,
            path: 'services/**',
        } as AddLibraryKodyRulesDto);

        const persisted = created[0];
        // Both constraints hold: the directory narrows through `path`, the
        // language through the scope (neither wins over the other).
        expect(persisted.path).toBe('services/**');
        expect(extensionScopeAppliesToFile('services/app.rb', persisted.fileScope.extensions)).toBe(true);
        expect(extensionScopeAppliesToFile('services/app.ts', persisted.fileScope.extensions)).toBe(false);
    });

    it('scopes a directory import too, and does not reach for a renamed helper', async () => {
        // The directory branch called a helper this change renamed and deleted,
        // so any import carrying `directoriesInfo` hit an undefined identifier
        // (a 500 on a transpile-only build) and persisted no scope at all. The
        // repositories-only case above never entered that branch.
        const { useCase, created } = makeUseCase();

        await useCase.execute({
            ...rubySemicolonRule,
            path: 'services/**',
            repositoriesIds: [],
            directoriesInfo: [
                { repositoryId: 'repo-1', directoryId: 'dir-1' },
            ],
        } as unknown as AddLibraryKodyRulesDto);

        const persisted = created[0];
        expect(persisted.path).toBe('services/**');
        expect(persisted.directoryId).toBe('dir-1');
        expect(
            extensionScopeAppliesToFile(
                'services/app.rb',
                persisted.fileScope.extensions,
            ),
        ).toBe(true);
        expect(
            extensionScopeAppliesToFile(
                'services/app.ts',
                persisted.fileScope.extensions,
            ),
        ).toBe(false);
    });

    it('persists no scope when the rule declares no known language', async () => {
        const { useCase, created } = makeUseCase();

        await useCase.execute({
            ...rubySemicolonRule,
            language: 'brainfuck',
        } as AddLibraryKodyRulesDto);

        // Pre-existing behaviour: nothing narrows the rule.
        expect(created[0].fileScope).toBeNull();
    });
});

describe('resolveLibraryRuleFileScope (#1832)', () => {
    const scopeFor = (language: string) =>
        resolveLibraryRuleFileScope('some rule text', language)!;

    it('covers the Vue and ESM files the source-only glob excluded', () => {
        // These library rules target files a `{.js,.jsx,.ts,.tsx}` glob never
        // matched: single-file components, `import`/`export` rules.
        for (const filename of [
            'Component.vue',
            'mod.mjs',
            'mod.cjs',
            'mod.mts',
            'mod.cts',
            'mod.ts',
            'mod.tsx',
        ]) {
            expect(
                extensionScopeAppliesToFile(
                    filename,
                    scopeFor('jsts').extensions,
                ),
            ).toBe(true);
        }
    });

    it('reaches the manifest files language-only scopes never saw', () => {
        // "Use go.work instead of replace", "centralize Cargo deps in
        // workspace.dependencies", Gradle version catalogs, Central Package
        // Management — all about files their source extension never matches.
        expect(
            extensionScopeAppliesToFile('go.work', scopeFor('go').extensions),
        ).toBe(true);
        expect(
            extensionScopeAppliesToFile('go.mod', scopeFor('go').extensions),
        ).toBe(true);
        expect(
            extensionScopeAppliesToFile(
                'Cargo.toml',
                scopeFor('rust').extensions,
            ),
        ).toBe(true);
        expect(
            extensionScopeAppliesToFile(
                'settings.gradle.kts',
                scopeFor('java').extensions,
            ),
        ).toBe(true);
        expect(
            extensionScopeAppliesToFile(
                'Directory.Packages.props',
                scopeFor('csharp').extensions,
            ),
        ).toBe(true);
    });

    it('documents the gap the source-only lists left', () => {
        // The pre-fix lists, run through the same predicate: every one of these
        // files was silently outside its rule, so it never fired where it
        // mattered. This is the before/after, not a description of it.
        const sourceOnlyJsTs = ['.js', '.jsx', '.ts', '.tsx'];
        expect(
            extensionScopeAppliesToFile('Component.vue', sourceOnlyJsTs),
        ).toBe(false);
        expect(extensionScopeAppliesToFile('mod.mjs', sourceOnlyJsTs)).toBe(
            false,
        );
        expect(
            extensionScopeAppliesToFile('go.work', ['.go']),
        ).toBe(false);
        expect(
            extensionScopeAppliesToFile('Cargo.toml', ['.rs']),
        ).toBe(false);
    });

    it('matches keys case-insensitively and ignores surrounding whitespace', () => {
        expect(scopeFor(' Ruby ').extensions).toEqual(
            expect.arrayContaining(['.rb', '.rake', '.erb', '.gemspec']),
        );
        expect(scopeFor('JSTS').extensions).toEqual(
            expect.arrayContaining(['.ts', '.tsx', '.vue']),
        );
    });

    it('still resolves the legacy typescript/javascript spellings', () => {
        // API consumers / older library entries may send these before the
        // client's `jsts` key: they must not silently stay unscoped (#1832).
        expect(scopeFor('typescript').extensions).toEqual(
            expect.arrayContaining(['.ts', '.tsx']),
        );
        expect(scopeFor('javascript').extensions).toEqual(
            expect.arrayContaining(['.js', '.jsx']),
        );
    });

    it('hashes the rule text it was derived from', () => {
        const a = resolveLibraryRuleFileScope('rule one', 'ruby')!;
        const b = resolveLibraryRuleFileScope('rule two', 'ruby')!;
        expect(a.sourceHash).not.toBe(b.sourceHash);
    });

    it('returns no scope for an unknown or absent language', () => {
        // No scope is the pre-existing behaviour (the rule applies wherever the
        // author's path allows) rather than a guess.
        expect(resolveLibraryRuleFileScope('rule', 'brainfuck')).toBeNull();
        expect(resolveLibraryRuleFileScope('rule', undefined)).toBeNull();
        expect(resolveLibraryRuleFileScope('rule', '')).toBeNull();
    });

    it('treats prototype-shaped languages as unknown instead of crashing', () => {
        expect(resolveLibraryRuleFileScope('rule', '__proto__')).toBeNull();
        expect(resolveLibraryRuleFileScope('rule', 'constructor')).toBeNull();
        expect(
            resolveLibraryRuleFileScope('rule', 'hasOwnProperty'),
        ).toBeNull();
    });
});
