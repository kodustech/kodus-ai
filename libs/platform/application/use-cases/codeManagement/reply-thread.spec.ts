jest.mock('./implicit-reply', () => ({
    ...jest.requireActual('./implicit-reply'),
    classifyReplyAddressedToKody: jest.fn(async () => true),
}));

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { LLM_TASK } from '@libs/llm/byok-config';

import { classifyReplyAddressedToKody } from './implicit-reply';
import {
    buildReplyThread,
    classifyImplicitReply,
    CONVERSATION_LICENSE_UNAVAILABLE_MESSAGE,
    getOriginalKodyComment,
    getOthersReplies,
    isKodyComment,
    KODY_ACKNOWLEDGMENT_MESSAGE,
} from './reply-thread';

const github = (id: number, login: string, body: string, extra: object = {}) => ({
    id,
    body,
    user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
    created_at: `2026-10-16T10:0${id}:00Z`,
    ...extra,
});

describe('reply-thread', () => {
    it("rebuilds a GitHub reply's thread oldest first, up to the reply", () => {
        const root = github(1, 'kody-ai[bot]', 'Possible null dereference.\n<!-- kody-codereview -->');
        const other = github(2, 'alice', 'unrelated thread', { in_reply_to_id: 9 });
        const human = github(3, 'bob', 'Why would it be null?', { in_reply_to_id: 1 });
        const later = github(4, 'carol', 'after the reply', { in_reply_to_id: 1 });
        expect(buildReplyThread(human, [later, other, human, root], PlatformType.GITHUB)).toEqual([
            { id: 1, author: 'kody-ai[bot]', isKody: true, isBot: true, body: root.body },
            { id: 3, author: 'bob', isKody: false, isBot: false, body: human.body },
        ]);
    });

    it('has no thread for a comment that replies to nothing', () => {
        expect(buildReplyThread(github(1, 'bob', 'hi'), [], PlatformType.GITHUB)).toBeUndefined();
    });

    it("reads Kody's comments by login, marker or the fixed acknowledgment", () => {
        expect(isKodyComment(github(1, 'kody-ai[bot]', 'x'), PlatformType.GITHUB)).toBe(true);
        expect(isKodyComment(github(1, 'bob', 'y <!-- kody-codereview -->'), PlatformType.GITHUB)).toBe(true);
        expect(isKodyComment(github(1, 'bob', KODY_ACKNOWLEDGMENT_MESSAGE), PlatformType.GITHUB)).toBe(true);
        // Posted through the customer's own account on Bitbucket, unmarked.
        expect(isKodyComment(github(1, 'bob', CONVERSATION_LICENSE_UNAVAILABLE_MESSAGE), PlatformType.BITBUCKET)).toBe(true);
        expect(isKodyComment(github(1, 'bob', 'a human reply'), PlatformType.GITHUB)).toBe(false);
    });

    it("classifies on the model the org routes the conversation task to", async () => {
        const slot = { provider: 'openai', model: 'm', apiKey: 'k' };
        const resolveTaskSlot = jest.fn(async () => slot);
        const org = { organizationId: 'o', teamId: 't' };
        const thread = [{ id: 1, author: 'kody', isKody: true, isBot: true, body: 'a' }];
        await expect(
            classifyImplicitReply({ thread, permissionValidationService: { resolveTaskSlot } as any, organizationAndTeamData: org, prNumber: 7, platformType: PlatformType.GITHUB }),
        ).resolves.toBe(true);
        expect(resolveTaskSlot).toHaveBeenCalledWith(org, LLM_TASK.conversation);
        expect((classifyReplyAddressedToKody as jest.Mock).mock.calls[0][0]).toMatchObject({ thread, byokConfig: slot, prNumber: 7 });
    });
});

describe('reply-thread on Forgejo (#2790 review)', () => {
    // Forgejo review comments come back flat: no reply link, only file and line.
    const forgejo = (
        id: number,
        login: string,
        body: string,
        path: string,
        position: number,
    ) => ({
        id,
        body,
        author: { name: login, username: login },
        createdAt: `2026-11-28T10:0${id}:00Z`,
        path,
        position,
        originalPosition: 0,
    });
    const findingA = forgejo(
        1,
        'kody',
        'Null dereference here.\n<!-- kody-codereview -->',
        'a.ts',
        10,
    );
    const findingB = forgejo(
        2,
        'kody',
        'Unbounded loop.\n<!-- kody-codereview -->',
        'b.ts',
        4,
    );
    const alice = forgejo(3, 'alice', 'I think it is fine', 'a.ts', 10);
    const elsewhere = forgejo(4, 'carol', 'unrelated', 'b.ts', 4);
    const reply = forgejo(5, 'bob', '@kody why is this a problem?', 'a.ts', 10);
    const all = [findingA, findingB, alice, elsewhere, reply];

    it('finds the Kody finding the reply sits under, by file and line', () => {
        expect(
            getOriginalKodyComment(
                reply as any,
                all as any,
                PlatformType.FORGEJO,
            ),
        ).toBe(findingA);
    });

    it("returns the thread's other human replies only", () => {
        expect(
            getOthersReplies(reply as any, all as any, PlatformType.FORGEJO),
        ).toEqual([alice]);
    });

    it('rebuilds the thread oldest first, up to the reply', () => {
        expect(
            buildReplyThread(reply, all, PlatformType.FORGEJO)?.map(
                (m) => m.id,
            ),
        ).toEqual([1, 3, 5]);
    });

    it('has no finding for a comment without a file', () => {
        const general = { id: 9, body: '@kody hi', author: { name: 'bob' } };
        expect(
            getOriginalKodyComment(
                general as any,
                all as any,
                PlatformType.FORGEJO,
            ),
        ).toBeUndefined();
    });
});
