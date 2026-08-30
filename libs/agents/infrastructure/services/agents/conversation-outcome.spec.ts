import {
    buildOutcomeFooter,
    stripToolLinks,
    withVerifiedOutcome,
} from './conversation-outcome';

const created = {
    tool: 'KODUS_CREATE_MEMORY',
    args: {},
    result: JSON.stringify({
        success: true,
        data: {
            link: 'https://app.kodus.io/settings/code-review/7/kody-rules/abc-123?tab=memories',
        },
    }),
};

const createdInMcpEnvelope = {
    tool: 'KODUS_CREATE_MEMORY',
    args: {},
    result: JSON.stringify({
        content: [
            {
                type: 'text',
                text: '{"success":true,"data":{"link":"https://app.kodus.io/settings/code-review/7/kody-rules/env-777?tab=memories"}}',
            },
        ],
    }),
};

describe('buildOutcomeFooter', () => {
    it('finds the link whatever envelope the server wrapped it in', () => {
        expect(buildOutcomeFooter([createdInMcpEnvelope])).toContain(
            'kody-rules/env-777',
        );
    });

    it('reports what actually ran, with the link the tool returned', () => {
        const footer = buildOutcomeFooter([created]);

        expect(footer).toContain('KODUS_CREATE_MEMORY');
        expect(footer).toContain('kody-rules/abc-123');
    });

    it('is empty when nothing was written', () => {
        expect(buildOutcomeFooter([])).toBe('');
    });

    it('marks a failed write instead of hiding it', () => {
        const footer = buildOutcomeFooter([
            { tool: 'KODUS_UPDATE_KODY_RULE', args: {}, error: 'boom' },
        ]);

        expect(footer).toContain('KODUS_UPDATE_KODY_RULE');
        expect(footer).toMatch(/boom/);
    });
});

describe('stripToolLinks', () => {
    it('removes the whole markdown link, leaving no dangling syntax', () => {
        const out = stripToolLinks(
            'You can open it [here](https://app.kodus.io/settings/code-review/7/kody-rules/x?tab=memories).',
        );

        expect(out).not.toContain('[here](');
        expect(out).not.toContain('kody-rules/x');
        // The sentence still reads: the link text stays, the URL goes.
        expect(out).toBe('You can open it here.');
    });

    it('removes app links the model wrote itself', () => {
        const text =
            'Done. You can view it here: https://app.kodus.io/settings/code-review/7/kody-rules/fake-999?tab=memories';

        expect(stripToolLinks(text)).not.toContain('fake-999');
    });

    it('leaves unrelated links alone', () => {
        const text =
            'See https://github.com/kodustech/kodus-ai/pull/1 for context.';

        expect(stripToolLinks(text)).toContain('github.com/kodustech');
    });
});

describe('link extraction', () => {
    it('stops at the envelope, not at the next whitespace', () => {
        const footer = buildOutcomeFooter([
            {
                tool: 'KODUS_CREATE_MEMORY',
                args: {},
                result:
                    '[{"text":"{\\"link\\":\\"http://localhost:3000/settings/code-review/670345891/kody-rules/2922a5c5?tab=memories&teamId=92ec\\"}}"}]',
            },
        ]);

        expect(footer).toContain('kody-rules/2922a5c5?tab=memories&teamId=92ec');
        expect(footer).not.toContain('structuredContent');
        expect(footer).not.toMatch(/[\\"}\]]\s*$/);
    });
});

describe('withVerifiedOutcome', () => {
    it('replaces a fabricated link with the real one', () => {
        const reply = withVerifiedOutcome(
            'Done — saved it: https://app.kodus.io/settings/code-review/7/kody-rules/fake-999?tab=memories',
            [created],
        );

        expect(reply).not.toContain('fake-999');
        expect(reply).toContain('kody-rules/abc-123');
    });

    it('leaves a reply that claims nothing untouched apart from links', () => {
        expect(withVerifiedOutcome('That makes sense.', [])).toBe(
            'That makes sense.',
        );
    });

    it('strips an invented link when no tool ran at all', () => {
        const reply = withVerifiedOutcome(
            'Saved: https://app.kodus.io/settings/code-review/7/kody-rules/fake-999?tab=memories',
            [],
        );

        expect(reply).not.toContain('fake-999');
        expect(reply).not.toContain('KODUS_');
    });
});
