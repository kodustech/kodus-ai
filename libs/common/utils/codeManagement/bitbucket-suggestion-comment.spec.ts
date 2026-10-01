import {
    formatBitbucketPromptReply,
    formatBitbucketSuggestionBody,
} from './bitbucket-suggestion-comment';

const feedback = 'Was this suggestion helpful? Reply with 👍 or 👎 to help Kody learn.';

describe('formatBitbucketSuggestionBody', () => {
    it('renders chips, the bold title, the body, then a plain footer, with no code and no HTML', () => {
        const body = formatBitbucketSuggestionBody({
            label: 'bug',
            severity: 'high',
            title: 'User can be null when the account was deleted',
            body: 'Reading name throws a 500. Guard it.',
            feedback,
        });

        expect(body).toBe(
            [
                '`kody|code-review` `bug` `severity-level|high`',
                '',
                '**User can be null when the account was deleted**',
                '',
                'Reading name throws a 500. Guard it.',
                '',
                feedback,
                '',
                '```\n👍\n```',
                '',
                '```\n👎\n```',
            ].join('\n'),
        );
        expect(body).not.toMatch(/<\/?(details|summary|sub)>|<!--/);
    });

    it('omits the footer when asked (PR-level comments)', () => {
        const body = formatBitbucketSuggestionBody({
            label: 'kody_rules',
            severity: 'high',
            title: 'No ticket reference',
            body: 'Add the ticket ID.',
            feedback,
            includeFooter: false,
        });

        expect(body).toBe(
            '`kody|code-review` `kody_rules` `severity-level|high`\n\n**No ticket reference**\n\nAdd the ticket ID.',
        );
    });

    it('keeps the action statement after the body', () => {
        const body = formatBitbucketSuggestionBody({
            label: 'bug',
            severity: 'low',
            title: 'T',
            body: 'B.',
            actionStatement: 'Apply to all call sites.',
            feedback,
            includeFooter: false,
        });

        expect(body.endsWith('B.\n\nApply to all call sites.')).toBe(true);
    });
});

describe('formatBitbucketPromptReply', () => {
    it('carries the Kody chip and the prompt in a text fence, with no feedback emoji', () => {
        const reply = formatBitbucketPromptReply('File a.ts, line 3:\n\nPrompt text');

        expect(reply).toBe(
            '`kody|code-review` **Prompt for LLM**: copy into your coding agent\n\n```text\nFile a.ts, line 3:\n\nPrompt text\n```',
        );
        expect(reply).not.toMatch(/👍|👎/);
    });

    it('uses a longer fence when the prompt contains one', () => {
        const reply = formatBitbucketPromptReply('Code:\n```js\nx()\n```');

        expect(reply).toContain('````text\nCode:\n```js\nx()\n```\n````');
    });

    it('drops feedback emoji from the prompt so the reply is never counted as feedback', () => {
        expect(formatBitbucketPromptReply('Use 👍 here')).not.toMatch(/👍/);
    });
});
