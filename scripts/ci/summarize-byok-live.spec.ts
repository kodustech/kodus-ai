/**
 * The redaction thresholds, pinned.
 *
 * This summary is the one place a vendor's raw error text leaves the Actions
 * log for a chat channel with a different audience and retention, so the scrub
 * is a security boundary rather than a formatting nicety. It had already been
 * wrong twice — a dead `AIza` branch, and a floor of 40 that let the canonical
 * 32-character hex secret through — and both times the bug was invisible
 * because nothing exercised it.
 *
 * Driven through the real CLI (`node summarize-byok-live.mjs <report>`) rather
 * than by importing internals: that is the contract CI runs, and it survives
 * the module being refactored.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'summarize-byok-live.mjs');

/** A minimal jest --json report carrying one failing row with `message`. */
function reportWith(message: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'byok-summary-'));
    const file = join(dir, 'report.json');
    writeFileSync(
        file,
        JSON.stringify({
            testResults: [
                {
                    assertionResults: [
                        {
                            status: 'failed',
                            title: 'some_brand — why this row exists',
                            failureMessages: [`    AI_APICallError: ${message}`],
                        },
                    ],
                },
            ],
        }),
    );
    return file;
}

const summarize = (message: string): string =>
    execFileSync('node', [SCRIPT, reportWith(message)], { encoding: 'utf8' });

describe('credential scrub — what must never reach Discord', () => {
    it.each([
        ['OpenAI project key', 'sk-proj-AbCdEf0123456789XyZwAbCdEf01234567'],
        ['OpenAI service account key', 'sk-svcacct-AbCdEf0123456789XyZw'],
        ['Google API key (no separator after the prefix)', 'AIzaSyD9aBcDeFgHiJkLmNoPqRsTuVwXyZ01234'],
        // The class the 40-character floor used to miss: 16 random bytes as
        // hex is 32 characters, lowercase only, and carries digits.
        ['canonical 32-char hex secret', '0123456789abcdef0123456789abcdef'],
        ['lowercase hex, 40 chars', '0123456789abcdef0123456789abcdef01234567'],
        ['bearer token', 'Authorization: Bearer fw_3ZabcDEF123456'],
        ['GitLab PAT', 'glpat-ABCdef123456789012345'],
        ['base64 service account blob', 'eyJ0eXBlIjoic2VydmljZV9hY2NvdW50IiwicHJvamVjdF9pZCI6Imtvb'],
    ])('redacts a %s', (_label, secret) => {
        const out = summarize(secret);
        expect(out).toContain('[redacted]');
        // Not a prefix-only redaction: no recognisable run of the secret may
        // survive. An exact-count quantifier would leak the tail.
        const tail = secret.replace(/^\S+\s+/, '').slice(-12);
        expect(out).not.toContain(tail);
    });

    it.each([
        // 47 characters, zero digits — the reason the digit test carries the
        // rule instead of the length.
        ['Vertex quota identifier', 'global_online_prediction_requests_per_base_model'],
        ['Bedrock ARN', 'arn:aws:bedrock:us-east-1:611816806956:inference-profile/us.anthropic.claude-sonnet-4-6'],
        ['Fireworks model path', 'accounts/fireworks/models/deepseek-v4-flash-0731'],
        ['a plain vendor message', 'Model access is denied due to INVALID_PAYMENT_INSTRUMENT'],
        ['a drift message', 'unknown field `thinking` is not supported'],
    ])('keeps a %s intact', (_label, text) => {
        const out = summarize(text);
        expect(out).not.toContain('[redacted]');
        expect(out).toContain(text.slice(0, 40));
    });
});
