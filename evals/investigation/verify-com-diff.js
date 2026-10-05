#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: o verify de PRODUCAO (keep true/false, refutar para
 * derrubar) sobre tudo o que sobrou do dedup de producao, com o diff do PR no
 * comeco do prompt. Profundidade de producao: 5 passos; evidence gate (achado so
 * do G, em arquivo que o G nao abriu) roda de novo com 10. No modelo do cenario.
 *
 *   RECALL_MODEL=<id> node verify-com-diff.js --sufixo= --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson } = require('./eval-structured');
const { buildVerifierPrompt } = require('../../libs/code-review/infrastructure/agents/prompts/verifier-prompt.ts');
const { bundleFor } = require('../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const SUFIXO = arg('sufixo'), POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
// --teto=N: passos do verify (padrao 5). --ks=<arq>: {caseId: [k...]} so essas sugestoes do dedup; sem gate.
const TETO = Number(arg('teto', '5'));
const KS = arg('ks') ? JSON.parse(fs.readFileSync(arg('ks'), 'utf8')) : null;
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
const SYSTEM = buildVerifierPrompt('', 0).system;
const diffDe = (v) => {
    let arr = v?.changedFilesFull; if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    return (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000);
};

function ferramentas(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
}

// Uma sessao de verify: prompt de producao com o diff na frente; veredito pela
// tool submitVerdict ou pelo JSON no texto (o prompt de producao pede JSON).
async function verifica(model, cmd, c, diff, teto) {
    let veredito = null;
    const tools = {
        ...ferramentas(cmd),
        submitVerdict: tool({
            description: 'Submit your verdict for the candidate finding (keep=true unless you can REFUTE it).',
            inputSchema: jsonSchema({ type: 'object', properties: { keep: { type: 'boolean' }, rationale: { type: 'string' } }, required: ['keep', 'rationale'] }),
            execute: async (x) => { veredito = x; return 'verdict recorded'; },
        }),
    };
    const prompt = `<PullRequestDiff>\n${diff}\n</PullRequestDiff>\n\n${buildVerifierPrompt(bundleFor(c), 0).prompt}`;
    const r = await generateText({
        model, system: SYSTEM, prompt, tools,
        stopWhen: (x) => !!veredito || (x.steps?.length ?? 0) >= teto,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= teto - 1
            ? { activeTools: ['submitVerdict'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitVerdict' } }),
                messages: [...messages, { role: 'user', content: 'You are at the final step. Give your final JSON verdict now, from the evidence you already have.' }] }
            : undefined,
    });
    if (!veredito) veredito = extraiJson(r.text || '');
    return { keep: veredito?.keep !== false, temVeredito: !!veredito, passos: r.steps?.length ?? 0 };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify+diff] ${descreveModelo(MODELO)} · ${SUFIXO}`);
    const DD = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', arg('dedup', 'dedup-prod2'), `${SUFIXO}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => (!SO.length || SO.includes(c)) && DD[c] && !DD[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        const cands = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', POOL, `${cid}.raw.txt`), 'utf8'));
        const lidosG = new Set((raw.trace.toolCalls || []).filter((x) => (x.tool || x.name) === 'readFile').map((x) => norm(x.args?.path || x.input?.path)));
        const lido = (f) => { const n = norm(f); for (const s of lidosG) if (s && (s === n || s.endsWith('/' + n) || n.endsWith('/' + s))) return true; return false; };
        const diff = diffDe(vars[cid]);
        let h;
        try {
            h = await prepareRepo(vars[cid], `${cid}-vd-${process.pid}`);
            if (!h) throw new Error('sem repo');
            const cmd = new LocalRepoCommands(h.dir);
            const kept = KS ? (KS[cid] || []) : (DD[cid].kept || []);
            const decis = {};
            let j = 0;
            await Promise.all(Array.from({ length: 4 }, async () => {
                while (j < kept.length) {
                    const k = kept[j++]; const c = cands[k];
                    let v = await retry(() => verifica(model, cmd, c, diff, TETO));
                    // Evidence gate de producao: so do G, em arquivo que o G nao abriu, e mantido -> 10 passos.
                    const gate = !KS && c.producedBy === 'generalist-base' && !lido(c.relevantFile) && v.keep;
                    if (gate) v = { ...(await retry(() => verifica(model, cmd, c, diff, 10))), gate: true };
                    decis[k] = v;
                }
            }));
            res.prs[cid] = { kept, decisoes: decis, textos: kept.filter((k) => decis[k]?.keep !== false).map((k) => cands[k].suggestionContent).filter(Boolean) };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    fs.writeFileSync(OUT.replace(/\.json$/, '.comentarios.json'), JSON.stringify(Object.fromEntries(Object.entries(res.prs).filter(([, p]) => !p.erro).map(([c, p]) => [c, p.textos]))));
    const ds = ok.flatMap((p) => Object.values(p.decisoes));
    console.log(JSON.stringify({ sufixo: SUFIXO, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, sugestoes: ds.length, derrubadas: ds.filter((d) => !d.keep).length, gate: ds.filter((d) => d.gate).length, semVeredito: ds.filter((d) => !d.temVeredito).length }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
