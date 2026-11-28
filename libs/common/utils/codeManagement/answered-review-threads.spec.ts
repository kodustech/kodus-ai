import { answeredThreadRootIds } from './answered-review-threads';
import { formatBitbucketPromptReply } from './bitbucket-suggestion-comment';

describe('answeredThreadRootIds', () => {
    it('keeps the threads with a reply, as strings', () => {
        expect(
            answeredThreadRootIds([
                { rootIds: [10], replies: [{ body: 'why?' }] },
                { rootIds: [11], replies: [] },
            ]),
        ).toEqual(new Set(['10']));
    });

    it('lists every id the root is saved under, skipping empty ones', () => {
        expect(
            answeredThreadRootIds([
                { rootIds: [7, 'abc', null, undefined, ''], replies: [{}] },
            ]),
        ).toEqual(new Set(['7', 'abc']));
    });

    it("does not count Kody's Bitbucket prompt reply as an answer", () => {
        const prompt = { body: formatBitbucketPromptReply('fix it') };

        expect(
            answeredThreadRootIds([
                { rootIds: [1], replies: [prompt] },
                { rootIds: [2], replies: [prompt, { body: 'done' }] },
            ]),
        ).toEqual(new Set(['2']));
    });
});
