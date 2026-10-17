import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    customAgentSlug,
    filesInAgentScope,
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
            mode: 'shadow',
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

    it('ignores blank globs instead of matching nothing', () => {
        expect(
            filesInAgentScope(agent({ scope: { include: [' '] } }), files),
        ).toHaveLength(3);
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
