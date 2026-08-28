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

const AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const live = process.env.CODEX_LIVE === '1' && fs.existsSync(AUTH);
const maybe = live ? describe : describe.skip;

function credential() {
    const raw = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    return {
        provider: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        codexAccessToken: raw.tokens.access_token,
        codexRefreshToken: raw.tokens.refresh_token,
        accountId: raw.tokens.account_id,
    } as never;
}

maybe('Codex subscription provider (live)', () => {
    jest.setTimeout(300_000);

    it('completes a single turn on gpt-5.6-luna', async () => {
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
});
