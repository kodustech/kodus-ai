import { stripToolLinks, withVerifiedOutcome } from './conversation-outcome';

const REAL = 'https://app.kodus.io/settings/code-review/7/kody-rules/real-abc?tab=memories';
const FAKE = 'https://app.kodus.io/settings/code-review/7/kody-rules/fake-999?tab=memories';

const wrote = (link = REAL) => [
    {
        tool: 'KODUS_CREATE_MEMORY',
        args: {},
        result: JSON.stringify({ data: { link } }),
    },
];

describe('withVerifiedOutcome', () => {
    it('keeps the bot pasting a link, but the one the tool returned', () => {
        const reply = withVerifiedOutcome(`Saved. Open it: ${FAKE}`, wrote());

        expect(reply).toBe(`Saved. Open it: ${REAL}`);
    });

    it('rewrites the target of a markdown link and keeps its text', () => {
        const reply = withVerifiedOutcome(
            `Saved. You can open it [here](${FAKE}).`,
            wrote(),
        );

        expect(reply).toBe(`Saved. You can open it [here](${REAL}).`);
    });

    it('shows the developer nothing about the tools themselves', () => {
        const reply = withVerifiedOutcome(`Saved: ${FAKE}`, wrote());

        expect(reply).not.toContain('KODUS_');
        expect(reply).not.toContain('---');
        expect(reply).not.toContain('✅');
    });

    it('drops a link invented on a turn that wrote nothing', () => {
        const reply = withVerifiedOutcome(
            `Saved. You can open it [here](${FAKE}).`,
            [],
        );

        expect(reply).toBe('Saved. You can open it here.');
    });

    it('matches several links to several writes in order', () => {
        const second = REAL.replace('real-abc', 'real-def');
        const reply = withVerifiedOutcome(`One ${FAKE} and two ${FAKE}`, [
            ...wrote(),
            ...wrote(second),
        ]);

        expect(reply).toBe(`One ${REAL} and two ${second}`);
    });

    it('leaves a reply that mentions no link alone', () => {
        expect(withVerifiedOutcome('That makes sense.', wrote())).toBe(
            'That makes sense.',
        );
    });

    it('ignores a failed write when handing out links', () => {
        const reply = withVerifiedOutcome(`Saved: ${FAKE}`, [
            { tool: 'KODUS_CREATE_MEMORY', args: {}, error: 'boom' },
        ]);

        expect(reply).toBe('Saved:');
    });
});

describe('stripToolLinks', () => {
    it('leaves unrelated links alone', () => {
        const text = 'See https://github.com/kodustech/kodus-ai/pull/1 for context.';

        expect(stripToolLinks(text)).toContain('github.com/kodustech');
    });
});
