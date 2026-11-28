import {
    authorFiltersFor,
    withConnectionAuthorFilters,
} from './author-filters';

describe('author filters per Git connection', () => {
    const config = {
        enabled: true,
        ignoredUsers: ['bot-gh'],
        allowedUsers: [],
        seededBotIds: ['bot-gh'],
        connections: {
            'gl-b': {
                ignoredUsers: ['bot-gl'],
                allowedUsers: ['7'],
                seededBotIds: ['bot-gl'],
            },
        },
    };

    it("reads a connection's own lists", () => {
        expect(authorFiltersFor(config, 'gl-b')).toEqual({
            ignoredUsers: ['bot-gl'],
            allowedUsers: ['7'],
            seededBotIds: ['bot-gl'],
        });
    });

    it('reads the organization lists for a connection without lists of its own', () => {
        expect(authorFiltersFor(config, 'gh-a')).toEqual({
            ignoredUsers: ['bot-gh'],
            allowedUsers: [],
            seededBotIds: ['bot-gh'],
        });
    });

    it('reads the organization lists when no connection is named', () => {
        expect(authorFiltersFor(config).ignoredUsers).toEqual(['bot-gh']);
    });

    it('answers empty lists for a missing config', () => {
        expect(authorFiltersFor(null, 'gl-b')).toEqual({
            ignoredUsers: [],
            allowedUsers: [],
            seededBotIds: [],
        });
    });

    it("writes a change to a connection's lists, starting from what it read before", () => {
        const next = withConnectionAuthorFilters(config, 'gh-a', {
            ignoredUsers: ['bot-gh', 'person'],
        });

        expect(next.connections['gh-a']).toEqual({
            ignoredUsers: ['bot-gh', 'person'],
            allowedUsers: [],
            seededBotIds: ['bot-gh'],
        });
        expect(next.ignoredUsers).toEqual(['bot-gh']);
        expect(next.connections['gl-b']).toEqual(config.connections['gl-b']);
        expect(next.enabled).toBe(true);
    });

    it('writes the organization lists when no connection is named', () => {
        const next = withConnectionAuthorFilters(config, undefined, {
            ignoredUsers: [],
        });

        expect(next.ignoredUsers).toEqual([]);
        expect(next.connections).toEqual(config.connections);
    });

    it("reads the organization's lists for an id that names an inherited member", () => {
        const config = { ignoredUsers: ['org-bot'], connections: {} };

        expect(authorFiltersFor(config, 'toString').ignoredUsers).toEqual([
            'org-bot',
        ]);
    });
});
