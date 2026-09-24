#!/usr/bin/env node
/**
 * Dois filtros de precisao rodando DEPOIS do reducer, sobre o ds16b.
 *
 * Por que depois do reducer, e nao no lugar dele: medimos hoje que todo filtro
 * por candidato perde para ele, e a causa nao e julgamento — e deduplicacao.
 * O pool tem 301 candidatos cobrindo 58 goldens; 69 bastariam. Um scorer que
 * olha um candidato de cada vez da nota alta para os cinco que descrevem o
 * mesmo golden, e quatro viram FP. O reducer funde. Entao o lugar de um filtro
 * novo e em cima dos 154 que ele ja deduplicou.
 *
 * Por que SEM ferramentas nos dois. O estudo comparativo de agentes em filtro
 * de falso positivo (arXiv 2601.22952) mediu que, com DeepSeek, prompting
 * vanilla bate as variantes agenticas: o agente sofre "scope drift" e escala
 * preocupacoes alem do alerta. Ganho agentico so aparece com backbone forte.
 * Foi exatamente o que vimos no criterio `walk`, que matou um SSRF real
 * alegando que o percurso comecava fora do PR. Entao aqui o contexto vem
 * PRONTO — a fatia em volta de cada file:line que o proprio achado cita — no
 * espirito do eCPG-Slicer do LLM4FPM (arXiv 2411.03079), sem Joern.
 *
 * TESTE `vanilla`: k amostras independentes, voto ponderado por confianca
 * (self-consistency do LLM4FPM + CISC). Reduz variancia sem dar ferramenta.
 *
 * TESTE `gate`: Refute-or-Promote estagiado (arXiv 2604.19049) com o onus da
 * prova invertido. Hoje o default e "mantem a menos que alguem refute". Aqui
 * um achado so passa se (1) alguem instanciar entrada/estado concreto que
 * dispara a falha, e (2) um refutador, que NAO ve essa defesa, falhar em
 * mata-lo citando o codigo. O paper da sobre-correcao em revisao de codigo
 * (arXiv 2603.00539) aponta que boa parte das rejeicoes vem de alegacao nao
 * verificada; exigir contraexemplo concreto ataca os dois lados.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { registerTracing, tele, comTrace, flush } = require('./eval-tracing');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const TESTE = arg('teste', 'vanilla');
const DUMP = arg('dump', 'ds16b');
const K = Number(arg('k', '5'));
const PARPR = Number(arg('parpr', '4'));
const PAR = Number(arg('par', '6'));
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const OUT = arg('out', path.join(__dirname, 'results', `pt-${TESTE}.json`));
const MODEL = process.env.RECALL_MODEL || 'deepseek-v4.1-flash@fireworks';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

registerTracing(`precision-${TESTE}`);

/* ---------------------------------------------------------------- contexto */

/** file:line citados no walk — e onde o achado afirma que o codigo esta. */
function referencias(texto) {
    const out = [];
    const re = /([\w./\-]+\.\w{1,6}):(\d+)/g;
    let m;
    while ((m = re.exec(String(texto || ''))) && out.length < 8) {
        out.push({ file: m[1], line: Number(m[2]) });
    }
    return out;
}

/**
 * A fatia: +-18 linhas em volta de cada file:line que o achado cita, mais as
 * linhas do proprio achado. E a aproximacao pobre do slice do LLM4FPM — sem
 * grafo de dependencia, mas pelo menos o verificador nao precisa ir buscar.
 */
async function fatiar(cmd, c) {
    const alvos = [
        { file: c.relevantFile, line: c.relevantLinesStart },
        ...referencias(c.reason),
        ...referencias(c.suggestionContent),
    ];
    const vistos = new Set();
    const partes = [];
    for (const a of alvos) {
        if (!a.file || !a.line) continue;
        const chave = `${a.file}:${Math.floor(a.line / 30)}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        try {
            const txt = await cmd.read(a.file, Math.max(1, a.line - 18), a.line + 18);
            if (txt) partes.push(`--- ${a.file}:${Math.max(1, a.line - 18)}-${a.line + 18}\n${String(txt).slice(0, 2600)}`);
        } catch {}
        if (partes.length >= 5) break;
    }
    return partes.join('\n\n') || '(nao foi possivel ler o codigo)';
}

const bloco = (c, fatia, diff) => `<Finding>
  file: ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
  ${c.oneSentenceSummary || ''}
  ${String(c.suggestionContent || '').slice(0, 900)}
</Finding>

<WalkTheReviewerRecorded>
${String(c.reason || '(none recorded)').slice(0, 1000)}
</WalkTheReviewerRecorded>

<DiffOfThatFile>
${String(diff || '(unavailable)').slice(0, 5000)}
</DiffOfThatFile>

<CodeAroundEveryLineTheFindingCites>
${fatia}
</CodeAroundEveryLineTheFindingCites>`;

/* ----------------------------------------------------------- teste vanilla */

const votoTool = tool({
    description: 'Registra o veredito. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            veredito: { type: 'string', enum: ['post', 'drop'] },
            confianca: { type: 'number', description: '0-100: quanto voce confia NESTE veredito.' },
            porque: { type: 'string', description: 'Uma frase, citando file:line.' },
        },
        required: ['veredito', 'confianca', 'porque'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const pVanilla = (c, fatia, diff) => `${bloco(c, fatia, diff)}

Everything you need is above: the diff of the changed file, and the code around
every line this finding cites. There is nothing else to look up.

Decide whether this finding should be posted as a review comment on this pull
request. Post it when the code above shows something is actually wrong — a
wrong value reaching a caller, a crash, data lost, a permission not enforced,
a contract the platform will break on. Drop it when the code above shows the
claim does not hold, when the problem was already there before this change and
this change did not touch it, when it asks for a defence nobody violates, or
when it is a preference about how the code is written.

Judge only the finding in front of you. Do not widen it into a related concern,
and do not drop it because you would have phrased it differently.

Call voto exactly once, with how much you trust YOUR OWN verdict in "confianca":
100 means the code above settles it, 50 means you are guessing.`;

/* -------------------------------------------------------------- teste gate */

const promoverTool = tool({
    description: 'Registra a tentativa de instanciar a falha. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            concreto: { type: 'boolean', description: 'true somente se voce escreveu entrada/estado concreto E a saida errada concreta.' },
            entrada: { type: 'string', description: 'A entrada ou estado concreto, com valores. "-" se nao conseguiu.' },
            saida: { type: 'string', description: 'O que sai de errado, concretamente. "-" se nao conseguiu.' },
        },
        required: ['concreto', 'entrada', 'saida'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const refutarTool = tool({
    description: 'Registra a refutacao. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            refutado: { type: 'boolean' },
            clausula: { type: 'string', description: 'O file:line e o trecho que contradiz a alegacao. "-" se nao refutou.' },
        },
        required: ['refutado', 'clausula'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const pPromover = (c, fatia, diff) => `${bloco(c, fatia, diff)}

Your job is to make this finding FIRE. Not to judge it — to instantiate it.

Write the concrete input or program state that drives the code above into the
failure, and the concrete wrong thing that comes out. Concrete means values a
person could type: this field is the empty string, this list has 0 elements,
this call returns null, two requests arrive in this order. "A large input" and
"a malformed payload" are not values.

Then say what comes out: the wrong number, the exception and where it is
thrown, the row that ends up corrupted, the request that gets through the check.

Use only the code above. If you cannot write both halves from it — because the
path is guarded, because the value cannot take that shape, because the finding
asks for a defence rather than describing a failure, or because nothing
actually goes wrong at the end — then set concreto to false. That is a normal
and correct outcome; do not invent a scenario to fill the field.

Call promover exactly once.`;

const pRefutar = (c, fatia, diff) => `${bloco(c, fatia, diff)}

Your job is to kill this finding, and you may only do it with the code above.

Refute it when the code contradicts the claim: the guard the finding says is
missing is there, the value it says can be null cannot be, the caller it says
breaks does not exist, the behaviour it flags predates this change and the diff
did not touch it, or the branch it needs is unreachable.

To refute you must quote the clause: the file:line and the actual text that
contradicts it. A refutation without a quote does not count — set refutado to
false instead.

Do not refute because the finding is minor, thin, badly worded, or because you
would have written the code differently. Those are not contradictions.

Call refutar exactly once.`;


/* ------------------------------------------------------------- teste gate2 */

/**
 * O portao do `gate` exige uma coisa so: entrada concreta -> saida errada.
 * Auditado, ele descartou 36 achados, 28 deles falso positivo puro — mas os 8
 * que custaram golden sao quase todos a MESMA classe: nome exportado que nao
 * bate com o arquivo, docstring que promete lista e devolve dict, Javadoc que
 * diz 3 letras onde o codigo usa 2, teste chamado "empty_array" que passa um
 * dict. Sao comentarios que um revisor humano faz e o golden registra, e nao
 * tem falha em runtime nenhuma: o modelo escreve "-" nas duas metades, com
 * razao, e o achado morre.
 *
 * Entao a correcao nao e afrouxar o portao — e reconhecer que existe uma
 * segunda forma de prova do mesmo rigor. Uma contradicao documentada tambem e
 * verificavel e tambem se prova com citacao: o texto que promete X e o codigo
 * que faz Y, cada um com file:line. O que continua barrado e o que nao tem
 * nem uma coisa nem outra — preferencia de estilo, defesa que ninguem viola,
 * problema que ja existia antes da mudanca.
 */
const promover2Tool = tool({
    description: 'Registra a prova. Chame exatamente uma vez.',
    inputSchema: jsonSchema({
        type: 'object',
        properties: {
            tipo: {
                type: 'string',
                enum: ['falha', 'contradicao', 'nenhuma'],
                description: '"falha" se voce escreveu entrada e saida concretas; "contradicao" se voce citou os dois trechos que se contradizem; "nenhuma" se nao conseguiu nenhuma das duas.',
            },
            entrada: { type: 'string', description: 'tipo=falha: a entrada ou estado concreto, com valores. Senao "-".' },
            saida: { type: 'string', description: 'tipo=falha: o que sai de errado, concretamente. Senao "-".' },
            promete: { type: 'string', description: 'tipo=contradicao: file:line e o texto que promete uma coisa. Senao "-".' },
            faz: { type: 'string', description: 'tipo=contradicao: file:line e o codigo que faz outra. Senao "-".' },
        },
        required: ['tipo', 'entrada', 'saida', 'promete', 'faz'],
        additionalProperties: false,
    }),
    execute: async () => ({ output: 'ok' }),
});

const pPromover2 = (c, fatia, diff) => `${bloco(c, fatia, diff)}

Your job is to prove this finding, using only the code above. There are exactly
two ways to prove one, and you must pick the one that fits.

WAY 1 — "falha": the code misbehaves at runtime.
Write the concrete input or program state that drives it into the failure, and
the concrete wrong thing that comes out. Concrete means values a person could
type: this field is the empty string, this list has 0 elements, this call
returns null, two requests arrive in this order. "A large input" is not a value.
Then say what comes out: the wrong number, the exception and where it is thrown,
the row that ends up corrupted, the request that gets through the check.

WAY 2 — "contradicao": something in the code states a promise that another part
of the code breaks, and both are written down. A docstring or comment that
describes behaviour the function does not have. An exported or declared name
that does not match what the thing is. A test whose name describes a case its
body does not exercise. A signature, annotation or type that disagrees with the
implementation. Quote BOTH sides with file:line — what it promises, and what it
actually does. Nothing runs wrong here; the mismatch itself is the defect, and
it is only a defect if you can point at both halves.

If neither fits, answer "nenhuma". That is a normal and correct outcome — use it
when the finding is a preference about how the code is written, when it asks for
a defence no caller violates, when the behaviour predates this change and the
diff did not touch it, or when the path is guarded so the failure cannot occur.
Do not stretch a style preference into a contradiction, and do not invent a
scenario to fill the fields.

Call promover exactly once.`;

/* -------------------------------------------------------------------- main */

(async () => {
    const pool = {}, vars = {}, diffs = {};
    const dir = path.join(S, DUMP);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const c = j.trace?.preFilterCandidates || [];
        if (c.length) (pool[j.caseId] ||= []).push(...c);
    }
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) {
                vars[v.caseId] = v;
                diffs[v.caseId] = Object.fromEntries(
                    J(v.changedFilesFull).map((x) => [x.filename, x.patchWithLinesStr || '']),
                );
            }
        } catch {}
    }
    // O conjunto que o reducer manteve. Quando existe o arquivo de indices
    // (produzido pelo replay), usa ele; senao deriva do proprio dump, casando
    // os achados postados de volta nos candidatos pre-reducer. Sem isso o gate
    // so rodava sobre um dump especifico, que foi o que deixou a rodada nova
    // sem filtro nenhum.
    const idxFile = arg('keep', path.join(__dirname, 'results', `reducer-keep-idx-${DUMP}.json`));
    let keepIdx;
    if (fs.existsSync(idxFile)) {
        keepIdx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    } else if (fs.existsSync(path.join(__dirname, 'results', 'reducer-keep-idx.json')) && DUMP === 'ds16b') {
        keepIdx = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'reducer-keep-idx.json'), 'utf8'));
    } else {
        keepIdx = {};
        const chave = (x) =>
            `${x.relevantFile}|${x.relevantLinesStart}|${String(x.oneSentenceSummary || '').slice(0, 80)}`;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const cands = j.trace?.preFilterCandidates || [];
            const mapa = new Map();
            cands.forEach((c, i) => {
                const k = chave(c);
                if (!mapa.has(k)) mapa.set(k, []);
                mapa.get(k).push(i);
            });
            const usados = new Set();
            const sel = [];
            for (const post of j.findings || []) {
                const cand = (mapa.get(chave(post)) || []).find((i) => !usados.has(i));
                if (cand != null) { usados.add(cand); sel.push(cand); }
            }
            keepIdx[j.caseId] = sel;
        }
        fs.writeFileSync(idxFile, JSON.stringify(keepIdx, null, 2));
        console.log(`[keep] derivado do dump -> ${path.basename(idxFile)}`);
    }

    const model = buildModel(MODEL);
    console.log(`[teste] ${TESTE} · [modelo] ${descreveModelo(MODEL)} · k=${K}`);

    const ids = Object.keys(keepIdx).filter((c) => pool[c]).filter((c) => !SO.length || SO.includes(c));
    const saida = {};
    const diag = { chamadas: 0, semTool: 0, erro: 0, motivos: [], drop: 0, post: 0, semConcreto: 0, refutados: 0 };
    const detalhe = [];

    const umPR = async (cid, i) => {
        const cands = pool[cid];
        const alvo = keepIdx[cid] || [];
        let handle = null, cmd = null;
        try {
            handle = await prepareRepo(vars[cid], cid);
            if (handle) cmd = new LocalRepoCommands(handle.dir);
        } catch (e) {
            diag.motivos.push(`prepareRepo ${cid}: ${String(e?.message || e).slice(0, 110)}`);
        }

        const decidir = async (fi) => {
            const c = cands[fi];
            if (!c) return null;
            const fatia = cmd ? await fatiar(cmd, c) : '(repo indisponivel)';
            const diff = (diffs[cid] || {})[c.relevantFile] || '';

            if (TESTE === 'vanilla') {
                const votos = [];
                for (let k = 0; k < K; k++) {
                    try {
                        diag.chamadas++;
                        const r = await generateText({
                            ...tele('pt-vanilla', { caseId: cid }),
                            model,
                            tools: { voto: votoTool },
                            toolChoice: { type: 'tool', toolName: 'voto' },
                            prompt: pVanilla(c, fatia, diff),
                        });
                        const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'voto');
                        const a = call?.input ?? call?.args;
                        if (a) votos.push(a); else diag.semTool++;
                    } catch (e) {
                        diag.erro++;
                        diag.motivos.push(`vanilla: ${String(e?.message || e).slice(0, 130)}`);
                    }
                }
                if (!votos.length) return { fi, manter: true, nota: 'sem voto' };
                // Voto ponderado por confianca (CISC). Empate mantem: um filtro
                // que hesita nao deve apagar achado.
                const peso = (v) => Math.max(1, Number(v.confianca) || 50);
                const post = votos.filter((v) => v.veredito === 'post').reduce((s, v) => s + peso(v), 0);
                const drop = votos.filter((v) => v.veredito === 'drop').reduce((s, v) => s + peso(v), 0);
                const manter = post >= drop;
                manter ? diag.post++ : diag.drop++;
                detalhe.push({
                    caseId: cid, fi, manter, post, drop,
                    votos: votos.map((v) => `${v.veredito}/${v.confianca}`).join(' '),
                    porque: votos.find((v) => v.veredito === (manter ? 'post' : 'drop'))?.porque || '',
                    file: c.relevantFile, resumo: c.oneSentenceSummary,
                });
                return { fi, manter };
            }

            // gate: promover primeiro, refutar depois, SEM ver a promocao.
            const g2 = TESTE === 'gate2';
            let prom = null, ref = null;
            try {
                diag.chamadas++;
                const r = await generateText({
                    ...tele(g2 ? 'pt-gate2-promover' : 'pt-gate-promover', { caseId: cid }),
                    model, tools: { promover: g2 ? promover2Tool : promoverTool },
                    toolChoice: { type: 'tool', toolName: 'promover' },
                    prompt: g2 ? pPromover2(c, fatia, diff) : pPromover(c, fatia, diff),
                });
                const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'promover');
                prom = call?.input ?? call?.args ?? null;
                if (prom && g2) prom.concreto = prom.tipo !== 'nenhuma';
            } catch (e) { diag.erro++; diag.motivos.push(`promover: ${String(e?.message || e).slice(0, 130)}`); }
            try {
                diag.chamadas++;
                const r = await generateText({
                    ...tele(TESTE === 'gate2' ? 'pt-gate2-refutar' : 'pt-gate-refutar', { caseId: cid }),
                    model, tools: { refutar: refutarTool },
                    toolChoice: { type: 'tool', toolName: 'refutar' },
                    prompt: pRefutar(c, fatia, diff),
                });
                const call = (r.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'refutar');
                ref = call?.input ?? call?.args ?? null;
            } catch (e) { diag.erro++; diag.motivos.push(`refutar: ${String(e?.message || e).slice(0, 130)}`); }

            // Uma chamada que falhou nao pode virar descarte: o portao so fecha
            // com resposta, nunca com ausencia dela.
            const concreto = prom ? !!prom.concreto : true;
            const refutado = ref ? !!ref.refutado : false;
            if (!concreto) diag.semConcreto++;
            if (refutado) diag.refutados++;
            const manter = concreto && !refutado;
            manter ? diag.post++ : diag.drop++;
            detalhe.push({
                caseId: cid, fi, manter, concreto, refutado,
                tipo: prom?.tipo || (concreto ? 'falha' : 'nenhuma'),
                promete: String(prom?.promete || '').slice(0, 220),
                faz: String(prom?.faz || '').slice(0, 220),
                entrada: String(prom?.entrada || '').slice(0, 220),
                saida: String(prom?.saida || '').slice(0, 220),
                clausula: String(ref?.clausula || '').slice(0, 260),
                file: c.relevantFile, resumo: c.oneSentenceSummary,
            });
            return { fi, manter };
        };

        const mantidos = [];
        for (let b = 0; b < alvo.length; b += PAR) {
            const lote = await Promise.all(alvo.slice(b, b + PAR).map(decidir));
            for (const r of lote) if (r && r.manter) mantidos.push(r.fi);
        }
        saida[cid] = mantidos;
        try { await handle?.cleanup?.(); } catch {}
        console.log(`[${i + 1}/${ids.length}] ${cid.slice(0, 44).padEnd(46)} ${alvo.length} -> ${mantidos.length}`);
    };

    for (let b = 0; b < ids.length; b += PARPR) {
        await Promise.all(ids.slice(b, b + PARPR).map((cid, k) => comTrace({ name: `pt-${TESTE}`, caseId: cid }, () => umPR(cid, b + k))));
    }

    fs.writeFileSync(OUT, JSON.stringify({ teste: TESTE, modelo: MODEL, k: K, keep: saida, diagnostico: diag, detalhe }, null, 2));
    console.log(`\nDIAGNOSTICO  chamadas ${diag.chamadas} · sem tool ${diag.semTool} · erro ${diag.erro}`);
    if (TESTE === 'gate') console.log(`  sem contraexemplo concreto: ${diag.semConcreto} · refutados: ${diag.refutados}`);
    console.log(`  mantidos ${diag.post} · descartados ${diag.drop}`);
    if (diag.motivos.length) console.log('  motivos:', [...new Set(diag.motivos)].slice(0, 4).join(' | '));
    console.log(`-> ${OUT}`);
    await flush?.();
})().catch((e) => { console.error(e); process.exit(1); });
