#!/usr/bin/env node
/**
 * Reconciles the two judges (runs/opus, runs/astra) into the gold files.
 *
 * - Same group in both judges, same kind and flag: kept; high if both said high, else mid.
 * - Unique in both: kept; high if both high, low if both low, else mid.
 * - Everything else (groups that differ, kind or flag that differ, partial
 *   overlaps only one judge saw) is a dispute. Disputed ids linked by either
 *   judge go together as one component to the arbiter (Opus 5.5), which sees
 *   both answers without knowing which judge gave which. Its answer is mid
 *   when it calls the evidence decisive, low otherwise. Never high.
 *
 *   node evals/dedup/gold/reconcile.js [--models=a,b] [--prs=a,b] [--arbitrate] [--write] [--par=4]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const RUNS = path.join(__dirname, 'runs');
const PAR = Number(arg('par', '4'));
const OVERRIDES = fs.existsSync(path.join(__dirname, 'human-overrides.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'human-overrides.json'), 'utf8')) : [];

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const key = (ids) => [...ids].sort().join('|');

// One judge's answer as: id -> cluster key, cluster key -> group info.
function partition(ans) {
    const of = {};
    const groups = {};
    for (const g of ans.groups) {
        const k = key(g.members);
        groups[k] = g;
        for (const id of g.members) of[id] = k;
    }
    const uniq = {};
    for (const u of ans.unique) {
        of[u.id] = u.id;
        uniq[u.id] = u.confidence;
    }
    return { of, groups, uniq };
}

function compare(ids, A, B) {
    const pa = partition(A);
    const pb = partition(B);
    const agreedGroups = [];
    const agreedUnique = {};
    const disputed = new Set();
    for (const [k, ga] of Object.entries(pa.groups)) {
        const gb = pb.groups[k];
        if (gb && ga.kind === gb.kind && ga.needsUnifiedComment === gb.needsUnifiedComment) {
            const conf = ga.confidence === 'high' && gb.confidence === 'high' ? 'high' : 'mid';
            agreedGroups.push({ members: ga.members.slice().sort(), kind: ga.kind, needsUnifiedComment: ga.needsUnifiedComment, confidence: conf, defect: ga.defect, votes: { opus: 'same', astra: 'same' }, resolvedBy: 'agreement' });
        } else {
            for (const id of ga.members) disputed.add(id);
        }
    }
    for (const [k, gb] of Object.entries(pb.groups)) if (!pa.groups[k]) for (const id of gb.members) disputed.add(id);
    for (const id of ids) {
        if (disputed.has(id)) continue;
        if (pa.uniq[id] && pb.uniq[id]) {
            const a = pa.uniq[id];
            const b = pb.uniq[id];
            agreedUnique[id] = a === 'high' && b === 'high' ? 'high' : a === 'low' && b === 'low' ? 'low' : 'mid';
        }
    }
    // Partial overlaps: both saw it -> kept; only one -> its ids go to dispute.
    const po = (ans) => new Set((ans.partialOverlap || []).map((p) => `${p.container}>${p.contained}`));
    const poa = po(A);
    const pob = po(B);
    const partial = [];
    for (const p of new Set([...poa, ...pob])) {
        const [c, d] = p.split('>');
        if (poa.has(p) && pob.has(p)) partial.push({ container: c, contained: d });
        else {
            disputed.add(c);
            disputed.add(d);
        }
    }
    // A partial overlap id may sit in an agreed group: the whole group joins the dispute then.
    for (let changed = true; changed;) {
        changed = false;
        for (let i = agreedGroups.length - 1; i >= 0; i--) {
            if (agreedGroups[i].members.some((m) => disputed.has(m))) {
                for (const m of agreedGroups[i].members) disputed.add(m);
                agreedGroups.splice(i, 1);
                changed = true;
            }
        }
        for (const id of Object.keys(agreedUnique)) if (disputed.has(id)) delete agreedUnique[id];
    }
    // Components: disputed ids linked when either judge put them together.
    const parent = Object.fromEntries([...disputed].map((id) => [id, id]));
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const link = (a, b) => (parent[find(a)] = find(b));
    for (const p of [pa, pb]) for (const g of Object.values(p.groups)) {
        const ms = g.members.filter((m) => disputed.has(m));
        for (let i = 1; i < ms.length; i++) link(ms[0], ms[i]);
    }
    for (const p of [...(A.partialOverlap || []), ...(B.partialOverlap || [])]) if (disputed.has(p.container) && disputed.has(p.contained)) link(p.container, p.contained);
    const comps = {};
    for (const id of disputed) (comps[find(id)] ||= []).push(id);

    // Pairwise agreement (kappa) on "same group?".
    let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = pa.of[ids[i]] === pa.of[ids[j]];
        const b = pb.of[ids[i]] === pb.of[ids[j]];
        if (a && b) n11++; else if (a) n10++; else if (b) n01++; else n00++;
    }
    return { agreedGroups, agreedUnique, partial, components: Object.values(comps).map((c) => c.sort()), pairs: { n11, n10, n01, n00 } };
}

function kappa({ n11, n10, n01, n00 }) {
    const n = n11 + n10 + n01 + n00;
    if (!n) return null;
    const po = (n11 + n00) / n;
    const pa = (n11 + n10) / n;
    const pb = (n11 + n01) / n;
    const pe = pa * pb + (1 - pa) * (1 - pb);
    return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

// ---------- arbiter ----------
const ARB_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['groups', 'unique', 'decisive', 'reasoning'],
    properties: {
        groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['members', 'kind', 'needsUnifiedComment', 'defect'], properties: {
            members: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string', enum: ['same_location', 'cross_location', 'systemic_pattern'] },
            needsUnifiedComment: { type: 'boolean' },
            defect: { type: 'string' },
        } } },
        unique: { type: 'array', items: { type: 'string' } },
        decisive: { type: 'boolean' },
        reasoning: { type: 'string' },
    },
};

function judgeView(ans, ids) {
    const set = new Set(ids);
    const groups = ans.groups.filter((g) => g.members.some((m) => set.has(m))).map((g) => ({ ...g, members: g.members }));
    const unique = ans.unique.filter((u) => set.has(u.id));
    const partialOverlap = (ans.partialOverlap || []).filter((p) => set.has(p.container) || set.has(p.contained));
    return { groups, unique, partialOverlap };
}

function runClaude(prompt) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) delete env[k];
        const p = spawn('claude', ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--tools', '', '--output-format', 'json',
            '--json-schema', JSON.stringify(ARB_SCHEMA), '--no-session-persistence', '--setting-sources', '',
            '--system-prompt', 'You adjudicate duplicate labels for code review suggestions. Answer only with the requested JSON.'], { env, cwd: os.tmpdir() });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => {
            if (code !== 0) return reject(new Error(`claude exit ${code}: ${(err || out).slice(-500)}`));
            try {
                const r = JSON.parse(out);
                if (r.is_error) return reject(new Error(String(r.result).slice(0, 400)));
                resolve(r.structured_output ?? JSON.parse(r.result));
            } catch (e) {
                reject(e);
            }
        });
        p.stdin.end(prompt);
    });
}

const INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'judge-prompt.md'), 'utf8').split('# Confidence')[0];
let judgeLib;

async function arbitrate(model, caseId, comp, suggestions, A, B) {
    const file = path.join(RUNS, 'arbiter', model, `${caseId}__${sha(comp.join('|')).slice(0, 10)}.json`);
    const cached = readJson(file);
    if (cached && !flag('force')) return cached.answer;
    judgeLib ||= require('./judge-context');
    const byId = Object.fromEntries(suggestions.map((s) => [s.id, s]));
    const { title, diff } = judgeLib.diffFor(caseId, comp.map((id) => byId[id]));
    // Which judge is shown first is fixed per component but not per judge, so the arbiter can't learn who is who.
    const flip = parseInt(sha(`${caseId}|${comp[0]}`).slice(0, 2), 16) % 2 === 1;
    const [j1, j2] = flip ? [B, A] : [A, B];
    const list = comp.map((id) => {
        const s = byId[id];
        return `### ${id}\nFile: ${s.relevantFile} (lines ${s.relevantLinesStart}-${s.relevantLinesEnd})\n${s.oneSentenceSummary ? `Summary: ${s.oneSentenceSummary}\n` : ''}${s.suggestionContent || ''}`;
    }).join('\n\n');
    const prompt = `${INSTRUCTIONS}
# Your role

Two independent judges labeled these suggestions with the rules above and disagreed. Decide the correct grouping for exactly these ${comp.length} suggestions: ${comp.join(', ')}. Read the diff and the suggestions yourself; the judges can both be wrong. Every one of these ids must appear exactly once, in one of your groups or in unique. Only use these ids.

Set decisive=true only when the text and the diff settle the question, so a careful reviewer would agree with you. Set it to false when it is a judgment call.

# PR: ${title}

## Diff

${diff}

## Suggestions

${list}

## Judge 1

${JSON.stringify(judgeView(j1, comp), null, 1)}

## Judge 2

${JSON.stringify(judgeView(j2, comp), null, 1)}
`;
    let ans;
    let errs = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
        ans = await runClaude(prompt + (errs.length ? `\n\n# Previous answer invalid\n${errs.join('\n')}\n` : ''));
        const seen = {};
        for (const g of ans.groups) for (const m of g.members) seen[m] = (seen[m] || 0) + 1;
        for (const u of ans.unique) seen[u] = (seen[u] || 0) + 1;
        errs = comp.filter((id) => seen[id] !== 1).map((id) => `${id} appears ${seen[id] || 0} times`);
        errs.push(...Object.keys(seen).filter((id) => !comp.includes(id)).map((id) => `unknown id ${id}`));
        errs.push(...ans.groups.filter((g) => g.members.length < 2).map((g) => `group with < 2 members ${g.members}`));
        if (!errs.length) break;
    }
    if (errs.length) throw new Error(`arbiter invalid for ${model}/${caseId}: ${errs.join('; ')}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model, caseId, component: comp, flip, answer: ans }, null, 2));
    return ans;
}

(async () => {
    const models = (arg('models') || '').split(',').filter(Boolean);
    const prs = (arg('prs') || '').split(',').filter(Boolean);
    const goldFiles = fs.readdirSync(__dirname).filter((f) => f.endsWith('.json'));
    const report = [];
    const tasks = [];
    const results = {};
    for (const gf of goldFiles) {
        const gold = JSON.parse(fs.readFileSync(path.join(__dirname, gf), 'utf8'));
        if (!gold.prs || (models.length && !models.includes(gold.model))) continue;
        const agg = { model: gold.model, prs: 0, missing: 0, pairs: { n11: 0, n10: 0, n01: 0, n00: 0 }, agreedGroups: 0, components: 0, disputedIds: 0, ids: 0 };
        for (const [caseId, pr] of Object.entries(gold.prs)) {
            if (prs.length && !prs.includes(caseId)) continue;
            const A = readJson(path.join(RUNS, 'opus', gold.model, `${caseId}.json`))?.answer;
            const B = readJson(path.join(RUNS, 'astra', gold.model, `${caseId}.json`))?.answer;
            if (!A || !B) {
                agg.missing++;
                continue;
            }
            const ids = pr.suggestions.map((s) => s.id);
            const c = compare(ids, A, B);
            agg.prs++;
            agg.ids += ids.length;
            for (const k of Object.keys(agg.pairs)) agg.pairs[k] += c.pairs[k];
            agg.agreedGroups += c.agreedGroups.length;
            agg.components += c.components.length;
            agg.disputedIds += c.components.flat().length;
            results[`${gf}|${caseId}`] = { gf, caseId, c, A, B, pr, model: gold.model };
            for (const comp of c.components) tasks.push({ model: gold.model, caseId, comp, pr, A, B, key: `${gf}|${caseId}` });
        }
        agg.kappa = kappa(agg.pairs);
        report.push(agg);
    }
    console.log('model | PRs | missing | suggestions | pairs both-same / only-opus / only-astra | kappa | agreed groups | disputed components (ids)');
    for (const r of report) console.log(`${r.model} | ${r.prs} | ${r.missing} | ${r.ids} | ${r.pairs.n11}/${r.pairs.n10}/${r.pairs.n01} | ${r.kappa?.toFixed(3)} | ${r.agreedGroups} | ${r.components} (${r.disputedIds})`);

    if (!flag('arbitrate')) process.exit(0);
    let i = 0;
    let failed = 0;
    const arb = {};
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            try {
                const ans = await arbitrate(t.model, t.caseId, t.comp, t.pr.suggestions, t.A, t.B);
                (arb[t.key] ||= []).push({ comp: t.comp, ans });
            } catch (e) {
                failed++;
                console.log(`arbiter FAILED ${t.model} ${t.caseId}: ${String(e.message).slice(0, 300)}`);
            }
        }
    }));
    console.log(`arbiter: ${tasks.length} components, ${failed} failed`);
    if (!flag('write') || failed) process.exit(failed ? 2 : 0);

    const golds = {};
    for (const r of Object.values(results)) {
        const gold = (golds[r.gf] ||= JSON.parse(fs.readFileSync(path.join(__dirname, r.gf), 'utf8')));
        const pr = gold.prs[r.caseId];
        const pa = partition(r.A);
        const pb = partition(r.B);
        const groups = r.c.agreedGroups.map((g) => ({ ...g }));
        const uniqueConfidence = { ...r.c.agreedUnique };
        const partial = [...r.c.partial];
        for (const { ans } of arb[`${r.gf}|${r.caseId}`] || []) {
            const conf = ans.decisive ? 'mid' : 'low';
            for (const g of ans.groups) {
                const k = key(g.members);
                groups.push({ members: g.members.slice().sort(), kind: g.kind, needsUnifiedComment: g.needsUnifiedComment, confidence: conf, defect: g.defect,
                    votes: { opus: pa.groups[k] ? 'same' : 'different', astra: pb.groups[k] ? 'same' : 'different' }, resolvedBy: 'adjudication', arbiterReasoning: ans.reasoning });
            }
            for (const id of ans.unique) uniqueConfidence[id] = conf;
            partial.push(...(ans.partialOverlap || []));
        }
        // Human overrides (human-overrides.json) win over judges and arbiter.
        for (const ov of OVERRIDES.filter((o) => o.model === r.model && o.caseId === r.caseId)) {
            const i = groups.findIndex((g) => key(g.members) === key(ov.replaceGroup));
            if (i < 0) {
                console.log(`override not applied (group not found): ${r.model} ${r.caseId}`);
                continue;
            }
            groups.splice(i, 1, ...ov.with.map((w) => ({ members: w.members.slice().sort(), kind: w.kind, needsUnifiedComment: w.needsUnifiedComment, confidence: 'high', defect: w.defect, votes: { opus: pa.groups[key(w.members)] ? 'same' : 'different', astra: pb.groups[key(w.members)] ? 'same' : 'different' }, resolvedBy: 'human', humanNote: ov.note })));
        }
        groups.forEach((g) => (g.groupId = `g_${sha(g.members.join('|')).slice(0, 6)}`));
        const gOf = {};
        for (const g of groups) for (const m of g.members) gOf[m] = g;
        for (const s of pr.suggestions) {
            const g = gOf[s.id];
            s.isDuplicate = !!g;
            s.duplicateIds = g ? g.members.filter((m) => m !== s.id) : [];
            s.groupId = g ? g.groupId : null;
            s.needsUnifiedComment = g ? g.needsUnifiedComment : false;
            s.partialOverlapWith = partial.filter((p) => p.container === s.id || p.contained === s.id).map((p) => (p.container === s.id ? p.contained : p.container));
        }
        pr.groups = groups;
        pr.uniqueConfidence = uniqueConfidence;
        pr.partialOverlap = partial;
    }
    for (const [gf, gold] of Object.entries(golds)) fs.writeFileSync(path.join(__dirname, gf), `${JSON.stringify(gold, null, 2)}\n`);
    console.log(`wrote ${Object.keys(golds).length} gold files`);
    process.exit(0);
})();
