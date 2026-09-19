#!/usr/bin/env node
/**
 * Turn a jest --json run of the BYOK live tier into a Discord message someone
 * can act on without opening the run.
 *
 * WHY: the notification used to be a fixed paragraph — "a brand no longer
 * accepts the reasoning shape we send" — plus a link. It named the workflow and
 * nothing else, so every failure looked identical and the only way to learn
 * anything was to open the log. Worse, the sentence was often WRONG: the last
 * two months of red were dead credentials and a GCP quota, not drift.
 *
 * So the summary states, per failing row: the brand, the model and effort the
 * row runs, and the vendor's own words. That is enough to route the failure —
 * rotate a secret, chase a quota, or actually read a changelog — from the
 * notification alone.
 *
 * The full request body is deliberately NOT here. It is long, it is already in
 * the log, and it is the one part of the payload that can carry a credential.
 *
 *   node scripts/ci/summarize-byok-live.mjs <jest-json-file>
 */
import { readFileSync } from 'node:fs';

const LIMIT = 1_500; // Discord embeds hard-cap; keep well inside it.

/**
 * Vendors mask secrets with long runs of asterisks (OpenAI echoes the whole key
 * that way). Left alone, one masked key eats the entire line budget and pushes
 * the actual reason out of the message.
 */
/**
 * Credential-shaped substrings never reach Discord. Collapsing asterisks alone
 * assumed every vendor masks the key the way OpenAI does; they do not, and this
 * channel has a different audience and retention from the Actions log. Scrub
 * first, then collapse — a full key is long enough to match before masking
 * shortens it.
 */

// Two rules, because one is not enough and the obvious one over-reaches.
//
// PREFIXED catches the vendor formats by their prefix. A `{12,}` run of plain
// alphanumerics does NOT catch a real OpenAI key — `sk-svcacct-AbCd…` has a
// hyphen at character 11 — so the character class has to include `-` and `_`.
//
// LONG_TOKEN is the catch-all for opaque blobs (a base64 service account, an
// unprefixed key). Length alone flags legitimate identifiers: Vertex's own
// quota error contains `global_online_prediction_requests_per_base_model`, 47
// characters that must survive. So a long run is only redacted when it also
// looks random — mixed case AND a digit, which every key format has and a
// snake_case identifier does not.
const PREFIXED =
    // `AIza` carries NO separator — a Google key is `AIzaSy…` straight into
    // base64url — so listing it with the `[-_]` group made that branch dead
    // code. It gets its own alternative.
    /(Bearer\s+\S+)|\bAIza[A-Za-z0-9_-]{20,}|\b(?:sk|rk|pk|fw|gsk|xai|ghp|glpat|github_pat)[-_][A-Za-z0-9_-]{10,}/gi;
const LONG_TOKEN = /\b[A-Za-z0-9+_-]{32,}={0,2}\b/g;

/**
 * Two ways a long run earns redaction, because one missed a whole class.
 *
 * Mixed case plus a digit covers base64 and most vendor keys. It does NOT cover
 * a lowercase hex or binary-style token — 40 characters of `0-9a-f` has a digit
 * and no uppercase — which is a common bearer format, so length alone carries
 * the second rule.
 *
 * Every quantifier here is open-ended (`{n,}`). An exact count is worse than no
 * rule: it redacts the first n characters and forwards the rest of the key.
 *
 * The trade is deliberate. A 40+ character snake_case identifier carrying a
 * digit gets redacted too, which costs a few words of an error message. Sending
 * a live credential to a chat channel costs more.
 */
const looksRandom = (t) =>
    (/[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t)) ||
    // Anchored to LONG_TOKEN's own floor of 32, not higher. A 32-39 character
    // run is exactly the canonical 16-byte hex secret, and a higher floor here
    // left that class — the one this rule was added for — unredacted. The floor
    // is not what protects the identifier this file must not eat:
    // `global_online_prediction_requests_per_base_model` survives at any length
    // because it carries no digit.
    (t.length >= 32 && /[0-9]/.test(t));

const collapse = (text) =>
    text
        .replace(PREFIXED, '[redacted]')
        .replace(LONG_TOKEN, (m) => (looksRandom(m) ? '[redacted]' : m))
        .replace(/\*{6,}/g, '***')
        .replace(/\s+/g, ' ')
        .trim();

/** The vendor's message, stripped of the jest frame around it. */
function causeOf(failure) {
    // eslint-disable-next-line no-control-regex
    const lines = String(failure).replace(/\u001b\[[0-9;]*m/g, '').split('\n');
    // Our own classifier speaks first when it fires — it already names the cause.
    const credential = lines.find((l) => /CREDENTIAL failure/.test(l));
    if (credential) {
        const said = lines.find((l) => /Provider said:/.test(l));
        return `dead credential — ${collapse((said ?? '').replace(/.*Provider said:\s*/, '')) || 'see log'}`;
    }
    const apiError = lines.find((l) => /(AI_APICallError|AI_RetryError):/.test(l));
    if (apiError) return collapse(apiError.replace(/^.*?Error:\s*/, ''));
    // Jest prints BOTH sides of a toMatchObject diff: Expected lines start with
    // `-`, Received with `+`. Matching "reasoned: false" anywhere reported the
    // INVERSE cause for a row pinned `reasons: false` — its Expected side is
    // literally `- "reasoned": false`, so a row going red because the model
    // STARTED reasoning (the event those rows exist to catch) was announced as
    // "billed no reasoning tokens", sending whoever triages to rotate a key.
    const received = lines.find((l) =>
        /^\s*\+\s.*"reasoned":\s*(true|false)/.test(l),
    );
    if (received) {
        return /"reasoned":\s*false/.test(received)
            ? 'returned 200 but billed NO reasoning tokens — the silent drift this tier exists to catch'
            : 'returned 200 and STARTED billing reasoning — a row pinned `reasons: false` no longer holds, the upstream config changed';
    }
    return collapse(lines.find((l) => l.trim()) ?? 'see log');
}

function main() {
    const [file] = process.argv.slice(2);
    if (!file) {
        console.log('Could not summarize: no jest report path given.');
        return;
    }

    let report;
    try {
        report = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        // Never let the reporter be the reason the alert says nothing.
        console.log(`Could not read the jest report (${err.message}). Open the run for the failures.`);
        return;
    }

    const failed = [];
    for (const suite of report.testResults ?? []) {
        for (const t of suite.assertionResults ?? []) {
            if (t.status !== 'failed') continue;
            // Row titles are "<brand> — <why>"; the brand is the actionable half.
            const brand = (t.title ?? '').split('—')[0].trim() || t.title;
            failed.push({ brand, cause: causeOf((t.failureMessages ?? []).join('\n')) });
        }
    }

    if (!failed.length) {
        console.log('The job failed but no individual row did — the failure is in setup, not a provider. Open the run.');
        return;
    }

    // Group by cause: five rows dying on one dead key is ONE problem, and
    // listing it five times is how a reader concludes it is five.
    const byCause = new Map();
    for (const { brand, cause } of failed) {
        if (!byCause.has(cause)) byCause.set(cause, []);
        byCause.get(cause).push(brand);
    }

    const lines = [`${failed.length} row(s) failed, ${byCause.size} distinct cause(s):`, ''];
    for (const [cause, brands] of byCause) {
        lines.push(`• ${brands.join(', ')}`);
        lines.push(`  ↳ ${cause.slice(0, 220)}`);
    }

    let out = lines.join('\n');
    if (out.length > LIMIT) out = `${out.slice(0, LIMIT - 40)}\n… truncated, open the run`;
    console.log(out);
}

main();
