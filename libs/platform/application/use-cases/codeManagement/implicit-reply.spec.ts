jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { LLM } from '@libs/llm/llm';

import {
    classifyReplyAddressedToKody,
    isBotAuthor,
    ThreadMessage,
} from './implicit-reply';

const run = LLM.run as jest.Mock;

const thread: ThreadMessage[] = [
    {
        id: 1,
        author: 'Kody',
        isKody: true,
        isBot: true,
        body: 'Leak here. <!-- kody-codereview -->',
    },
    { id: 2, author: 'alice', isKody: false, isBot: false, body: 'why?' },
];

describe('isBotAuthor', () => {
    it.each([
        [{ type: 'Bot', login: 'renovate' }, true],
        [{ login: 'devin-ai-integration[bot]' }, true],
        [{ login: 'project_42_bot_3f9a' }, true],
        [{ bot: true, login: 'ci' }, true],
        [{ login: 'robert', type: 'User' }, false],
        [{ login: 'abbott' }, false],
        [{}, false],
    ])('%j → %s', (author, expected) => {
        expect(isBotAuthor(author)).toBe(expected);
    });
});

describe('classifyReplyAddressedToKody', () => {
    beforeEach(() => run.mockReset());

    it('asks LLM.run for a structured verdict on the given slot, with the whole thread', async () => {
        run.mockResolvedValue({ addressedToKody: true });
        const byokConfig = { provider: 'openai' } as any;

        const result = await classifyReplyAddressedToKody({
            thread,
            byokConfig,
            organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
            prNumber: 3,
        });

        expect(result).toBe(true);
        const request = run.mock.calls[0][0];
        expect(request.byokConfig).toBe(byokConfig);
        expect(request.organizationId).toBe('org');
        expect(request.schema).toBeDefined();
        expect(request.user).toContain(
            '<message author="Kody">\nLeak here.\n</message>',
        );
        expect(request.user).toContain(
            '<NEWEST MESSAGE author="alice">\nwhy?\n</NEWEST MESSAGE>',
        );
    });

    it('throws when the model returns no verdict, so the caller stays quiet', async () => {
        run.mockResolvedValue(undefined);

        await expect(
            classifyReplyAddressedToKody({
                thread,
                organizationAndTeamData: {
                    organizationId: 'org',
                    teamId: 'team',
                },
            }),
        ).rejects.toThrow('no verdict');
    });
});

describe('reply thread rendering', () => {
    it('drops nested and unclosed HTML comments from message bodies', async () => {
        run.mockResolvedValue({ addressedToKody: false });

        await classifyReplyAddressedToKody({
            thread: [
                { ...thread[0], body: 'root <!<!---->-- hidden --> tail' },
                { ...thread[1], body: 'why? <!-- open' },
            ],
            organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        });

        const user = run.mock.lastCall[0].user as string;
        expect(user).not.toContain('<!--');
        expect(user).toContain('root  tail');
    });
});
