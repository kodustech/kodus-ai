require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Hypothesis #3 of #1821: pairwise ranking inside the PR.
 *
 * The attributor scores each group alone (0-100). Here the model sees two
 * groups of the same PR and only says which one is more worth a comment.
 * Every pair is asked in both orders to cancel position bias; the votes are
 * aggregated offline (Bradley-Terry) by avaliar-pairwise.py.
 *
 * Input: results/pw-ranking.json (exportar-ranking.py) — the champion order
 * and the pairs inside the comparison window. Output: results/pw-votes.json,
 * written after every call so a run can be resumed.
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');

const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump', 'sol-teto2');
const PAR = Number(arg('par', '6'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol@sub';
const RANK = path.join(__dirname, 'results', arg('ranking', 'pw-ranking.json'));
const OUT = path.join(__dirname, 'results', arg('out', 'pw-votes.json'));

const escolherTool = tool({
    description: 'Record your choice. Call exactly once.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            escolha: { type: 'string', enum: ['A', 'B'], description: 'The comment more worth posting.' },
            confianca: { type: 'number', description: '50-100: how sure you are. 50 = coin flip.' },
            porque: { type: 'string', description: 'One sentence.' },
        },
        required: ['escolha', 'confianca', 'porque'],
    }),
});

const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + ' …' : s || '');
const show = (c) => `File: ${c.relevantFile}:${c.relevantLinesStart}-${c.relevantLinesEnd}
Severity: ${c.severity} | Label: ${c.label}
Summary: ${c.oneSentenceSummary}
Comment: ${cut(c.suggestionContent, 1500)}
Evidence: ${cut(c.reason, 800)}
Existing code:
${cut(c.existingCode, 600)}
Suggested code:
${cut(c.improvedCode, 600)}`;

const prompt = (diff, a, b) => `You are reviewing a pull request as an experienced developer who owns this codebase. Two review comments were drafted for it, and only ONE of them will be posted.

Pick the one that is more worth posting: the one more likely to make the author change the code before merging, because it points at a real defect this change introduces or exposes and that matters in practice. Judge the defect, not the wording. Do not prefer a comment for being longer, more confident, or more severe-sounding.

<Diff>
${diff}
</Diff>

<CommentA>
${show(a)}
</CommentA>

<CommentB>
${show(b)}
</CommentB>

Call the tool once with your choice.`;

(async () => {
    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
    const patches = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) patches[v.caseId] = Object.fromEntries(J(v.changedFilesFull).map((x) => [x.filename, x.patchWithLinesStr || '']));
        } catch {}
    }
    const cands = {};
    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        cands[j.caseId] = j.trace?.preFilterCandidates || [];
    }
    const rank = JSON.parse(fs.readFileSync(RANK, 'utf8'));
    const votes = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).votos : {};
    const save = () => fs.writeFileSync(OUT, JSON.stringify({ modelo: MODEL, ranking: path.basename(RANK), votos: votes }, null, 1));

    const jobs = [];
    for (const [cid, r] of Object.entries(rank)) {
        if (SO.length && !SO.includes(cid)) continue;
        for (const [i, j] of r.pairs) {
            for (const [x, y] of [[i, j], [j, i]]) {
                const key = `${x}|${y}`;
                if (votes[cid]?.[key]) continue;
                jobs.push({ cid, x, y, key, a: cands[cid][r.orig[x]], b: cands[cid][r.orig[y]] });
            }
        }
    }
    console.log(`${jobs.length} calls pending`);
    const diffFor = (cid, a, b) => {
        const files = [...new Set([a.relevantFile, b.relevantFile])];
        return files.map((f) => `--- ${f}\n${cut((patches[cid] || {})[f] || '(file not in diff)', 7000)}`).join('\n\n');
    };
    let done = 0, fail = 0;
    const one = async (jb) => {
        for (let t = 0; t < 4; t++) {
            try {
                const r = await generateText({
                    model,
                    tools: { escolher: escolherTool },
                    toolChoice: { type: 'tool', toolName: 'escolher' },
                    prompt: prompt(diffFor(jb.cid, jb.a, jb.b), jb.a, jb.b),
                });
                const call = (r.toolCalls || []).find((c) => (c.toolName ?? c.name) === 'escolher');
                const inp = call?.input ?? call?.args;
                if (!inp?.escolha) throw new Error('no tool call');
                (votes[jb.cid] ||= {})[jb.key] = { winner: inp.escolha === 'A' ? jb.x : jb.y, conf: inp.confianca, why: inp.porque };
                done++;
                if (done % 25 === 0) { save(); console.log(`  ${done}/${jobs.length} (${fail} failed)`); }
                return;
            } catch (e) {
                if (t === 3) { fail++; console.log(`  FAILED ${jb.cid} ${jb.key}: ${String(e?.message || e).slice(0, 160)}`); }
                else await new Promise((res) => setTimeout(res, 5000 * (t + 1)));
            }
        }
    };
    let next = 0;
    await Promise.all(Array.from({ length: PAR }, async () => { while (next < jobs.length) await one(jobs[next++]); }));
    save();
    console.log(`\n-> ${OUT}  (${done} ok, ${fail} failed)`);
})().catch((e) => { console.error(e); process.exit(1); });
