#!/usr/bin/env node
/**
 * Grades enrichment answers (run.js output) against the references.
 *
 *   node evals/enrichment/judge.js <results.json> [more.json ...] [--par=6] [--judge=<model>] [--no-ref]
 *     -> <results>.judged.json per input (<results>.judged-<tag>.json with --judge or --no-ref),
 *        and a summary table on stdout
 *
 * --refs=<file> grades against references the model wrote itself (refine.js)
 * instead of Astra's; they carry no example fix.
 * --no-ref grades without the Astra reference, as a production gate would:
 * the judge sees only the finding, the cited code, the file window and the answer.
 *
 * Groups: mustFix items (a correct fix fits the cited lines and the input
 * shows enough) are graded on the fix; every other item is graded on giving
 * no code (any fixStatus but "local").
 * Deterministic: the title format, whether an abstention was acceptable, and
 * the syntax of the whole head file with the cited lines replaced (TS/JS,
 * Ruby, Python; other languages are reported as not checked).
 * Judge (Opus, one call per distinct answer, cached): does the title name the
 * finding's problem, and does a "local" fix meet the reference obligations
 * without new defects — PASS / FAIL / UNASSESSABLE. The reference fix is
 * guidance, not a target.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { z } = require('zod');
const ts = require('typescript');
const { LLM } = require(path.join(__dirname, '../../libs/llm/llm.ts'));
const { createModel } = require('../investigation/agent-provider-1821');

const args = process.argv.slice(2);
const JUDGE_MODEL = (args.find((a) => a.startsWith('--judge=')) || '--judge=claude-opus-5.5@api').slice(8);
const NO_REF = args.includes('--no-ref');
const REFS_FILE = (args.find((a) => a.startsWith('--refs=')) || '').slice(7);
// Opus judges by API or, when the API is out of quota, by subscription: same judge, same files and cache.
const TAG = [/^claude-opus-5\.5@(api|sdk)$/.test(JUDGE_MODEL) ? '' : JUDGE_MODEL.replace(/[@/]/g, '_'), NO_REF ? 'noref' : '', REFS_FILE ? (REFS_FILE.endsWith('-tools.json') ? 'selfref-tools' : 'selfref') : ''].filter(Boolean).join('-');
const selfRefs = REFS_FILE ? new Map(JSON.parse(fs.readFileSync(REFS_FILE, 'utf8')).items.map((r) => [r.issueId, r])) : null;
const files = args.filter((a) => !a.startsWith('--'));
const PAR = Number((args.find((a) => a.startsWith('--par=')) || '--par=6').split('=')[1]);
const DIR = path.join(__dirname, 'dataset');
const CACHE = path.join(__dirname, 'results', 'judge-cache.json');
const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../dedup/gold-v3/trabalho/repos.json'), 'utf8'));

const items = new Map(JSON.parse(fs.readFileSync(path.join(DIR, 'items.json'), 'utf8')).items.map((x) => [x.issueId, x]));
const refs = new Map();
for (const f of fs.readdirSync(path.join(DIR, 'references')).filter((f) => f.endsWith('.json'))) {
    for (const r of JSON.parse(fs.readFileSync(path.join(DIR, 'references', f), 'utf8')).items) refs.set(r.issueId, r);
}
fs.mkdirSync(path.dirname(CACHE), { recursive: true });
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

// ── deterministic ────────────────────────────────────────────────────────────
// The ruler is shared with the step's eval (evals/suggestion-enrichment/judge.js).
const shared = require('../suggestion-enrichment/judge');
const { titleFormatOk, mustFix, VERDICT, SYSTEM } = shared;

const headCache = new Map();
function headFile(it) {
    const k = `${it.caseId}|${it.finding.relevantFile}`;
    if (!headCache.has(k)) {
        try {
            headCache.set(k, execFileSync('git', ['-C', REPOS[it.caseId].repo, 'show', `${REPOS[it.caseId].head}:${it.finding.relevantFile}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }));
        } catch {
            headCache.set(k, null);
        }
    }
    return headCache.get(k);
}
function parses(lang, file, code) {
    if (lang === 'typescript' || lang === 'javascript') {
        const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : lang === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
        const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, kind);
        return sf.parseDiagnostics.length === 0;
    }
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-syn-')), 'f');
    fs.writeFileSync(tmp, code);
    try {
        if (lang === 'ruby') execFileSync('ruby', ['-c', tmp], { stdio: 'ignore' });
        else if (lang === 'python') execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', tmp], { stdio: 'ignore' });
        else return null;
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
}
/** true / false / null (language not checked, or the head file itself does not parse). */
function syntaxOk(it, improvedCode) {
    const lang = it.deterministic.language;
    if (!['typescript', 'javascript', 'ruby', 'python'].includes(lang)) return null;
    const head = headFile(it);
    if (head == null || parses(lang, it.finding.relevantFile, head) !== true) return null;
    const lines = head.split('\n');
    const s = it.finding.relevantLinesStart, e = it.finding.relevantLinesEnd ?? s;
    const patched = [...lines.slice(0, s - 1), ...(improvedCode === '' ? [] : improvedCode.split('\n')), ...lines.slice(e)].join('\n');
    return parses(lang, it.finding.relevantFile, patched);
}

// ── judge ────────────────────────────────────────────────────────────────────
const SYSTEM_SELF_REF = SYSTEM.replace('Any implementation that meets the obligations passes; it does not need to resemble the example fix.', 'Any implementation that meets the obligations passes.');
const SYSTEM_NO_REF = SYSTEM.replace('meets every obligation listed in the reference, and introduces', 'and introduces')
    .replace('Any implementation that meets the obligations passes; it does not need to resemble the example fix.', 'Any implementation that fixes the defect passes.')
    .replace('misses an obligation, depends on names or APIs that do not exist in the shown code or reference', 'misses part of the defect, depends on names or APIs that do not exist in the shown code');

function judgePrompt(it, ref, ans) {
    return shared.judgePrompt(it, NO_REF ? null : ref, ans, { selfRef: selfRefs ? selfRefs.get(it.issueId) : undefined });
}

let judgeModel;
async function judge(it, ref, ans) {
    const key = crypto.createHash('sha256').update(JSON.stringify(TAG ? [TAG, it.issueId, ans.oneSentenceSummary, ans.fixStatus, ans.improvedCode] : [it.issueId, ans.oneSentenceSummary, ans.fixStatus, ans.improvedCode])).digest('hex');
    if (cache[key]) return cache[key];
    judgeModel ||= await (async () => { process.env.RECALL_MODEL = JUDGE_MODEL; return createModel({ provider: 'tier0' }); })();
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const v = await LLM.run({ system: selfRefs ? SYSTEM_SELF_REF : NO_REF ? SYSTEM_NO_REF : SYSTEM, user: judgePrompt(it, ref, ans), schema: VERDICT, prebuiltModel: judgeModel, runName: 'eval-enrich-judge' });
            cache[key] = VERDICT.parse(v);
            return cache[key];
        } catch (e) {
            if (attempt === 2) return { error: String(e?.message || e).slice(0, 200) };
        }
    }
}

// ── run ──────────────────────────────────────────────────────────────────────
(async () => {
    const summary = [];
    for (const file of files) {
        const res = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = res.rows;
        let i = 0;
        await Promise.all(Array.from({ length: PAR }, async () => {
            while (i < rows.length) {
                const row = rows[i++];
                const it = items.get(row.issueId), ref = refs.get(row.issueId);
                const ans = row.result;
                row.grade = { mustFix: mustFix(it, ref), refFixability: ref.fixability, refContextSufficient: ref.contextSufficient };
                if (!ans) { row.grade.noAnswer = true; continue; }
                row.grade.titleFormatOk = titleFormatOk(ans.oneSentenceSummary);
                row.grade.syntaxOk = ans.fixStatus === 'local' ? syntaxOk(it, ans.improvedCode) : null;
                row.grade.judge = await judge(it, ref, ans);
            }
        }));
        fs.writeFileSync(CACHE, JSON.stringify(cache));
        fs.writeFileSync(file.replace(/\.json$/, TAG ? `.judged-${TAG}.json` : '.judged.json'), JSON.stringify(res, null, 1));
        summary.push(summarize(res));
    }
    console.table(summary);
    process.exit(0);
})();

function summarize(res) {
    const R = res.rows, n = R.length;
    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
    const g = (r) => r.grade || {};
    const local = R.filter((r) => r.result?.fixStatus === 'local');
    const pass = local.filter((r) => g(r).judge?.fix === 'PASS');
    const must = R.filter((r) => g(r).mustFix);
    const abstainOnMust = must.filter((r) => r.result && r.result.fixStatus !== 'local');
    // Items with no correct fix inside the cited lines: the right answer is no code.
    const noFix = R.filter((r) => !g(r).mustFix);
    const syn = local.filter((r) => g(r).syntaxOk !== null);
    const sum = (k) => R.reduce((s, r) => s + (r.usage?.[k] || 0), 0);
    return {
        run: `${res.model} ${res.variant}${TAG ? ` [judge ${TAG}]` : ''}`,
        n,
        noAnswer: R.filter((r) => !r.result).length,
        'usable fix (PASS/all)': pct(pass.length, n),
        'PASS/attempted': pct(pass.length, local.length),
        unassessable: local.filter((r) => g(r).judge?.fix === 'UNASSESSABLE').length,
        'fix on mustFix': pct(must.filter((r) => g(r).judge?.fix === 'PASS').length, must.length),
        'abstain on mustFix': `${abstainOnMust.length}/${must.length}`,
        'no code on noFix': pct(noFix.filter((r) => r.result && r.result.fixStatus !== 'local').length, noFix.length),
        abstain: Object.entries(R.reduce((m, r) => (r.result && r.result.fixStatus !== 'local' ? ((m[r.result.fixStatus] = (m[r.result.fixStatus] || 0) + 1), m) : m), {})).map(([k, v]) => `${k}:${v}`).join(' ') || '-',
        'syntax ok': `${syn.filter((r) => g(r).syntaxOk).length}/${syn.length}`,
        'title fmt': pct(R.filter((r) => g(r).titleFormatOk).length, n),
        'title judge': pct(R.filter((r) => g(r).judge?.titleNamesProblem).length, n),
        'in tok/item': Math.round(sum('input') / n),
        'out tok/item': Math.round(sum('output') / n),
        's/item': (R.reduce((s, r) => s + (r.ms || 0), 0) / n / 1000).toFixed(1),
    };
}
