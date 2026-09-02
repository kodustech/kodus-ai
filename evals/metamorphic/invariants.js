// Metamorphic relations for the review pipeline — pure transforms + equivalence
// oracles. A metamorphic test does not compare output to a golden label; it runs
// the SAME production function on an input and on a semantics-preserving
// transform of that input, then asserts the required relation between the two
// outputs. This catches the class of bug mutation/contract tests cannot: an
// output that is valid in isolation but changes when it must not (ordering
// nondeterminism, context-sensitivity, whitespace sensitivity).
//
// Each relation exposes: transform(input) and holds(outA, outB) → {ok, detail}.

// Deterministic RNG so permutations are reproducible across runs.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle(arr, seed = 1) {
    const rng = mulberry32(seed);
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ── MR1: input-order invariance ─────────────────────────────────────────────
// Reordering the input suggestions must not change WHICH suggestions survive,
// nor the final ORDER they are presented in. If two suggestions are equal under
// the sort key, a stable .sort() leaves their relative order at the mercy of the
// upstream order — so the same PR renders differently run-to-run. The invariant
// is: output id-sequence is fully determined by the input SET, not its order.
const orderInvariance = {
    name: 'MR1 file/suggestion-order invariance',
    transform: (suggestions, seed) => shuffle(suggestions, seed),
    // outA/outB are ordered arrays; compare the id-sequence exactly.
    holds: (outA, outB) => {
        const seq = (xs) => xs.map((s) => s && s.id).join('|');
        const a = seq(outA);
        const b = seq(outB);
        return {
            ok: a === b,
            detail: a === b ? '' : `order differs:\n  A=${a}\n  B=${b}`,
        };
    },
};

// ── MR2: duplicate context does not downgrade severity ───────────────────────
// Adding a duplicate copy of a finding (the "N models each echo the same issue"
// case, and the dedup-input case) must never LOWER any surviving finding's
// severity. A classifier that averages or is distracted by repetition would
// silently soften a real HIGH into a MEDIUM. Relation: for every finding key
// present in both runs, severity(withDup) >= severity(base).
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const sevRank = (s) => SEV_RANK[String(s || '').toLowerCase()] ?? 2;

const dupContextNoDowngrade = {
    name: 'MR2 duplicate context does not downgrade severity',
    // duplicate every finding once (stable key = file+line+label).
    transform: (findings) => findings.flatMap((f) => [f, { ...f }]),
    keyOf: (f) => `${f.relevantFile}:${f.relevantLinesStart}:${f.label}`,
    holds: function (baseOut, dupOut) {
        const worst = new Map();
        for (const f of dupOut) {
            const k = this.keyOf(f);
            worst.set(k, Math.min(worst.get(k) ?? 9, sevRank(f.severity)));
        }
        const violations = [];
        for (const f of baseOut) {
            const k = this.keyOf(f);
            if (!worst.has(k)) continue; // dropped is MR-neutral here
            if (worst.get(k) < sevRank(f.severity)) {
                violations.push(
                    `${k}: base=${f.severity} → dup dropped to rank ${worst.get(k)}`,
                );
            }
        }
        return {
            ok: violations.length === 0,
            detail: violations.join('\n'),
        };
    },
};

// ── MR3: whitespace-only change is a no-op ───────────────────────────────────
// A hunk that only reindents / reflows must not manufacture findings. Relation:
// findings(codeWithWhitespaceNoise) ⊆ findings(code) — the noise adds nothing.
// The transform reindents every added line; the oracle is subset-by-key.
const whitespaceNoOp = {
    name: 'MR3 whitespace-only change adds no findings',
    transform: (diff) =>
        String(diff)
            .split('\n')
            .map((l) => (l.startsWith('+') ? '+    ' + l.slice(1).trimStart() : l))
            .join('\n'),
    keyOf: (f) => `${f.relevantFile}:${f.relevantLinesStart}:${f.label}`,
    holds: function (baseOut, noisyOut) {
        const baseKeys = new Set(baseOut.map(this.keyOf));
        const extra = noisyOut
            .map(this.keyOf)
            .filter((k) => !baseKeys.has(k));
        return {
            ok: extra.length === 0,
            detail: extra.length ? `whitespace manufactured: ${extra.join(', ')}` : '',
        };
    },
};

module.exports = {
    mulberry32,
    shuffle,
    sevRank,
    orderInvariance,
    dupContextNoDowngrade,
    whitespaceNoOp,
};
