// Review-chain wiring ledger — a deterministic, no-key LINT/tripwire (NOT
// behavioral coverage). It gates two things only: a boundary that lost a
// resilience marker it had (regression), and a new LLM.run( call-site with no
// manifest entry (an undeclared phase). Proving recovery actually WORKS is the
// job of shape-invariance.js + the per-boundary .spec.ts contract tests, not
// this. Its teeth are regression + discovery, nothing more.
//
//   node evals/review-chain/run.js          # print the ledger
//   node evals/review-chain/run.js --gate   # exit 1 on a regression / new gap
//
// Exit: 0 pass / 1 gate (regression or undeclared call-site) / 2 infra.
//
// WHAT this proves — and what it does NOT.
//  - PROVES (statically): every phase that turns model output into structured
//    data is WIRED to the shared resilience — it routes through the structured
//    executor (`schema:` → tier-a/tier-a2 recovery in structured-review-call) OR
//    uses the shared shape layer (`normalizeEnvelope` / `extractJsonFromText`) —
//    rather than a bespoke `JSON.parse` on raw model output that bypasses it.
//    This is exactly the class that bit the kody-rules shard (a bare `[]` that
//    failed the wire schema, dropped silently) — the fix is now a REGRESSION
//    GATE: strip the shard's `recoverEnvelopeShape` and this eval goes red.
//  - PROVES (discovery): no phase escapes. Every real `LLM.run(...)` /
//    `runStructuredReviewCall(...)` / `runTextReviewCall(...)` call-site in the
//    review chain must be claimed by a manifest entry — add an LLM-calling phase
//    without declaring how it handles the zoo and this eval fails.
//  - Does NOT re-prove the RECOVERY LOGIC itself (that `[]`→`{violations:[]}`
//    etc. is correct) — that lives in the per-boundary contract specs
//    (structured-review-call.spec / structured-output-repair.spec + the 42-row
//    boundary matrices). This ledger asserts the ARCHITECTURE; those assert the
//    behavior. Together = the whole-chain guarantee.
//  - Does NOT run a model. The live metamorphic legs (real finder/shard/severity
//    seams on a fixture PR, report-only, needs keys) are a separate Layer 2.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GATE = process.argv.includes('--gate');

// ── the manifest: every output-processing boundary in the review chain ────────
// `requires` is the resilience FLOOR this boundary must keep (regression guard).
//   'schema'    — routes a `schema:` through the structured executor (tier-a/a2)
//   'shape'     — uses normalizeEnvelope OR extractJsonFromText on the output
//   'recover'   — opts into envelope-shape recovery (the shard's bare-array fix)
// `accepted` marks a KNOWN, non-gating posture (degrades safe / parallel
// extractor) — visible in the ledger with its reason, tracked but not blocking.
// `declined` marks a boundary that MUST NOT recover off-schema output by design.
// `noInvoke` marks a boundary that reaches the model through the agent-loop
// runner (not a direct LLM.run call-site), so discovery won't see it — it is
// still checked for resilience regressions.
const BOUNDARIES = [
    { phase: 'finder', files: ['libs/code-review/infrastructure/agents/core/finder.agent.ts'], requires: ['schema', 'shape'] },
    { phase: 'verifier', files: ['libs/code-review/infrastructure/agents/core/verifier.agent.ts'], requires: ['shape'], noInvoke: true, note: 'agent-loop; extractVerdict → normalizeEnvelope (scalar)' },
    { phase: 'dedup', files: ['libs/code-review/pipeline/stages/agent-review.stage.ts'], requires: ['schema', 'shape'] },
    { phase: 'kody-rules-shard', files: ['libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts'], requires: ['schema', 'recover'], note: 'bare-array recovery (#1786) — floor includes recoverEnvelopeShape' },
    { phase: 'kody-rules-compiler', files: ['libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler.ts'], declined: true, note: 'produces a REGEX detector — recovering off-schema output would ship a wrong detector; declines by design' },
    { phase: 'kodyRulesAnalysis', files: ['libs/ee/codeBase/kodyRulesAnalysis.service.ts'], requires: ['schema', 'shape'] },
    { phase: 'kodyRulesPrLevel', files: ['libs/ee/codeBase/kodyRulesPrLevelAnalysis.service.ts'], requires: ['schema', 'shape'] },
    { phase: 'kodyIssues-merge', files: ['libs/ee/codeBase/kodyIssuesAnalysis.service.ts'], requires: ['schema'], note: 'wrong shape → re-ask by design (not opted into recover)' },
    { phase: 'commentAnalysis', files: ['libs/code-review/infrastructure/adapters/services/commentAnalysis.service.ts'], requires: ['schema'] },
    { phase: 'commentManager', files: ['libs/code-review/infrastructure/adapters/services/commentManager.service.ts'], requires: ['schema'] },
    { phase: 'llmAnalysis', files: ['libs/code-review/infrastructure/adapters/services/llmAnalysis.service.ts'], requires: ['schema'] },
    { phase: 'safeguard', files: ['libs/code-review/infrastructure/adapters/services/safeguardPipeline.service.ts'], requires: ['schema', 'shape'] },
    { phase: 'suggestionLLMValidator', files: ['libs/code-review/infrastructure/adapters/services/suggestionLLMValidator.service.ts'], requires: ['schema'] },
    { phase: 'documentation-planner', files: ['libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service.ts'], requires: ['schema', 'shape'] },
    { phase: 'documentation-search', files: ['libs/code-review/infrastructure/adapters/services/documentation-search-exa.service.ts'], requires: ['schema'] },
    { phase: 'llmResponseProcessor', files: ['libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform.ts'], requires: ['shape'], noInvoke: true, note: 'processor: extractJsonFromText + normalizeEnvelope' },
    // ── accepted, non-gating: text-only or a parallel/bespoke extractor. Tracked
    //    so the ledger stays honest; degrade-safe, so not a silent-loss blocker.
    { phase: 'classify-severity', files: ['libs/code-review/infrastructure/agents/engine/classify-severity.ts', 'libs/code-review/infrastructure/agents/engine/severity-prompt.ts'], accepted: true, note: 'text call; parseSeverityResponse is bespoke and degrades to all-medium (no dropped findings) — candidate to wire onto extractJsonFromText' },
    { phase: 'format-suggestion-content', files: ['libs/code-review/infrastructure/agents/engine/format-suggestion-content.ts'], accepted: true, note: 'text call; output is used as prose, no JSON parse — no shape concern' },
    { phase: 'reference-detector', files: ['libs/ai-engine/infrastructure/adapters/services/reference-detector.service.ts'], accepted: true, note: 'uses a PARALLEL extractor (extractJsonFromResponse) with its OWN 42-row contract (aggressive bracket-slice + fail-safe) — tested, not a silent-loss gap; consolidating onto extractJsonFromText is a semantics migration, not a swap' },
];

function read(rel) {
    try {
        return fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
        return null;
    }
}

// The resilience markers present in a boundary's concatenated source. Pure —
// the unit under self-test. `\(`/`:\s*true` anchors keep a bare mention in
// prose from reading as a real wiring.
function detectMarkers(src) {
    return {
        schema: /\bschema:/.test(src),
        shape:
            /normalizeEnvelope\(/.test(src) ||
            /extractJsonFromText\(/.test(src),
        recover: /recoverEnvelopeShape:\s*true/.test(src),
    };
}

// Read a boundary's file(s) off disk and detect its markers (records missing).
function detect(files) {
    let src = '';
    const missing = [];
    for (const f of files) {
        const c = read(f);
        if (c == null) missing.push(f);
        else src += c + '\n';
    }
    return { missing, ...detectMarkers(src) };
}

// Pure analysis: boundaries × their detected markers × the discovered call-sites
// → ledger rows + a gating-failure count. `detectFor(files)` returns
// `{ missing, schema, shape, recover }`; `callSites` is the list of files that
// actually invoke an LLM. No fs, no process — so the self-test drives it with
// synthetic inputs and asserts the two gates fire.
function analyze({ boundaries, detectFor, callSites }) {
    const claimed = new Set(boundaries.flatMap((b) => b.files));
    const rows = [];
    let gaps = 0;

    for (const b of boundaries) {
        const d = detectFor(b.files);
        if (d.missing && d.missing.length) {
            rows.push({ phase: b.phase, status: 'MISSING-FILE', detail: d.missing.join(', '), gate: true });
            gaps++;
            continue;
        }
        if (b.declined) {
            rows.push({ phase: b.phase, status: 'DECLINED', detail: b.note });
            continue;
        }
        if (b.accepted) {
            rows.push({ phase: b.phase, status: 'ACCEPTED', detail: b.note });
            continue;
        }
        const have = [];
        const lost = [];
        for (const req of b.requires) {
            (d[req] ? have : lost).push(req);
        }
        if (lost.length) {
            rows.push({ phase: b.phase, status: 'REGRESSED', detail: `lost: ${lost.join('+')} (has: ${have.join('+') || 'none'})${b.note ? ' — ' + b.note : ''}`, gate: true });
            gaps++;
        } else {
            rows.push({ phase: b.phase, status: 'WIRED', detail: `${have.join('+')}${b.note ? ' — ' + b.note : ''}` });
        }
    }

    for (const f of (callSites || []).filter((f) => !claimed.has(f))) {
        rows.push({ phase: '(undeclared)', status: 'UNDECLARED', detail: `${f} calls an LLM but has no manifest entry — declare its resilience posture`, gate: true });
        gaps++;
    }
    return { rows, gaps };
}

// ── discovery: every real invocation site must be claimed by a boundary ───────
function discoverCallSites() {
    const cmd =
        `grep -rlE '\\bLLM\\.run\\(|runStructuredReviewCall\\(|runTextReviewCall\\(' ` +
        `--include='*.ts' libs/code-review libs/ee/codeBase libs/ai-engine ` +
        `| grep -v '\\.spec\\.ts' || true`;
    let out = '';
    try {
        out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
        console.error(`[review-chain] INFRA: discovery grep failed: ${e.message}`);
        process.exit(2);
    }
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── exports (self-test drives the pure pieces) ────────────────────────────────
module.exports = { BOUNDARIES, detectMarkers, analyze };

// ── CLI ───────────────────────────────────────────────────────────────────────
function main() {
    const { rows, gaps } = analyze({
        boundaries: BOUNDARIES,
        detectFor: detect,
        callSites: discoverCallSites(),
    });

    const icon = { WIRED: '✅', DECLINED: '⛔', ACCEPTED: '⚠️ ', REGRESSED: '❌', UNDECLARED: '❌', 'MISSING-FILE': '❌' };
    console.log('\n review-chain LLM-resilience ledger\n');
    for (const r of rows) {
        console.log(`  ${icon[r.status] || '  '} ${r.phase.padEnd(24)} ${r.status.padEnd(13)} ${r.detail || ''}`);
    }
    const count = (s) => rows.filter((r) => r.status === s).length;
    console.log(
        `\n ${count('WIRED')} wired · ${count('DECLINED')} declined-by-design · ${count('ACCEPTED')} accepted-gap · ${gaps} gating failure(s)`,
    );

    if (gaps > 0) {
        console.error('\n review-chain: a phase regressed below its resilience floor, or an LLM call-site is undeclared.');
        process.exit(GATE ? 1 : 0);
    }
    console.log('\n review-chain: every declared phase is wired to the shared resilience.');
    process.exit(0);
}

if (require.main === module) {
    main();
}
