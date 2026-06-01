import { isBotUser } from './bot-user';

describe('isBotUser', () => {
    it.each([
        ['dependabot[bot]'],
        ['dependabot-preview[bot]'],
        ['renovate[bot]'],
        ['renovatebot'],
        ['github-actions[bot]'],
        ['gitlab-bot'],
        ['kodus-bot'],
        ['mergify[bot]'],
        // case-insensitive match
        ['Dependabot[BOT]'],
        ['RENOVATE[bot]'],
    ])('treats "%s" as a bot', (login) => {
        expect(isBotUser(login)).toBe(true);
    });

    it.each([
        ['alex'],
        ['jdoe'],
        ['user-with-dashes'],
        ['Marie_Curie'],
        // contains "robot" but not in our fragments list
        ['robotron'],
    ])('treats "%s" as a human', (login) => {
        expect(isBotUser(login)).toBe(false);
    });

    it.each([[null], [undefined], ['']])(
        'returns false for falsy input (%p)',
        (login) => {
            expect(isBotUser(login)).toBe(false);
        },
    );
});
