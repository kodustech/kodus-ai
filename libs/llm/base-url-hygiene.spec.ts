import {
    describeBaseUrlProblem,
    describeProtocolMismatch,
    repairBaseUrl,
} from './base-url-hygiene';

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

describe('repairBaseUrl — the read path, where the save guard cannot reach', () => {
    it('strips the endpoint the provider appends itself', () => {
        // The exact value two live slots have stored. Every review they ran hit
        // .../chat/completions/chat/completions and 404ed.
        expect(repairBaseUrl('https://api.groq.com/openai/v1/chat/completions')).toBe(
            'https://api.groq.com/openai/v1',
        );
        expect(repairBaseUrl('https://x.example.com/v1/messages')).toBe(
            'https://x.example.com',
        );
    });

    it('never changes the ORIGIN — which is what makes repairing safe here', () => {
        // The objection this file was written around: a base URL is where
        // guessing could send a credential somewhere unintended. Only a suffix of
        // the PATH is removed, so the host is always the one already configured.
        for (const url of [
            'https://api.groq.com/openai/v1/chat/completions',
            'https://proxy.internal:8443/deep/path/v1/messages',
        ]) {
            expect(new URL(repairBaseUrl(url)).origin).toBe(new URL(url).origin);
        }
    });

    it('leaves a healthy URL exactly as stored', () => {
        for (const url of [
            'https://api.deepseek.com/v1',
            'https://api.deepseek.com',
            'https://proxy.internal/completions/v1', // endpoint word, not a suffix
        ]) {
            expect(repairBaseUrl(url)).toBe(url);
        }
    });

    it('passes through what it cannot parse, and absence', () => {
        // Shape validation belongs to the caller; this must not invent a URL.
        expect(repairBaseUrl('not a url')).toBe('not a url');
        expect(repairBaseUrl(undefined)).toBeUndefined();
        expect(repairBaseUrl('')).toBe('');
    });

    it('agrees with what the save guard TELLS the user to type', () => {
        // One rule, two answers. If these ever disagreed, the runtime would dial
        // something other than the URL the error message asked for.
        const url = 'https://api.groq.com/openai/v1/chat/completions';
        expect(describeBaseUrlProblem(url)).toContain(`"${repairBaseUrl(url)}"`);
    });
});

describe('describeProtocolMismatch — wrong only in combination', () => {
    it('flags an OpenAI-compatible provider pointed at an /anthropic path', () => {
        // A live slot. The URL is valid, the guard above says nothing about it,
        // and the request goes to /anthropic/chat/completions — an OpenAI route
        // under an Anthropic prefix, which exists nowhere.
        const msg = describeProtocolMismatch(
            'openai_compatible',
            'https://api.minimax.io/anthropic',
        )!;
        expect(msg).toContain('/anthropic');
        expect(msg).toContain('/chat/completions');
    });

    it('says nothing when the provider MATCHES the path', () => {
        expect(
            describeProtocolMismatch(
                'anthropic_compatible',
                'https://api.minimax.io/anthropic',
            ),
        ).toBeUndefined();
    });

    it('says nothing about /v1, which both protocols serve', () => {
        // One-directional on purpose: an Anthropic brand on a /v1 path is not
        // evidence of anything, and flagging it would be noise on a working
        // config.
        for (const p of ['openai_compatible', 'anthropic_compatible']) {
            expect(
                describeProtocolMismatch(p, 'https://api.minimax.io/v1'),
            ).toBeUndefined();
        }
    });

    it('does not repair — the right URL is not derivable here', () => {
        // Contrast with the doubled endpoint, which IS repaired: there only one
        // URL can have been intended. Here the user meant either a different
        // provider or a different path, and those are different requests.
        const url = 'https://api.minimax.io/anthropic';
        expect(repairBaseUrl(url)).toBe(url);
    });
});
