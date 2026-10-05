#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: classifica os falsos positivos que sobram depois do verify B (topo 3
 * garantido, protecao 1). Medicao, nao etapa do pipeline: o classificador e o
 * Claude Opus 5.5 por assinatura (Agent SDK), com Read/Grep/Glob no worktree
 * do PR, uma sessao por PR e modelo. "Bug real fora do gabarito" so vale com
 * o trecho de codigo citado conferido lexicamente no arquivo do head.
 *
 *   RECALL_CLAUDE_SDK_DIR=<dir> node classificador-fp.js --out=results/fp-analise [--modelos=ds,gpt] [--only=caseId]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { prepareRepo } = require('./prepare-repo');
const { extraiJson } = require('./eval-structured');
const { carregaSdk, envDoProcesso } = require('./claude-sdk-runner');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const OUT = arg('out', 'results/fp-analise'), PAR = Number(arg('par', '2'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const CLASSIFICADOR = 'claude-opus-5-5';
const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);
const MODELOS = {
    ds: { nome: 'DeepSeek V4.1 Flash', fusao: 'results/dedup-meta/t9-v5-fresco.json', fila: 'results/etapa3/ds-fila65.json', verify: 'results/etapa3/ds-cenario.json', pool: '01.10.26_f1_deepseek_together' },
    gpt: { nome: 'GPT-6.1 Sol', fusao: 'results/dedup-meta/gpt61-r1-v5.json', fila: 'results/etapa3/gpt-fila65.json', verify: 'results/etapa3/gpt-cenario.json', pool: '01.10.26_f2_gpt61_sub' },
    muse: { nome: 'Muse Spark 1.2', fusao: 'results/dedup-meta/muse-r1-v5.json', fila: 'results/etapa3/muse-fila65.json', verify: 'results/etapa3/muse-cenario.json', pool: '01.10.26_f2_muse' },
    glm: { nome: 'GLM 5.3', fusao: 'results/dedup-meta/glm53-r1-v5.json', fila: 'results/etapa3/glm53-fila65.json', verify: 'results/etapa3/glm53-cenario.json', pool: '01.10.26_f2_glm53_together' },
    kimi: { nome: 'Kimi K3', fusao: 'results/dedup-meta/kimi3-r1-v5.json', fila: 'results/etapa3/kimi3-fila65.json', verify: 'results/etapa3/kimi3-cenario.json', pool: '01.10.26_f1_kimi3_together' },
};
const QUAIS = (arg('modelos', '') || Object.keys(MODELOS).join(',')).split(',');

const CATEGORIAS = {
    bug_real_fora_gabarito: 'A real defect that exists in the code at the PR head, but is not any of the expected issues listed. You MUST give the code that shows it (file, lines, exact code).',
    golden_nao_reconhecido: 'It describes one of the expected issues listed below (same underlying problem), even if worded differently.',
    duplicata: 'It reports the same problem as another published comment of this PR (give its index).',
    nao_e_bug: 'The claim is false about the code: the described failure cannot happen, or the code does not do what the comment says.',
    programacao_defensiva: 'Asks for a null check, validation, try/catch, guard or fallback, without a concrete path in this code where the missing guard produces a wrong result.',
    nitpick: 'Style, naming, comments, documentation, logging wording, harmless dead code, readability.',
    teste: 'About tests: a test that does not cover or does not verify something. The production code itself is fine.',
    especulativo: 'Depends on hypothetical usage, configuration, scale or future changes that nothing in this PR indicates.',
};

/** Fila publicada depois do verify B: topo 3 + o que o B manteve (protecao 1). */
function publicados(m, cid) {
    const reps = m.Q[cid] || [];
    return reps.filter((r, p) => {
        if (p < 3) return true;
        const d = m.V[cid]?.decisoes?.[String(r)]?.v1;
        return !(d && d.keep === false && d.leuCitado);
    });
}

function vencedores(confs, pubs) {
    const venc = new Set();
    const ng = pubs.length ? confs[pubs[0]].length : 0;
    for (let gi = 0; gi < ng; gi++) {
        let b = 0, q = null;
        for (const r of pubs) if (confs[r][gi] > b) { b = confs[r][gi]; q = r; }
        if (q != null) venc.add(q);
    }
    return venc;
}

const limpa = (t) => String(t || '').replace(/^\s*\d+\s*[:|→]\s?/, '').replace(/^[+-](?![+-])/, '').replace(/\s+/g, '');
function confere(dir, ev) {
    if (!ev || !ev.file || !ev.code) return false;
    let rel = String(ev.file).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (rel.startsWith(dir)) rel = path.relative(dir, rel);
    let abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
        let todos = [];
        try { todos = execFileSync('git', ['-C', dir, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n'); } catch {}
        const achou = todos.filter((f) => f === rel || f.endsWith('/' + rel));
        if (achou.length !== 1) return false;
        abs = path.join(dir, achou[0]);
    }
    const linhas = fs.readFileSync(abs, 'utf8').split('\n');
    const ini = Math.max(0, (Number(ev.startLine) || 1) - 11), fim = Math.min(linhas.length, (Number(ev.endLine) || Number(ev.startLine) || linhas.length) + 10);
    const janela = linhas.slice(ini, fim).map(limpa).join('');
    const pedacos = String(ev.code).split(/\n|\.\.\.|…/).map(limpa).filter(Boolean);
    if (pedacos.join('').length < 15) return false;
    let pos = 0;
    for (const p of pedacos) { const k = janela.indexOf(p, pos); if (k < 0) return false; pos = k + p.length; }
    return true;
}

function prompt(goldens, itens, alvos) {
    return `You are auditing the comments an AI code reviewer posted on a pull request. The repository is checked out at the PR head in your working directory; read the code with Read, Grep and Glob before you decide anything.

<ExpectedIssues>
${goldens.map((g, i) => `[G${i}] ${g}`).join('\n')}
</ExpectedIssues>

<PublishedComments>
${itens.map((c, i) => `[${i}] ${c.file}:${c.ini ?? '?'}-${c.fim ?? '?'}\n${String(c.texto || '').slice(0, 1800)}`).join('\n\n')}
</PublishedComments>

Classify ONLY the comments with these indices: ${alvos.join(', ')}. The others are listed for context (to spot duplicates).

Categories (pick exactly one per comment):
${Object.entries(CATEGORIAS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Rules:
- Read the cited code for every comment you classify. Decide from the code, not from the comment's wording.
- Check golden_nao_reconhecido and duplicata first. If neither applies, decide whether the defect is real.
- bug_real_fora_gabarito requires evidence: the file, startLine, endLine and the exact code (copied from the file, without line numbers) that shows the defect. If you cannot point at that code, it is not this category.
- When a real defect is also defensive or speculative in nature, prefer bug_real_fora_gabarito only if the code shows a concrete path to the wrong result.

End your answer with ONLY a JSON object, no code fence:
{"itens":[{"indice":<n>,"categoria":"<category>","porque":"one sentence citing file:line","golden":"G<i> or null","duplicaDe":<index or null>,"evidencia":{"file":"...","startLine":<n>,"endLine":<n>,"code":"..."} or null}]}`;
}

async function sessao(dir, texto) {
    const sdk = await carregaSdk();
    let saida = '';
    for await (const msg of sdk.query({
        prompt: texto,
        options: {
            model: CLASSIFICADOR,
            systemPrompt: 'You are a senior engineer auditing code review comments. Be strict and precise; verify every claim in the code.',
            tools: ['Read', 'Grep', 'Glob'],
            allowedTools: ['Read', 'Grep', 'Glob'],
            disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
            settingSources: [],
            cwd: dir,
            maxTurns: Number(process.env.FP_MAX_TURNS || 60),
            env: envDoProcesso(),
        },
    })) {
        if (msg.type === 'assistant') for (const c of msg.message.content || []) if (c.type === 'text') saida += c.text + '\n';
        if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
    }
    return extraiJson(saida);
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { const r = await fn(); if (r) return r; u = new Error('sem JSON'); } catch (e) { u = e; } await new Promise((ok) => setTimeout(ok, 10000 * 2 ** t)); } throw u; }

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const vars = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'));
    const goldensDe = Object.fromEntries(v2.prs.map((p) => [p.caseId, (p.comments || []).filter((g) => CORE.has(g.category)).map((g) => g.comment)]));
    const M = {};
    for (const k of QUAIS) {
        const m = MODELOS[k];
        M[k] = { ...m, F: JSON.parse(fs.readFileSync(m.fusao, 'utf8')).prs, Q: JSON.parse(fs.readFileSync(m.fila, 'utf8')), V: JSON.parse(fs.readFileSync(m.verify, 'utf8')).prs,
            res: fs.existsSync(`${OUT}/${k}.json`) ? JSON.parse(fs.readFileSync(`${OUT}/${k}.json`, 'utf8')) : { modelo: m.nome, prs: {} } };
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8')).filter((c) => !SO.length || SO.includes(c));
    const fila = L30.filter((c) => QUAIS.some((k) => M[k].Q[c] && (!M[k].res.prs[c] || M[k].res.prs[c].erro)));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            h = await prepareRepo(vars[cid], `${cid}-fp-${process.pid}`);
            if (!h) throw new Error('sem repo');
            await Promise.all(QUAIS.map(async (k) => {
                const m = M[k];
                if (!m.Q[cid] || (m.res.prs[cid] && !m.res.prs[cid].erro)) return;
                try {
                    const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${m.pool}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                    const confs = Object.fromEntries(m.F[cid].itens.map((it) => [it.rep, it.confs]));
                    const textoDe = Object.fromEntries(m.F[cid].itens.map((it) => [it.rep, it.texto || cs[it.rep].suggestionContent]));
                    const pubs = publicados(m, cid);
                    const venc = vencedores(confs, pubs);
                    const itens = pubs.map((r) => ({ rep: r, file: cs[r].relevantFile, ini: cs[r].relevantLinesStart, fim: cs[r].relevantLinesEnd, texto: textoDe[r] }));
                    const alvos = pubs.map((r, j) => (venc.has(r) ? null : j)).filter((j) => j != null);
                    let classes = [];
                    if (alvos.length) {
                        // So vale a resposta que classifica TODOS os alvos; senao, nova sessao.
                        const r = await retry(async () => {
                            const x = await sessao(h.dir, prompt(goldensDe[cid] || [], itens, alvos));
                            const vistos = new Set((x?.itens || []).filter((y) => CATEGORIAS[y?.categoria]).map((y) => Number(y.indice)));
                            return alvos.every((j) => vistos.has(j)) ? x : null;
                        });
                        classes = r.itens || [];
                    }
                    const por = Object.fromEntries(classes.map((x) => [Number(x.indice), x]));
                    m.res.prs[cid] = {
                        publicados: pubs.length, acertos: venc.size,
                        fps: alvos.map((j) => {
                            const x = por[j] || { categoria: 'sem_classificacao' };
                            const r = pubs[j];
                            const out = { rep: r, file: itens[j].file, texto: String(itens[j].texto || '').slice(0, 400), dupDeGoldenNoJuiz: confs[r].some((v) => v > 0), categoria: x.categoria, porque: x.porque, golden: x.golden ?? null, duplicaDe: x.duplicaDe ?? null };
                            if (x.categoria === 'bug_real_fora_gabarito') { out.evidencia = x.evidencia || null; out.evidenciaConfere = confere(h.dir, x.evidencia); }
                            return out;
                        }),
                    };
                } catch (e) {
                    m.res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
                } finally {
                    fs.writeFileSync(`${OUT}/${k}.json`, JSON.stringify(m.res, null, 1));
                }
            }));
            console.log(`  ${cid.slice(0, 50)} ok`);
        } catch (e) {
            console.log(`  ${cid.slice(0, 50)} FALHOU: ${String(e?.message || e).slice(0, 150)}`);
        } finally {
            if (h) await h.cleanup();
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    for (const k of QUAIS) {
        const ok = Object.values(M[k].res.prs).filter((p) => !p.erro);
        const cat = {};
        for (const p of ok) for (const f of p.fps) { const c = f.categoria === 'bug_real_fora_gabarito' && !f.evidenciaConfere ? 'bug_real_sem_evidencia_conferida' : f.categoria; cat[c] = (cat[c] || 0) + 1; }
        console.log(JSON.stringify({ modelo: k, prs: ok.length, erros: Object.values(M[k].res.prs).length - ok.length, fps: ok.reduce((a, p) => a + p.fps.length, 0), cat }));
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
