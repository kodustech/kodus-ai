// Kody-rules adherence eval: production's review, scored against every line
// that breaks a rule.
//
// Each case is one merged GitHub PR and the rule it breaks (github-cases.json,
// materialized by materialize-cases.js). production-review.js runs the review
// with production's own code: the rule saved through the save-time compile and
// loaded for review, the PR checked out by the self-hosted sandbox (exec
// included), the changed files through FetchChangedFilesStage, and
// AgentReviewStage with the Kody Rules agent (the team's generalist categories
// off). What the stage keeps is what is scored.
//
//   node evals/kody-rules/real-agent.js [--runs=3] [--model=<tier-0 id>] [--cases=<caseId,...>] [--limit=N] [--gate] [--output=<result.json>]
//
// The model routes through production's managed route (evals/shared/
// tier0-models.js applyModelEnv). Each run clones the PR's head, so it needs
// network to GitHub.
const fs = require('fs');
const path = require('path');

if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const RUNS = +(args.runs || 3);
const MODELKEY = args.model || 'deepseek-v4-flash@fireworks';
const DATASET = args.dataset || 'github-cases';
// CI gate: with --gate, exit non-zero if metrics fall below the model's floor.
// occurrence-recall varies a lot by model, so floors are PER-MODEL in
// kody-targets.json (occMin = observed − ~2·binomial-SE). --occ-min=/--spec-min=
// still override for ad-hoc runs; otherwise resolve the current model's floor
// (default 0 = no gate when the model has no calibrated target yet).
const GATE = !!args.gate;
const KODY_TARGETS = (() => {
    // Missing file → no calibrated floors (gate falls back to 0/off). But a
    // MALFORMED file must fail loudly, not silently disable the gate.
    try {
        return require('./kody-targets.json').models || {};
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') return {};
        throw err;
    }
})();
const MODEL_TARGET = KODY_TARGETS[MODELKEY] || {};
const OCC_MIN = +(args['occ-min'] ?? MODEL_TARGET.occMin ?? 0);
const SPEC_MIN = +(args['spec-min'] ?? MODEL_TARGET.specMin ?? 95);

const allCases = require('./' + DATASET);
const { evalQuestion } = require('../shared/eval-result');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
// --cases picks cases by id; --limit=N caps how many run (CI scopes to a few).
const picked = args.cases ? allCases.filter((c) => String(args.cases).split(',').includes(c.caseId)) : allCases;
const cases = args.limit ? picked.slice(0, +args.limit) : picked;

function normalizePath(v) { return String(v || '').replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/'); }

// Every place a shipped comment points at: its own file and line, and the
// other places the stage folded into it (mergeKodyRuleFindings keeps them in
// kodyRuleOtherLocations as "file:start-end"; the posted comment lists them).
function locationsOf(s) {
    const own = { file: normalizePath(s.relevantFile), line: s.relevantLinesStart };
    const others = (s.kodyRuleOtherLocations || []).map((loc) => {
        const m = String(loc).match(/^(.*):(\d+|\?)-(\d+|\?)$/);
        return m ? { file: normalizePath(m[1]), line: m[2] === '?' ? NaN : Number(m[2]) } : null;
    });
    return [own, ...others].filter((x) => x && x.file);
}

// --all-rules: every rule of the dataset is the team's, in every review, as in
// production where all of a team's rules reach one review. Scoring then reads
// only the case's own rule (the others have no ground truth on it).
const ALL_RULES = !!args['all-rules'];
const UNIQUE_RULES = Object.values(Object.fromEntries(allCases.filter((c) => c.rule).map((c) => [c.rule.uuid, c.rule])));

// v2 dataset (github-cases-v2): one case per PR, `rules` array + groundTruthAll
// (full GT per rule, built by build-cases-v2.js). Normalize into scoring
// targets [{uuid, sites, violFiles, okFiles}] — one per rule.
function caseTargets(c) {
    if (!c.groundTruthAll) return null;
    const changed = c.pr.files.map((f) => normalizePath(f.filename));
    return (c.rules || []).map((r) => {
        const gt = c.groundTruthAll[r.uuid] || {};
        const violFiles = Object.keys(gt).map(normalizePath);
        const sites = Object.entries(gt).flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
        return { uuid: r.uuid, sites, violFiles, okFiles: changed.filter((f) => !violFiles.includes(f)) };
    });
}

// A rule as the team saved it: active, reaching every repository.
const asSaved = (r) => ({ ...r, type: 'standard', status: 'active', scope: r.scope || 'file', repositoryId: 'global' });

// One case in the shape every eval writes (evals/shared/eval-result.js): what
// it checks, the violation sites it caught over the runs that measured, and
// each site, ok only when caught in every one of them.
function caseResult(c, caseLabel, targets, sites, violFiles, perRun, okRuns) {
    const allSites = targets ? targets.flatMap((t) => t.sites) : sites;
    const where = String(c.caseId || '').split('::')[0];
    const rule = targets ? `${targets.length} rules` : `"${c.rule?.title || caseLabel}"`;
    const measuredRuns = perRun.filter((p) => !p.errored);
    if (!allSites.length) {
        return {
            id: caseLabel,
            checks: `Flags every file that breaks ${rule}${where ? ` in ${where}` : ''}`,
            hits: measuredRuns.reduce((a, p) => a + p.hit, 0),
            total: violFiles.length * okRuns,
            detail: [],
        };
    }
    return {
        id: caseLabel,
        checks: `Flags every line that breaks ${rule}${where ? ` in ${where}` : ''}`,
        hits: measuredRuns.reduce((a, p) => a + p.coveredSites, 0),
        total: allSites.length * okRuns,
        detail: allSites.map((g, i) => ({ what: `${g.file}:${g.line}`, ok: measuredRuns.length > 0 && measuredRuns.every((p) => p.siteOk?.[i]) })),
        falseAlarms: measuredRuns.reduce((a, p) => a + p.falseOnClean, 0),
    };
}

async function main() {
    // The managed route: tier-0 ids only (evals/shared/tier0-models.js).
    const { TIER0, applyModelEnv } = require('../shared/tier0-models');
    if (!TIER0[MODELKEY]) {
        console.error(`not measured: ${MODELKEY} is not a tier-0 model id (evals/shared/tier0-models.js)`);
        process.exit(2);
    }
    applyModelEnv(MODELKEY);
    const unmaterialized = cases.filter((c) => !c.pr);
    if (unmaterialized.length) {
        console.error(`not measured: ${unmaterialized.length} case(s) carry no recorded PR; run node evals/kody-rules/materialize-cases.js --dataset=${DATASET}`);
        process.exit(2);
    }

    const review = require('./production-review');
    // Production's ObservabilityService registers itself as the LLM port when
    // built; the eval's count registers after it so every call is counted.
    review.observabilityService();
    countTokens();

    // Each rule is compiled once, as production compiles it once at save.
    const compiled = new Map();
    const compileOnce = async (rule) => {
        if (!compiled.has(rule.uuid)) {
            const saved = await review.compileRules([asSaved(rule)], review.permissionService(null));
            compiled.set(rule.uuid, { rule: saved.rules[0], outcome: saved.outcomes[0] });
            const o = saved.outcomes[0];
            console.log(`compiled ${rule.uuid}: ${o.compiled ? 'detector' : `no detector (${o.declineReason || 'declined'})`}, scope ${JSON.stringify(o.fileScope || null)}, need ${o.contextNeed || 'none'}`);
        }
        return compiled.get(rule.uuid);
    };

    const LINE_TOL = 2; // a flag "lands" on a real site if within ±2 lines
    let multiTotalSites = 0, multiCaughtSites = 0, caughtAllRuns = 0, totalMultiRuns = 0;
    let cleanFiles = 0, falseAlarmFiles = 0;
    // occurrence-level (only for cases that carry per-line groundTruth)
    let occTotal = 0, occCaught = 0, lineNoiseTotal = 0, flaggedTotal = 0;
    // Environmental failures (quota / rate-limit / bad key) surface as errored
    // runs — NOT real misses. Track them so a broken environment warns (infra)
    // instead of deflating recall into a false quality-gate failure.
    let erroredRuns = 0, totalRuns = 0;
    const caseResults = [];
    const haveGT = cases.some((c) => c.groundTruth || c.groundTruthAll);
    // flatten groundTruth → [{file, line}]
    const gtSites = (c) => Object.entries(c.groundTruth || {})
        .flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
    for (const c of cases) {
        const violFiles = (c.violatingFiles || []).map(normalizePath);
        const okFiles = (c.cleanFiles || []).map(normalizePath);
        const targets = caseTargets(c); // non-null on the v2 dataset
        const sites = gtSites(c);
        const caseLabel = c.caseId || c.rule.uuid;
        const caseRules = c.rules ? c.rules : (ALL_RULES ? UNIQUE_RULES : [c.rule]);
        const saved = [];
        for (const rule of caseRules) saved.push((await compileOnce(rule)).rule);
        const perRun = [];
        let fileCount = c.pr.files.length;
        for (let r = 0; r < RUNS; r++) {
            let sugg = [], errored = false;
            totalRuns++;
            try {
                const res = await review.reviewCase(c, { compiled: { rules: saved } });
                fileCount = res.files.length;
                // A review whose agent failed (key, quota, provider) is not a
                // measurement: production records it as the review's error.
                if (res.lastReviewError) {
                    errored = true;
                    console.error(`  [case ${caseLabel} run ${r}] review failed: ${res.lastReviewError.category} ${String(res.lastReviewError.providerMessage || res.lastReviewError.friendlyMessage || '').slice(0, 140)}`);
                }
                sugg = res.suggestions.filter((s) => s.label === 'kody_rules' || (s.brokenKodyRulesIds || []).length);
            } catch (e) {
                errored = true;
                // A failed clone carries git's own reason on stderr, not in the message.
                const why = String(e.stderr || '').trim().split('\n').pop() || String(e.message);
                console.error(`  [case ${caseLabel} run ${r}] ${why.slice(0, 200)}`);
            }
            if (errored) erroredRuns++;

            if (targets) {
                // v2: score every rule against its own GT. Suggestions map to
                // rules via brokenKodyRulesIds (mapAgentFindings re-homes the
                // LLM's ruleUuid there — finding-mapper.ts).
                let hit = 0, falseOnClean = 0, coveredSites = 0, flagsN = 0, lineNoise = 0;
                const siteOk = [];
                for (const t of targets) {
                    const tSugg = sugg.filter((s) =>
                        (s.brokenKodyRulesIds || []).includes(t.uuid) || s.ruleUuid === t.uuid);
                    const located = tSugg.flatMap(locationsOf);
                    const flags = located.filter((x) => Number.isFinite(x.line));
                    const flaggedFiles = new Set(located.map((x) => x.file));
                    hit += t.violFiles.filter((f) => flaggedFiles.has(f)).length;
                    falseOnClean += t.okFiles.filter((f) => flaggedFiles.has(f)).length;
                    const tOk = t.sites.map((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL));
                    siteOk.push(...tOk);
                    coveredSites += tOk.filter(Boolean).length;
                    const onTarget = flags.filter((x) => t.sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
                    flagsN += flags.length; lineNoise += flags.length - onTarget;
                }
                perRun.push({ hit, falseOnClean, coveredSites, flags: flagsN, lineNoise, errored, otherRuleFlags: 0, siteOk });
                continue;
            }

            // --all-rules on the v1 dataset: score only the target rule's
            // suggestions (other rules have no GT on this case).
            let otherRuleFlags = 0;
            if (ALL_RULES) {
                const total = sugg.length;
                sugg = sugg.filter((s) =>
                    (s.brokenKodyRulesIds || []).includes(c.rule.uuid) ||
                    s.ruleUuid === c.rule.uuid);
                otherRuleFlags = total - sugg.length;
            }
            const located = sugg.flatMap(locationsOf);
            const flaggedFiles = new Set(located.map((x) => x.file));
            const hit = violFiles.filter((f) => flaggedFiles.has(f)).length;
            const falseOnClean = okFiles.filter((f) => flaggedFiles.has(f)).length;
            // occurrence-level: distinct real sites covered by some flag (±tol)
            const flags = located.filter((x) => Number.isFinite(x.line));
            const siteOk = sites.map((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL));
            const coveredSites = siteOk.filter(Boolean).length;
            const onTargetFlags = flags.filter((x) => sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            perRun.push({ hit, falseOnClean, coveredSites, flags: flags.length, lineNoise: flags.length - onTargetFlags, errored, otherRuleFlags, siteOk });
        }
        // v2 denominators span all (file,rule) pairs; v1 keeps the single rule.
        const N = targets ? targets.reduce((a, t) => a + t.violFiles.length, 0) : violFiles.length;
        const siteCount = targets ? targets.reduce((a, t) => a + t.sites.length, 0) : sites.length;
        const cleanCount = targets ? targets.reduce((a, t) => a + t.okFiles.length, 0) : okFiles.length;
        // Count only runs that actually executed — an errored (infra) run must
        // not add its sites to any denominator as if they were real misses.
        const okRuns = perRun.filter((p) => !p.errored).length;
        caseResults.push(caseResult(c, caseLabel, targets, sites, violFiles, perRun, okRuns));
        const allRuns = perRun.filter((p) => !p.errored && p.hit >= N).length;
        multiTotalSites += N * okRuns; multiCaughtSites += perRun.reduce((a, b) => a + (b.errored ? 0 : b.hit), 0);
        caughtAllRuns += allRuns; totalMultiRuns += okRuns;
        cleanFiles += cleanCount * okRuns; falseAlarmFiles += perRun.reduce((a, b) => a + (b.errored ? 0 : b.falseOnClean), 0);
        if (c.groundTruth || targets) {
            occTotal += siteCount * okRuns; occCaught += perRun.reduce((a, b) => a + (b.errored ? 0 : b.coveredSites), 0);
            lineNoiseTotal += perRun.reduce((a, b) => a + (b.errored ? 0 : b.lineNoise), 0); flaggedTotal += perRun.reduce((a, b) => a + (b.errored ? 0 : b.flags), 0);
            const otherInfo = ALL_RULES && !targets ? `  other-rule-flags/run=[${perRun.map((p) => p.otherRuleFlags).join(',')}]` : '';
            console.log(`${caseLabel.padEnd(34)} files=${fileCount} sites=${siteCount}  file-hits/run=[${perRun.map((p) => p.hit).join(',')}]  occ-caught/run=[${perRun.map((p) => p.coveredSites).join(',')}]  flags/run=[${perRun.map((p) => p.flags).join(',')}]${otherInfo}`);
        } else {
            console.log(`${caseLabel.padEnd(34)} files=${fileCount} viol=${N}  hits/run=[${perRun.map((p) => p.hit).join(',')}]  caught-all ${allRuns}/${okRuns}  false-on-clean ${perRun.reduce((a, b) => a + (b.errored ? 0 : b.falseOnClean), 0)}`);
        }
    }
    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');
    console.log(`\n════ kody-rules adherence — REAL ENGINE (${MODELKEY}, ${RUNS} runs/case) ════`);
    console.log(`FILE-level recall:    ${pct(multiCaughtSites, multiTotalSites)}%  (${multiCaughtSites}/${multiTotalSites} violating files flagged ≥once)`);
    if (haveGT) {
        console.log(`OCCURRENCE recall:    ${pct(occCaught, occTotal)}%  (${occCaught}/${occTotal} real in-diff sites flagged, ±${LINE_TOL} lines)  ← did it catch EVERY spot`);
        console.log(`line precision:       ${pct(flaggedTotal - lineNoiseTotal, flaggedTotal)}%  (${lineNoiseTotal}/${flaggedTotal} flags landed off any real site)`);
    }
    console.log(`specificity (files):  ${pct(cleanFiles - falseAlarmFiles, cleanFiles)}%  (${falseAlarmFiles}/${cleanFiles} clean files false-alarmed)`);
    const tok = tokensUsed();
    console.log(`TOKENS: input=${tok.in}  output=${tok.out}  cacheRead=${tok.cacheRead}  cacheWrite=${tok.cacheWrite}  over ${totalRuns} agentic sessions`);

    // --output: the result in the shape every eval writes
    // (evals/shared/eval-result.js), plus the counts behind each rate so a
    // confirming run can be pooled with the first (nightly-verdict.js).
    if (args.output) {
        const ratio = (a, b) => (b ? a / b : null);
        const observed = MODEL_TARGET.observed || null;
        const result = {
            eval: 'kody-rules',
            question: evalQuestion('evals/kody-rules'),
            model: MODELKEY,
            dataset: DATASET,
            runs: RUNS,
            metric: {
                name: 'occurrence recall',
                value: ratio(occCaught, occTotal),
                floor: OCC_MIN / 100,
                baseline: observed ? observed.occ / 100 : null,
            },
            specificity: {
                value: cleanFiles ? (cleanFiles - falseAlarmFiles) / cleanFiles : null,
                floor: SPEC_MIN / 100,
                baseline: observed ? observed.spec / 100 : null,
            },
            linePrecision: ratio(flaggedTotal - lineNoiseTotal, flaggedTotal),
            counts: { sites: occTotal, caught: occCaught, flagged: flaggedTotal, offSite: lineNoiseTotal, cleanFiles, falseAlarmFiles },
            cases: caseResults,
            tokens: tok,
            infra: { errored: erroredRuns, total: totalRuns },
        };
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }

    if (GATE) {
        // Not measured (evals/AGENTS.md): a run that threw (a clone, the
        // provider) or whose review recorded an error counts in no
        // denominator. Up to 5% of runs may be lost that way; beyond, exit 2.
        const budget = Math.floor(totalRuns * 0.05);
        if (totalRuns === erroredRuns || erroredRuns > budget) {
            console.error(`\nnot measured: ${erroredRuns} of ${totalRuns} runs did not measure (budget ${budget}; see above).`);
            process.exit(2);
        }
        const occ = occTotal ? (100 * occCaught / occTotal) : 0;
        const spec = cleanFiles ? (100 * (cleanFiles - falseAlarmFiles) / cleanFiles) : 100;
        const fails = [];
        // A negative control (polyglot-cases) has no sites: specificity only.
        if (haveGT && occTotal > 0 && occ < OCC_MIN) fails.push(`occurrence-recall ${occ.toFixed(0)}% < ${OCC_MIN}%`);
        if (spec < SPEC_MIN) fails.push(`specificity ${spec.toFixed(0)}% < ${SPEC_MIN}%`);
        if (fails.length) { console.error(`\n❌ GATE FAILED: ${fails.join('; ')}`); process.exit(1); }
        console.log(`\n✅ GATE PASSED (occurrence-recall ≥ ${OCC_MIN}%, specificity ≥ ${SPEC_MIN}%)`);
    }
}

// Exit-code contract for the suite: 1 = gate failed (quality regression),
// 2 = infra error (no key, bad model id, crash) — always surfaced loudly.
// Exit explicitly on success too: an open handle left by the engine would
// otherwise keep a finished run alive until the CI timeout.
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
