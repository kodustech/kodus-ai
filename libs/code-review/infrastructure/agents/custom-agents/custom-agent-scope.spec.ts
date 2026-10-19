import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    customAgentSlug,
    filesInAgentScope,
    ignoredFilesInAgentScope,
    namesFilesExplicitly,
    parseCustomAgentCommand,
    selectCustomAgents,
} from './custom-agent-scope';

const agent = (over: Partial<CustomAgentConfig> = {}) =>
    ({
        id: 'a',
        name: 'Ledger Rules',
        enabled: true,
        instructions: '',
        scope: {},
        tools: {},
        presentation: {
            tag: { color: 'blue' },
            format: 'inline',
            suggestedFix: 'when-confident',
        },
        ...over,
    }) as CustomAgentConfig;

describe('customAgentSlug', () => {
    it.each([
        ['Ledger Rules', 'ledger-rules'],
        ['  API / Contracts v2 ', 'api-contracts-v2'],
        ['Revisão de Migrações', 'revisao-de-migracoes'],
        ['***', 'agent'],
    ])('%s → %s', (name, slug) => {
        expect(customAgentSlug(name)).toBe(slug);
    });
});

describe('filesInAgentScope', () => {
    const files = [
        { filename: 'src/ledger/post.ts' },
        { filename: 'src/ledger/post.spec.ts' },
        { filename: 'web/app.tsx' },
    ];

    it('reads a `!` include glob as an exclusion', () => {
        // Teams write negations next to their includes; matching any
        // pattern let `!` patterns add nothing and exclude nothing.
        const scoped = filesInAgentScope(
            agent({ scope: { include: ['src/**/*.ts', '!**/*.spec.ts'] } }),
            files,
        );
        expect(scoped.map((f) => f.filename)).toEqual(['src/ledger/post.ts']);
    });

    it('keeps a leading negative extglob as an include pattern', () => {
        const scoped = filesInAgentScope(
            agent({ scope: { include: ['!(test).ts'] } }),
            [
                { filename: 'post.ts' },
                { filename: 'test.ts' },
                { filename: 'README.md' },
            ],
        );
        expect(scoped.map((f) => f.filename)).toEqual(['post.ts']);
    });

    it('takes every file when the only include globs are negations', () => {
        const scoped = filesInAgentScope(
            agent({ scope: { include: ['!web/**'] } }),
            files,
        );
        expect(scoped.map((f) => f.filename)).toEqual([
            'src/ledger/post.ts',
            'src/ledger/post.spec.ts',
        ]);
    });

    it('matches Next.js route folders written literally', () => {
        const routes = [
            { filename: 'src/app/(shop)/[id]/page.tsx' },
            { filename: 'src/app/(shop)/cart/page.tsx' },
            { filename: 'src/app/about/page.tsx' },
        ];
        expect(
            filesInAgentScope(
                agent({ scope: { include: ['src/app/(shop)/[id]/**'] } }),
                routes,
            ).map((f) => f.filename),
        ).toEqual(['src/app/(shop)/[id]/page.tsx']);
        expect(
            filesInAgentScope(
                agent({ scope: { exclude: ['src/app/(shop)/**'] } }),
                routes,
            ).map((f) => f.filename),
        ).toEqual(['src/app/about/page.tsx']);
    });

    it('still reads brackets as a glob class when that matches', () => {
        const scoped = filesInAgentScope(
            agent({ scope: { include: ['src/[ab]/*.ts'] } }),
            [{ filename: 'src/a/x.ts' }, { filename: 'src/c/x.ts' }],
        );
        expect(scoped.map((f) => f.filename)).toEqual(['src/a/x.ts']);
    });

    it('takes every file when the agent lists no include glob', () => {
        expect(filesInAgentScope(agent(), files)).toHaveLength(3);
    });

    it('applies include, then exclude', () => {
        const scoped = filesInAgentScope(
            agent({
                scope: { include: ['src/**'], exclude: ['**/*.spec.ts'] },
            }),
            files,
        );
        expect(scoped.map((f) => f.filename)).toEqual(['src/ledger/post.ts']);
    });

    it('matches a glob saved with surrounding spaces', () => {
        const scoped = filesInAgentScope(
            agent({
                scope: { include: [' src/** '], exclude: [' **/*.spec.ts'] },
            }),
            files,
        );
        expect(scoped.map((f) => f.filename)).toEqual(['src/ledger/post.ts']);
    });

    it('ignores blank globs instead of matching nothing', () => {
        expect(
            filesInAgentScope(agent({ scope: { include: [' '] } }), files),
        ).toHaveLength(3);
    });
});

describe('namesFilesExplicitly', () => {
    it.each([
        ['package.json', true],
        ['apps/web/package.json', true],
        ['./package.json', true],
        ['**/Dockerfile', true],
        ['infra/**/*.tf', true],
        ['config/limits.json', true],
        ['src/[ab]/*.ts', true],
        ['src/app/(shop)/[id]/page.tsx', true],
        ['src/**', false],
        ['web/**', false],
        ['apps/web/*', false],
        ['packages/@ledger/ui/**', false],
        ['infra/**/*', false],
        ['./src/**/', false],
        ['**', false],
        ['**/*', false],
        ['*', false],
        ['./*', false],
        ['*.lock', false],
        ['**/*.ts', false],
        ['**/*.{ts,tsx}', false],
        ['Dockerfile.*', false],
        ['(shop)/**', false],
        ['!(test).ts', false],
        ['', false],
    ])('%j → %s', (glob, explicit) => {
        expect(namesFilesExplicitly(glob)).toBe(explicit);
    });
});

describe('ignoredFilesInAgentScope', () => {
    const ignored = [
        { filename: 'package.json' },
        { filename: 'apps/web/package.json' },
        { filename: 'infra/envs/prod/main.tf' },
        { filename: 'infra/envs/prod/notes.md' },
        { filename: 'src/prod/handler.ts' },
    ];
    const names = (include?: string[], exclude?: string[]) =>
        ignoredFilesInAgentScope(
            agent({ scope: { include, exclude } }),
            ignored,
        ).map((f) => f.filename);

    it('gives an agent the ignored file its glob names', () => {
        expect(names(['package.json'])).toEqual(['package.json']);
        expect(names(['**/package.json'])).toEqual([
            'package.json',
            'apps/web/package.json',
        ]);
    });

    it('reaches a file under an ignored directory through a glob that names it', () => {
        // `**/prod/**` is among the default ignore paths.
        expect(names(['infra/**/*.tf'])).toEqual(['infra/envs/prod/main.tf']);
    });

    it('gives nothing to a folder glob', () => {
        expect(names(['infra/**'])).toEqual([]);
        expect(names(['src/**', 'apps/web/*'])).toEqual([]);
    });

    it('never gives an agent a secret file, even one its glob names', () => {
        const secrets = [
            { filename: 'web/.env.production' },
            { filename: 'src/certs/server.pem' },
            { filename: 'src/config/master.key' },
            { filename: 'deploy/id_rsa' },
            { filename: 'android/release.KEYSTORE' },
            { filename: 'web/package-lock.json' },
        ];
        const named = (include: string[]) =>
            ignoredFilesInAgentScope(
                agent({ scope: { include } }),
                secrets,
            ).map((f) => f.filename);

        expect(named(['web/**', 'src/**'])).toEqual([]);
        expect(
            named([
                'web/.env.production',
                'src/certs/server.pem',
                'src/config/master.key',
                'deploy/id_rsa',
                'android/release.KEYSTORE',
                'web/package-lock.json',
            ]),
        ).toEqual(['web/package-lock.json']);
    });

    it('gives nothing to a broad glob or to an agent with no include glob', () => {
        expect(names(['**/*.ts', '**/*.json'])).toEqual([]);
        expect(names(['**/*', '*.tf'])).toEqual([]);
        expect(names()).toEqual([]);
    });

    it('takes only the files the explicit glob matches when broad ones sit beside it', () => {
        expect(names(['**/*.ts', 'package.json'])).toEqual(['package.json']);
    });

    it('still applies the excludes', () => {
        expect(names(['**/package.json'], ['apps/**'])).toEqual([
            'package.json',
        ]);
        expect(names(['**/package.json', '!package.json'])).toEqual([
            'apps/web/package.json',
        ]);
    });
});

describe('selectCustomAgents', () => {
    it('keeps the enabled agents', () => {
        const picked = selectCustomAgents([
            agent({ id: '1' }),
            agent({ id: '2', enabled: false }),
        ]);
        expect(picked.map((a) => a.id)).toEqual(['1']);
    });

    it('finds the requested agent by slug, enabled or not', () => {
        const picked = selectCustomAgents(
            [
                agent({ id: '1', enabled: false }),
                agent({ id: '2', name: 'Other' }),
            ],
            'ledger-rules',
        );
        expect(picked.map((a) => a.id)).toEqual(['1']);
    });

    it('runs only the first of two agents sharing a slug', () => {
        const twins = [
            agent({ id: '1', name: 'Ledger Rules' }),
            agent({ id: '2', name: 'ledger rules' }),
            agent({ id: '3', name: 'Other' }),
        ];
        expect(selectCustomAgents(twins).map((a) => a.id)).toEqual(['1', '3']);
        expect(
            selectCustomAgents(twins, 'ledger-rules').map((a) => a.id),
        ).toEqual(['1']);
    });

    it('runs nothing for an unknown slug', () => {
        expect(selectCustomAgents([agent()], 'nope')).toEqual([]);
    });
});

describe('parseCustomAgentCommand', () => {
    it.each([
        ['@kody -v ledger-rules', 'ledger-rules'],
        ['  @Kody -v Ledger-Rules  \nplease', 'ledger-rules'],
        ['@kody -v business-logic', undefined],
        ['@kody -v business-logic TASK-1', undefined],
        ['@kody review', undefined],
        ['@kody -v ledger rules', undefined],
        ['', undefined],
    ])('%j → %s', (text, slug) => {
        expect(parseCustomAgentCommand(text)).toBe(slug);
    });
});
