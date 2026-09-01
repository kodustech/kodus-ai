import { describeBaseUrlProblem } from './base-url-hygiene';

describe('describeBaseUrlProblem', () => {
    it('catches the real production config that 404s on every review', () => {
        // Stored by a live org on both main and fallback. The OpenAI-protocol SDK
        // appends /chat/completions itself, so this URL is requested twice over.
        const msg = describeBaseUrlProblem(
            'https://api.groq.com/openai/v1/chat/completions',
        );
        expect(msg).toContain('must not include');
        expect(msg).toContain('https://api.groq.com/openai/v1');
    });

    it('catches the Anthropic-protocol equivalent', () => {
        expect(
            describeBaseUrlProblem(
                'https://api.moonshot.ai/anthropic/v1/messages',
            ),
        ).toContain('https://api.moonshot.ai/anthropic');
    });

    it('ignores a trailing slash on an otherwise fine URL', () => {
        expect(
            describeBaseUrlProblem('https://api.z.ai/api/paas/v4/'),
        ).toBeUndefined();
    });

    it('says NOTHING about a missing /v1 — real upstreams serve both forms', () => {
        // 13 production orgs run on the bare host today; flagging it would be a
        // false alarm on a working config.
        expect(
            describeBaseUrlProblem('https://api.deepseek.com'),
        ).toBeUndefined();
        expect(
            describeBaseUrlProblem('https://api.deepseek.com/v1'),
        ).toBeUndefined();
    });

    it("leaves malformed input to the caller's own URL validation", () => {
        expect(describeBaseUrlProblem('not a url')).toBeUndefined();
    });
});
