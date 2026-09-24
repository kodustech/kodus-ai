// Layer 2 (deterministic, no-key, GATING): shape-invariance metamorphic on the
// REAL shared resilience layer every wired boundary depends on.
//
//   node evals/review-chain/shape-invariance.js          # print
//   node evals/review-chain/shape-invariance.js --gate    # exit 1 on a break
//
// Exit: 0 pass / 1 gate / 2 infra.
//
// The metamorphic relation: a payload re-encoded in each of the #1786 wire
// shapes a real model emits (bare array, markdown-fenced, prose-wrapped, wrapper
// key {result:…}/{data:…}, renamed key, stringified JSON) MUST normalize to the
// SAME canonical envelope. Driven over MANY payloads — not one — so it proves
// CONTENT-invariance, not just encoding-invariance: a payload-dependent bug (a
// violation field colliding with a wrapper key, unicode, empty-string vs null,
// nested objects, many items) would slip a single-fixture test but is caught
// here. Drives the ACTUAL production functions (normalizeEnvelope +
// extractJsonFromText from @libs/llm/structured-output-repair), not a stand-in.
//
// Scope note: uses NON-EMPTY payloads. The empty-array case (`[]` → `{key:[]}`)
// is a caller-specific decision (liftEmptyArray, on the shard path only), pinned
// in structured-review-call.spec / structured-output-repair.spec — not a
// general shape-invariant, so it is deliberately out of this relation.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const GATE = process.argv.includes('--gate');

let normalizeEnvelope, extractJsonFromText;
try {
    ({
        normalizeEnvelope,
        extractJsonFromText,
    } = require('../../libs/llm/structured-output-repair'));
} catch (e) {
    console.error(`[shape-invariance] INFRA: cannot load structured-output-repair: ${e.message}`);
    process.exit(2);
}

const KEY = 'codeSuggestions';
const ALIASES = ['suggestions', 'findings'];

// Content-varied payloads (each a NON-EMPTY findings array). The point is that
// invariance must hold regardless of WHAT is inside, not just how it's wrapped.
const PAYLOADS = {
    'single item': [{ relevantFile: 'a.ts', suggestionContent: 'x', label: 'bug' }],
    'many items': Array.from({ length: 12 }, (_, i) => ({
        relevantFile: `f${i}.ts`,
        suggestionContent: `finding ${i}`,
        label: i % 2 ? 'security' : 'performance',
    })),
    'unicode + escapes': [{ relevantFile: 'ção.ts', suggestionContent: 'até "aspas"\n\tnova linha 🐛', label: 'bug' }],
    'empty-string vs null fields': [{ relevantFile: '', suggestionContent: '', existingCode: null, label: 'bug' }],
    'nested object in a field': [{ relevantFile: 'a.ts', suggestionContent: 'x', label: 'bug', meta: { severity: 'high', tags: ['a', 'b'] } }],
    // A violation field NAMED like a wrapper key must NOT be mistaken for the
    // envelope wrapper (normalizeEnvelope only unwraps at the top level).
    'field colliding with a wrapper key': [{ relevantFile: 'a.ts', suggestionContent: 'x', label: 'bug', data: [1, 2], result: 'ok', content: 'inner' }],
    'numbers/booleans in fields': [{ relevantFile: 'a.ts', suggestionContent: 'x', label: 'bug', relevantLinesStart: 10, relevantLinesEnd: 20, resolved: false }],
};

// Each encoding a real model has been seen to emit. `encode(data)` produces the
// wire value; the expected recovery is always `{ [KEY]: data }`.
const ENCODINGS = {
    'canonical {key:D}': (d) => ({ [KEY]: d }),
    'bare array D': (d) => d,
    'wrapper {result:{key:D}}': (d) => ({ result: { [KEY]: d } }),
    'wrapper {data:D} (bare under wrapper)': (d) => ({ data: d }),
    'renamed {suggestions:D}': (d) => ({ suggestions: d }),
    'renamed {findings:D}': (d) => ({ findings: d }),
    'stringified array': (d) => JSON.stringify(d),
    'stringified envelope': (d) => JSON.stringify({ [KEY]: d }),
    'markdown-fenced envelope': (d) => '```json\n' + JSON.stringify({ [KEY]: d }) + '\n```',
    'prose-wrapped envelope': (d) => 'Here are the findings:\n' + JSON.stringify({ [KEY]: d }) + '\nDone.',
};

// A string shape goes through the ONE text→JSON extractor first (as the wired
// boundaries do), then normalize — mirroring the real recovery order.
function recover(value) {
    let v = value;
    if (typeof v === 'string') {
        const extracted = extractJsonFromText(v);
        if (extracted != null) {
            try {
                v = JSON.parse(extracted);
            } catch {
                /* leave as string → normalizeEnvelope returns the original */
            }
        }
    }
    return normalizeEnvelope(v, KEY, ALIASES);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const results = [];
for (const [pName, data] of Object.entries(PAYLOADS)) {
    const canonical = { [KEY]: data };
    for (const [eName, encode] of Object.entries(ENCODINGS)) {
        let out;
        let err = null;
        try {
            out = recover(encode(data));
        } catch (e) {
            err = e.message;
        }
        const ok = !err && eq(out, canonical);
        results.push({ name: `${pName}  ×  ${eName}`, ok, detail: err ? `threw: ${err}` : ok ? '' : `→ ${JSON.stringify(out)}` });
    }
}

const fails = results.filter((r) => !r.ok);
console.log(`\n shape-invariance — ${Object.keys(PAYLOADS).length} payloads × ${Object.keys(ENCODINGS).length} encodings = ${results.length} cases\n`);
if (fails.length) {
    for (const r of fails) console.log(`  ❌ ${r.name}  ${r.detail}`);
} else {
    console.log('  ✅ every payload, in every model shape, recovers to its canonical envelope');
}
console.log(`\n ${results.length - fails.length}/${results.length} invariant holds`);

if (fails.length > 0) {
    console.error('\n shape-invariance: the shared resilience layer is NOT shape-invariant for some payload×shape.');
    process.exit(GATE ? 1 : 0);
}
console.log('\n shape-invariance: content-invariant across every #1786 model shape.');
process.exit(0);
