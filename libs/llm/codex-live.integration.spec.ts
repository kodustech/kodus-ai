/**
 * Live verification against the real Codex endpoint.
 *
 * Not part of the committed test suite. Skips unless CODEX_LIVE=1 and a Codex
 * credential is present, so it can never break CI or a contributor's run.
 *
 * The point of this file is the second test: the mocked two-step test proves the
 * reasoning metadata is carried through our own reassembly, but only a real
 * request proves the endpoint accepts the replayed encrypted_content and that
 * the whole provider module works end to end on a subscription.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

import { codexSubscriptionModule } from './providers/codex';

const AUTH =
    process.env.CODEX_LIVE_AUTH ??
    path.join(os.homedir(), '.codex', 'auth.json');
const live = process.env.CODEX_LIVE === '1' && fs.existsSync(AUTH);
const maybe = live ? describe : describe.skip;

function credential() {
    const raw = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    // Accepts either the Codex CLI's nested shape or the flat record written
    // by an ocr auth login.
    const t = raw.tokens ?? raw;
    return {
        provider: 'chatgpt_subscription',
        model: process.env.CODEX_LIVE_MODEL ?? 'gpt-5.6-luna',
        codexAccessToken: t.access_token,
        codexRefreshToken: t.refresh_token,
        accountId: t.account_id,
    } as never;
}

maybe('Codex subscription provider (live)', () => {
    jest.setTimeout(300_000);

    it('completes a single turn on the configured model', async () => {
        const model = codexSubscriptionModule.build(credential());
        const result = await generateText({
            model,
            prompt: 'Reply with exactly: OK',
        });
        expect(result.text.length).toBeGreaterThan(0);
    });

    it('replays encrypted reasoning across a tool turn', async () => {
        const model = codexSubscriptionModule.build(credential());
        let calls = 0;

        const result = await generateText({
            model,
            stopWhen: stepCountIs(4),
            tools: {
                lookup: tool({
                    description: 'Look up a stored number by name.',
                    inputSchema: z.object({ name: z.string() }),
                    execute: async () => {
                        calls += 1;
                        return { value: 42 };
                    },
                }),
            },
            prompt: 'Use the lookup tool for "answer", then state the number.',
        });

        // The tool ran, so a second request was issued carrying the first
        // turn's reasoning. Under store:false the endpoint rejects or drops
        // reasoning that is not accompanied by its encrypted_content, so a
        // successful multi-step completion is the end-to-end proof.
        expect(calls).toBeGreaterThan(0);
        expect(result.steps.length).toBeGreaterThan(1);
        expect(result.text).toContain('42');
    });

    // The credential above is injected directly, which skips the file-based
    // source entirely. This drives readCodexAuth instead: no tokens are passed
    // to build(), so the provider must locate and parse the credential itself.
    it('resolves a credential from API_CODEX_AUTH_FILE with no tokens passed', async () => {
        const cliAuth = path.join(os.homedir(), '.codex', 'auth.json');
        if (!fs.existsSync(cliAuth)) {
            return;
        }
        const previous = process.env.API_CODEX_AUTH_FILE;
        process.env.API_CODEX_AUTH_FILE = cliAuth;
        try {
            const model = codexSubscriptionModule.build({
                provider: 'chatgpt_subscription',
                model: 'gpt-5.6-luna',
            } as never);
            const result = await generateText({
                model,
                prompt: 'Reply with exactly: OK',
            });
            expect(result.text.length).toBeGreaterThan(0);
        } finally {
            if (previous === undefined) {
                delete process.env.API_CODEX_AUTH_FILE;
            } else {
                process.env.API_CODEX_AUTH_FILE = previous;
            }
        }
    });
});
