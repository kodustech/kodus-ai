#!/usr/bin/env node
/**
 * llm-parse-log-report — per-STAGE report of LLM JSON-output problems, from an
 * app-log dump. Langfuse can't answer this (its generation spans carry neither
 * the stage nor the structured-output signal); the app logs can, because every
 * recovery/degradation line is tagged by `runName` (the stage) or a stage
 * prefix. This turns that same log source your audit already reads into a
 * stage × shape × recovered/failed table.
 *
 *   node scripts/llm-parse-log-report.js <dump.log>
 *   cat dump.log | node scripts/llm-parse-log-report.js
 *   kubectl logs ... | node scripts/llm-parse-log-report.js
 *
 * Input: one log entry per line. Each line may be JSON (the message is read from
 * .message / .msg / .log / .error, plus a nested .metadata.err) or plain text.
 *
 * Two families are counted:
 *   RECOVERED  (the #1786 fix caught the shape — only present once deployed):
 *     "[structured-output] recovered <runName> via deterministic JSON repair"
 *     "[LLM_ENVELOPE] recovered <runName> via deterministic envelope re-shape (… → {<key>})"
 *   FAILED / degraded (present today, pre-deploy too):
 *     "[kody-rules-shard] file|PR-scope shard failed … degrading to zero findings: <err>"
 *     "[DEDUP] … keeping all …"  /  "[DEDUP-CROSS] … keeping all"
 *   plus the raw parse signatures ("No object generated …", "did not match
 *   schema …") wherever they appear, so the failed rows break down by SHAPE.
 */
'use strict';

// ── shape of the underlying model output, from the error text ─────────────────
function shapeOf(s) {
    s = String(s || '');
    if (/Unexpected end of JSON input|Text:\s*\.(?:\s|$)|Text:\s*$/.test(s)) return 'empty';
    if (/did not match schema|Type validation failed/i.test(s)) {
        if (/Value:\s*\[\s*\]/.test(s)) return 'schema:array-empty';
        if (/Value:\s*\{/.test(s)) return 'schema:bad-field';
        return 'schema:other';
    }
    if (/Text:\s*```|```json/i.test(s)) return 'markdown-fenced';
    if (/<think>/i.test(s)) return 'think-leak';
    if (/Text:\s*\[\s*\]/.test(s)) return 'array-as-text';
    if (/could not parse|JSON parsing failed|No object generated/i.test(s)) return 'parse-other';
    return 'other';
}

// ── pull the human message out of a (possibly JSON) log line ──────────────────
function lineText(line) {
    const t = line.trim();
    if (!t) return '';
    if (t[0] === '{') {
        try {
            const o = JSON.parse(t);
            const parts = [o.message, o.msg, o.log, o.error && (o.error.message || o.error)];
            const meta = o.metadata || {};
            parts.push(meta.err && (meta.err.message || meta.err), meta.error);
            return parts.filter(Boolean).map(String).join(' | ');
        } catch {
            /* not JSON → raw */
        }
    }
    return t;
}

// ── accumulators ──────────────────────────────────────────────────────────────
const recovered = {}; // stage -> { 'json-repair': n, 'envelope-reshape': n }
const reshapeKeys = {}; // envelopeKey -> n
const failed = {}; // stage -> shape -> n
const chokeErr = {}; // runName -> n   ([LLM-ERROR] terminal)
let recTotal = 0, failTotal = 0, lines = 0;

function bump(obj, k1, k2) {
    obj[k1] = obj[k1] || {};
    obj[k1][k2] = (obj[k1][k2] || 0) + 1;
}

function classify(msg) {
    let m;
    // RECOVERED — deterministic JSON repair (tier-a)
    if ((m = msg.match(/\[structured-output\] recovered (\S+) via deterministic JSON repair/))) {
        bump(recovered, m[1], 'json-repair'); recTotal++; return;
    }
    // RECOVERED — envelope re-shape (tier-a2)
    if ((m = msg.match(/\[LLM_ENVELOPE\] recovered (\S+) via deterministic envelope re-shape[^{]*\{([^}]+)\}/))) {
        bump(recovered, m[1], 'envelope-reshape'); reshapeKeys[m[2]] = (reshapeKeys[m[2]] || 0) + 1; recTotal++; return;
    }
    // FAILED — kody-rules shard (file / PR-scope)
    if ((m = msg.match(/\[kody-rules-shard\] (file shard failed|PR-scope shard failed)/))) {
        const stage = m[1].startsWith('file') ? 'shard:file' : 'shard:pr';
        bump(failed, stage, shapeOf(msg)); failTotal++; return;
    }
    // FAILED — dedup family
    if (/\[DEDUP-CROSS\][^]*keeping all/.test(msg)) { bump(failed, 'dedup:cross', shapeOf(msg)); failTotal++; return; }
    if (/\[DEDUP\][^]*keeping all/.test(msg)) {
        const shape = /empty result/.test(msg) ? 'empty' : shapeOf(msg);
        bump(failed, 'dedup', shape); failTotal++; return;
    }
    // FAILED — merge / kody-issues + generic structured failures carrying a runName
    if (/mergeSuggestionsIntoIssues|Error in mergeSuggestionsIntoIssues/.test(msg)) { bump(failed, 'merge', shapeOf(msg)); failTotal++; return; }
    // [LLM-ERROR] terminal at the failover chokepoint (has the runName)
    if ((m = msg.match(/\[LLM-ERROR\]\s+(\S+):/))) { chokeErr[m[1]] = (chokeErr[m[1]] || 0) + 1; return; }
    // A bare parse signature with no stage prefix we recognize → bucket as unknown-stage
    if (/No object generated|did not match schema|JSON parsing failed/i.test(msg)) {
        bump(failed, '(unattributed)', shapeOf(msg)); failTotal++;
    }
}

// ── drive ─────────────────────────────────────────────────────────────────────
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function rpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function report() {
    console.log(`\nlines: ${lines} | recovered: ${recTotal} | failed/degraded: ${failTotal}` +
        (recTotal + failTotal ? ` | recovery rate: ${(100 * recTotal / (recTotal + failTotal)).toFixed(1)}%` : ''));

    if (recTotal) {
        console.log('\n=== RECOVERED — the #1786 fix caught the shape (per stage) ===');
        console.log(pad('stage', 34) + rpad('json-repair', 12) + rpad('reshape', 10) + rpad('total', 8));
        for (const [st, m] of Object.entries(recovered).sort((a, b) => sum(b[1]) - sum(a[1]))) {
            console.log(pad(st, 34) + rpad(m['json-repair'] || 0, 12) + rpad(m['envelope-reshape'] || 0, 10) + rpad(sum(m), 8));
        }
        if (Object.keys(reshapeKeys).length) console.log('  reshaped envelope keys: ' + JSON.stringify(reshapeKeys));
    } else {
        console.log('\n(no RECOVERED lines — expected pre-deploy of the #1786 fix; only degradation is present)');
    }

    console.log('\n=== FAILED / degraded — per stage × output shape ===');
    const shapes = ['empty', 'schema:array-empty', 'schema:bad-field', 'schema:other', 'markdown-fenced', 'think-leak', 'array-as-text', 'parse-other', 'other'];
    console.log(pad('stage', 20) + shapes.map(s => rpad(s.slice(0, 11), 12)).join('') + rpad('total', 8));
    for (const [st, m] of Object.entries(failed).sort((a, b) => sum(b[1]) - sum(a[1]))) {
        console.log(pad(st, 20) + shapes.map(s => rpad(m[s] || '·', 12)).join('') + rpad(sum(m), 8));
    }

    if (Object.keys(chokeErr).length) {
        console.log('\n=== [LLM-ERROR] terminal at the failover chokepoint (per runName) ===');
        for (const [rn, n] of Object.entries(chokeErr).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
            console.log('  ' + rpad(n, 6) + '  ' + rn);
        }
    }
    console.log('');
}
function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }

const file = process.argv[2];
const src = file ? require('fs').createReadStream(file) : process.stdin;
const rl = require('readline').createInterface({ input: src, crlfDelay: Infinity });
rl.on('line', (line) => { lines++; const t = lineText(line); if (t) classify(t); });
rl.on('close', report);
