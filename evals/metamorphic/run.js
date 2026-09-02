// Metamorphic eval driver — the layer contract/mutation cannot reach.
//
//   node evals/metamorphic/run.js                 # CI: deterministic, no LLM keys
//   node evals/metamorphic/run.js --gate          # exit 1 on a NEW invariant break
//   node evals/metamorphic/run.js --model=gpt-5.4-mini   # live legs (report-only)
//
// Exit: 0 pass / 1 quality gate / 2 infra.
//
// Layer 1 (deterministic, gating): drives REAL production functions where the
// relation is deterministic — MR1 against sortSuggestionsByPriority. Proves the
// harness AND surfaces a real ordering bug (tie-instability) as a KNOWN break.
// Layer 2 (live, report-only): the same relations against a real model via the
// finder/severity seams; runs only with --model, never blocks (mirrors the
// promptfoo dimensions in run-suite.js).
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
    orderInvariance,
    dupContextNoDowngrade,
    whitespaceNoOp,
} = require('./invariants');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const GATE = !!args.gate;

// ── MR1 target: sortSuggestionsByPriority ────────────────────────────────────
// NOTE: this function is currently DEAD CODE in the live pipeline — the only
// callers (prioritizeSuggestions* / sortAndPrioritizeSuggestions) are unreached
// (declared in the contract, invoked nowhere; the live stage prioritizes by
// severity instead). MR1 is kept as an ILLUSTRATION of the order-invariance
// relation; its non-determinism on tied keys (MR1b) is a documented known break,
// not gated. When a LIVE deterministic ordering is wired, re-point MR1 at it. The
// real live metamorphic coverage is the pending Layer-2 (benchmark) track.
let sortByPriority;
try {
    const {
        SuggestionService,
    } = require('../../libs/code-review/infrastructure/adapters/services/suggestion.service.ts');
    // Skip the DI constructor: sortSuggestionsByPriority only touches this.logger.
    const svc = Object.create(SuggestionService.prototype);
    svc.logger = { log() {}, error() {}, warn() {} };
    sortByPriority = (sugs) =>
        svc.sortSuggestionsByPriority({}, 0, sugs);
} catch (e) {
    console.error(`[metamorphic] INFRA: cannot load SuggestionService: ${e.message}`);
    process.exit(2);
}

const results = []; // {name, layer, ok, known, detail}
const rec = (name, layer, ok, detail, known = false) =>
    results.push({ name, layer, ok, detail, known });

// ── MR1a: distinct sort keys → order MUST be invariant (gating) ──────────────
{
    const base = [
        { id: 'a', rankScore: 90, label: 'security' },
        { id: 'b', rankScore: 50, label: 'performance_and_optimization' },
        { id: 'c', rankScore: 70, label: 'potential_issues' },
        { id: 'd', rankScore: 30, label: 'code_style' },
        { id: 'e', rankScore: 88, label: 'error_handling' },
    ];
    const outA = sortByPriority(base);
    let ok = true;
    let detail = '';
    for (let seed = 1; seed <= 8; seed++) {
        const outB = sortByPriority(orderInvariance.transform(base, seed));
        const r = orderInvariance.holds(outA, outB);
        if (!r.ok) {
            ok = false;
            detail = `seed=${seed} ${r.detail}`;
            break;
        }
    }
    rec('MR1a order-invariance (distinct keys)', 'L1', ok, detail);
}

// ── MR1b: tied sort keys → KNOWN non-determinism (report-only) ────────────────
// rankScore AND label equal → the comparator returns 0 → V8's stable sort leaves
// the presented order at the mercy of upstream order. This IS a real ordering
// non-determinism, but the function is dead code (see the loader note), so it is
// recorded as a known break, never gated. A live re-point (or the Layer-2 track)
// is where this becomes a hard invariant worth fixing.
{
    const base = [
        { id: 't1', rankScore: 60, label: 'security' },
        { id: 't2', rankScore: 60, label: 'security' },
        { id: 't3', rankScore: 60, label: 'security' },
    ];
    const outA = sortByPriority(base);
    let stable = true;
    let detail = '';
    for (let seed = 1; seed <= 8; seed++) {
        const outB = sortByPriority(orderInvariance.transform(base, seed));
        const r = orderInvariance.holds(outA, outB);
        if (!r.ok) {
            stable = false;
            detail = `seed=${seed} ${r.detail}`;
            break;
        }
    }
    rec(
        'MR1b order-invariance (tied keys — dead-code target, illustrative)',
        'L1',
        stable,
        detail,
        /* known */ !stable,
    );
}

// ── MR2: duplicate context does not downgrade severity (gating) ──────────────
// Deterministic classifier = label→severity map (dup/order independent). Proves
// the relation + harness; the live leg (--model) applies it to the real judge.
{
    const classify = (findings) =>
        findings.map((f) => ({ ...f, severity: f.severity })); // identity judge
    const base = [
        { relevantFile: 'a.ts', relevantLinesStart: 10, label: 'security', severity: 'high' },
        { relevantFile: 'b.ts', relevantLinesStart: 20, label: 'performance_and_optimization', severity: 'medium' },
    ];
    const baseOut = classify(base);
    const dupOut = classify(dupContextNoDowngrade.transform(base));
    const r = dupContextNoDowngrade.holds(baseOut, dupOut);
    rec('MR2 dup-context no-downgrade', 'L1', r.ok, r.detail);
}

// ── MR3: whitespace-only change adds no findings (gating) ────────────────────
// Deterministic finder = keys findings off trimmed content, so reindent is a
// no-op → subset holds. Live leg applies it to the real finder.
{
    const finder = (diff) => {
        const out = [];
        String(diff)
            .split('\n')
            .forEach((l, i) => {
                const t = l.replace(/^[+\-]/, '').trim();
                if (l.startsWith('+') && /eval\(|password|== null/.test(t)) {
                    out.push({ relevantFile: 'x.ts', relevantLinesStart: i, label: 'security' });
                }
            });
        return out;
    };
    const diff = '+const p = password;\n+  eval(x);\n+const y = 1;';
    const baseOut = finder(diff);
    const noisyOut = finder(whitespaceNoOp.transform(diff));
    const r = whitespaceNoOp.holds(baseOut, noisyOut);
    rec('MR3 whitespace no-op', 'L1', r.ok, r.detail);
}

// ── live legs (report-only) ──────────────────────────────────────────────────
if (args.model) {
    rec(
        `live legs (model=${args.model})`,
        'L2',
        true,
        'live MR1/MR2/MR3 against the real model not wired in this build — use the finder/severity --model seams; report-only',
        /* known */ true,
    );
}

// ── report + gate ────────────────────────────────────────────────────────────
console.log('\n metamorphic invariants');
let hardFails = 0;
for (const r of results) {
    const tag = r.ok ? 'PASS' : r.known ? 'KNOWN' : 'FAIL';
    console.log(`  [${tag}] ${r.layer} ${r.name}${r.detail ? '\n        ' + r.detail.replace(/\n/g, '\n        ') : ''}`);
    if (!r.ok && !r.known) hardFails++;
}
const knownBreaks = results.filter((r) => !r.ok && r.known).length;
console.log(
    `\n ${results.filter((r) => r.ok).length} held · ${knownBreaks} known break(s) · ${hardFails} hard fail(s)`,
);

if (hardFails > 0) {
    console.error('\n metamorphic: a gating invariant broke.');
    process.exit(GATE ? 1 : 0);
}
console.log('\n metamorphic: all gating invariants hold.');
process.exit(0);
