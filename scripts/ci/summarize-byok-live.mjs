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
const collapse = (text) =>
    text.replace(/\*{6,}/g, '***').replace(/\s+/g, ' ').trim();

/** The vendor's message, stripped of the jest frame around it. */
function causeOf(failure) {
    const lines = String(failure).split('\n');
    // Our own classifier speaks first when it fires — it already names the cause.
    const credential = lines.find((l) => /CREDENTIAL failure/.test(l));
    if (credential) {
        const said = lines.find((l) => /Provider said:/.test(l));
        return `dead credential — ${collapse((said ?? '').replace(/.*Provider said:\s*/, '')) || 'see log'}`;
    }
    const apiError = lines.find((l) => /(AI_APICallError|AI_RetryError):/.test(l));
    if (apiError) return collapse(apiError.replace(/^.*?Error:\s*/, ''));
    const expected = lines.find((l) => /reasoned:\s*false/.test(l));
    if (expected) return 'returned 200 but billed NO reasoning tokens — the silent drift this tier exists to catch';
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
