import { attachRepliesToComments } from './bitbucket-comment-threads';

const c = (id: number, parent?: number, created = id) => ({
    id,
    parent: parent ? { id: parent } : undefined,
    created_on: `2026-10-01T00:00:${String(created).padStart(2, '0')}Z`,
});

describe('attachRepliesToComments', () => {
    it('lists the whole thread under its root, a reply to a reply included', () => {
        const comments = attachRepliesToComments([c(1), c(2, 1), c(3, 2), c(4)]);
        const byId = new Map(comments.map((x) => [x.id, x]));

        expect(byId.get(1).replies.map((r) => r.id)).toEqual([2, 3]);
        expect(byId.get(4).replies).toEqual([]);
    });

    it('keeps direct children on an intermediate reply', () => {
        const comments = attachRepliesToComments([c(1), c(2, 1), c(3, 2)]);

        expect(comments.find((x) => x.id === 2).replies.map((r) => r.id)).toEqual([3]);
    });

    it('does not drop a reply listed before its parent', () => {
        const comments = attachRepliesToComments([c(3, 2), c(2, 1), c(1)]);

        expect(comments.find((x) => x.id === 1).replies.map((r) => r.id)).toEqual([2, 3]);
    });

    it('orders a thread by creation time', () => {
        const comments = attachRepliesToComments([c(1), c(5, 1, 9), c(6, 1, 7)]);

        expect(comments.find((x) => x.id === 1).replies.map((r) => r.id)).toEqual([6, 5]);
    });

    it('treats a reply whose parent is missing from the page as its own root', () => {
        const comments = attachRepliesToComments([c(2, 99)]);

        expect(comments[0].replies).toEqual([]);
    });
});
