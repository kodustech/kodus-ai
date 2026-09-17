#!/usr/bin/env node
// Pulls the machine-readable verdict out of the investigation agent's final
// message (the last ```json fence) and writes investigation.json plus the human
// report without the fence. Advisory: on anything malformed it writes nothing,
// prints why, and exits 0 — the nightly message then goes out without a
// hypothesis instead of with a wrong one.
//
//   node evals/investigation/extract-investigation.js <agent-output.txt> <out-dir>
const fs = require('fs');
const path = require('path');

const VERDICTS = new Set(['regression', 'noise', 'eval', 'unclear']);
const CONFIDENCE = new Set(['alta', 'média', 'baixa']);

function extractInvestigation(raw) {
    const fences = [...String(raw || '').matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    if (!fences.length) return { error: 'no ```json block in the agent output' };
    const last = fences[fences.length - 1];
    let parsed;
    try {
        parsed = JSON.parse(last[1]);
    } catch (error) {
        return { error: `last json block does not parse: ${error.message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'json block is not an object' };
    if (!VERDICTS.has(parsed.verdict)) return { error: `unknown verdict: ${parsed.verdict}` };
    if (!CONFIDENCE.has(parsed.confidence)) return { error: `unknown confidence: ${parsed.confidence}` };
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return { error: 'empty summary' };

    const investigation = {
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        summary: parsed.summary.trim(),
        suspects: (Array.isArray(parsed.suspects) ? parsed.suspects : [])
            .filter((s) => s && typeof s === 'object' && (s.commit || s.file))
            .map((s) => ({ commit: String(s.commit || ''), file: String(s.file || ''), why: String(s.why || '') })),
        confirm: typeof parsed.confirm === 'string' ? parsed.confirm.trim() : '',
    };
    const report = String(raw).slice(0, last.index).trim();
    return { investigation, report };
}

module.exports = { extractInvestigation };

if (require.main === module) {
    const [input, outDir] = process.argv.slice(2);
    let raw = '';
    try {
        raw = fs.readFileSync(input, 'utf8');
    } catch (error) {
        console.log(`::notice::investigation output unreadable (${error.message}); the message goes out without a hypothesis`);
        process.exit(0);
    }
    const { investigation, report, error } = extractInvestigation(raw);
    if (error) {
        console.log(`::notice::investigation not used: ${error}`);
        process.exit(0);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'investigation.json'), JSON.stringify(investigation, null, 2));
    fs.writeFileSync(path.join(outDir, 'investigation.md'), report);
    console.log(`investigation: ${investigation.verdict} (${investigation.confidence})`);
}
