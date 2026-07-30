#!/usr/bin/env node
/**
 * Build the labeled agreement set for the eval judge (issue #1447).
 *
 * The judge is load-bearing: every recall/dedup number the gate depends on comes
 * from a (golden, candidate) match decision. To swap the judge for a cheaper
 * model we need a FIXED set of real pairs to measure a candidate judge's
 * agreement with the incumbent Sonnet judge.
 *
 * This runs the live finder (deterministic tool replay, no droplet) across the
 * finder-recall case set for one or more models, then emits every
 * (golden, candidate-finding) pair — the same F×G pairs the recall assertion
 * actually judges. Reference match/no-match labels are added later by
 * run-agreement.js (Sonnet), so this script needs NO judge key.
 *
 *   node build-pairs.js                     # gpt-5.4 finder, pr set
 *   node build-pairs.js --models=gpt-5.4,kimi-k2.7-code
 *   node build-pairs.js --set=smoke --limit=3
 *
 * Output: evals/investigation/agreement/pairs.json (committed artifact).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// The finder's key routing (applyModelEnv) reads process.env only. Locally the
// keys live in ~/.kodus-dev/config (same file the judge reads) — load any simple
// KEY=VALUE that isn't already set so `node build-pairs.js` just works.
function loadDevConfigIntoEnv() {
    for (const file of [
        path.join(__dirname, '..', '..', '..', '.env.local'),
        path.join(__dirname, '..', '..', '..', '.env'),
        path.join(os.homedir(), '.kodus-dev', 'config'),
    ]) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
            if (!m) continue;
            const name = m[1];
            if (process.env[name]) continue;
            const v = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
            if (v && !v.startsWith('op://')) process.env[name] = v;
        }
    }
}
loadDevConfigIntoEnv();

const buildTests = require('../recall-tests');
const { parseOutput } = require('../parse-output');
const { applyModelEnv } = require('../../shared/tier0-models');

const OUT = path.join(__dirname, 'pairs.json');

// Same finding→text representation the recall/dedup evals judge on.
function findingText(f) {
    if (!f || typeof f !== 'object') return String(f || '');
    return [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile]
        .filter(Boolean)
        .map((t) => String(t).trim())
        .join(' — ')
        .slice(0, 1200);
}

function asGoldens(v) {
    let raw = v;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(raw)) return [];
    return raw.map((g) => (typeof g === 'string' ? g : g.comment)).filter(Boolean);
}

function parseArgs(argv) {
    const out = { models: ['gpt-5.4'], set: 'pr', limit: null, cases: '' };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        const [, k, v] = m;
        if (k === 'models') out.models = v.split(',').map((s) => s.trim()).filter(Boolean);
        else if (k === 'set') out.set = v;
        else if (k === 'cases') out.cases = v;
        else if (k === 'limit') out.limit = Number(v);
    }
    return out;
}

async function runFinderForModel(model, tests) {
    applyModelEnv(model); // point env at the tier-0 model (finder routing)
    // Require the provider AFTER applyModelEnv so it reads the right env.
    const InvestigationAgentProvider = require('../agent-provider');
    const provider = new InvestigationAgentProvider({
        config: { label: `${model}-agreement`, provider: 'tier0', model },
    });

    const perCase = [];
    for (const test of tests) {
        const caseId = test.vars?.caseId || test.description || 'unknown-case';
        const goldens = asGoldens(test.vars?.goldenComments);
        if (!goldens.length) continue;
        let apiResult;
        try {
            // eslint-disable-next-line no-await-in-loop
            apiResult = await provider.callApi(JSON.stringify(test.vars), { vars: test.vars }, {});
        } catch (e) {
            console.warn(`  INFRA ${caseId}: ${String(e.message || e).slice(0, 140)}`);
            continue;
        }
        const parsed = apiResult?.output ? parseOutput(apiResult.output) : null;
        const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
        console.log(`  ${caseId}: ${goldens.length} goldens × ${findings.length} findings`);
        perCase.push({ caseId, model, goldens, findings: findings.map(findingText) });
    }
    return perCase;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.set) process.env.RECALL_SET = args.set;
    if (args.cases) process.env.RECALL_CASES = args.cases;

    let tests = await buildTests();
    if (Number.isFinite(args.limit)) tests = tests.slice(0, args.limit);
    if (!tests.length) {
        console.error('No cases selected.');
        process.exit(2);
    }

    const pairs = [];
    const cases = [];
    for (const model of args.models) {
        console.log(`════ finder=${model} · cases=${tests.length} ════`);
        // eslint-disable-next-line no-await-in-loop
        const perCase = await runFinderForModel(model, tests);
        for (const c of perCase) {
            cases.push({ caseId: c.caseId, model: c.model, goldens: c.goldens.length, findings: c.findings.length });
            for (let gi = 0; gi < c.goldens.length; gi++) {
                for (let fi = 0; fi < c.findings.length; fi++) {
                    if (!c.findings[fi]) continue;
                    pairs.push({
                        id: `${c.model}::${c.caseId}::g${gi}::f${fi}`,
                        caseId: c.caseId,
                        finderModel: c.model,
                        golden: c.goldens[gi],
                        candidate: c.findings[fi],
                    });
                }
            }
        }
    }

    const payload = {
        __doc: 'Labeled agreement set for the eval judge swap (issue #1447). Pairs = every (golden, candidate-finding) the recall assertion judges. Reference labels added by run-agreement.js.',
        builtFromSet: args.set,
        finderModels: args.models,
        cases,
        pairCount: pairs.length,
        pairs,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(`\nwrote ${pairs.length} pairs from ${cases.length} case-runs → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
