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
