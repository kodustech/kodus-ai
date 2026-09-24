#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
/**
 * Pontua os achados JÁ ROTULADOS com o Jev (TypeSafe) e varre o threshold.
 *
 * Por que isto é diferente de tudo que tentamos na filtragem. Todas as outras
 * técnicas — redutor com e sem ferramenta, verify com ônus invertido,
 * path-feasibility, painel adversarial — pedem ao modelo um JULGAMENTO, e
 * medido em quatro formatos ele não contradiz as próprias alegações: 89
 * confirmados contra 25 refutados no feasibility, 2 em 85 no pfa, 1 refutação
 * em 9 no painel, e trocar o modelo não mudou isso. Aqui não se pede
 * julgamento: pede-se uma PROBABILIDADE calibrada, e o corte é nosso.
 *
 * O conjunto já está rotulado — 165 achados postados com `findingHit` do
 * judge, 47 acertos e 118 falsos positivos — então a curva sai offline, sem
 * rodar agente nenhum.
 *
 * `state` = o achado MAIS o diff do arquivo. Só o texto do achado mediria se o
 * Jev reconhece falso positivo pelo jeito de escrever, e a gente já mediu que
 * FP e TP são textualmente indistinguíveis. O diff é o que permite conferir.
 *
 * Ressalva da própria documentação que pesa no nosso caso: aritmética e
 * comparação numérica são fracas nele. Parte dos nossos FP depende disso
 * (janela de tempo, índice, rows-affected) — se o resultado for desigual entre
 * as famílias de defeito, é o primeiro lugar para olhar.
 *
 * Usage:
 *   node evals/investigation/typesafe-filter.js [--limit=N] [--par=6]
 */
const fs = require('fs');
const path = require('path');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(arg('limit', '0'));
const PAR = Number(arg('par', '6'));
const OUT = arg('out', path.join(__dirname, 'results', 'typesafe-filter.json'));
const KEY = process.env.TYPESAFE_API_KEY;
const DUMPS = arg('dumps', 'ds16b').split(',');
const { rotular } = require('./label-candidates');
/** --contexto: alem do diff, manda o codigo em volta lido do clone.
 *
 * Testa a unica explicacao que sobrou para tudo ter empatado em AUC ~0,6: o
 * achado mais o diff do arquivo talvez nao contenham o que decide a questao.
 * O chamador que viola o limite, o guard que ja existe, a assinatura do outro
 * lado — nada disso esta no diff, e sem isso "isto e um defeito real?" nao tem
 * resposta nem para o Jev, nem para o gpt, nem para o deepseek.
 *
 * Montado por regra, sem LLM no meio: a funcao em volta da linha apontada, e
 * os primeiros call sites do simbolo principal. Um LLM pre-selecionando o que
 * importa reintroduziria o julgamento que estamos tentando tirar do caminho. */
const COMCTX = process.argv.includes('--contexto');
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

/**
 * Cinco perguntas estreitas em vez de uma disjunção.
 *
 * A primeira versão perguntava "isto é falso positivo?" com o `true` cobrindo
 * quatro coisas ao mesmo tempo — não se sustenta, já existia, só pede
 * hardening, é estilo. Pedir UMA probabilidade para "A ou B ou C ou D" produz
 * exatamente o que saiu: curva rasa (28,5% -> 50% só no corte 0,10, guardando
 * 21% dos acertos) e um `choice` que empilhou 91% dos casos em "defeito_real",
 * porque ele é mutuamente exclusivo e o caso quase sempre é misto.
 *
 * A doc diz que cada pergunta é avaliada em paralelo e em isolamento, então
 * cinco custam o mesmo que uma. E o conjunto é rotulado: com as respostas
 * separadas dá para medir qual delas discrimina e escolher a combinação nos
 * dados, em vez de adivinhar a fórmula dentro do prompt.
 */
/**
 * v4 — perguntas sobre a CONSEQUENCIA, nao sobre a alegacao.
 *
 * A v2 quebrou a disjuncao em cinco perguntas factuais e nenhuma separou
 * (AUC 0,54 a 0,64). Olhando as medias fica claro por que: `introduzido_aqui`
 * deu 0,822 para acerto e 0,801 para falso positivo, `simbolo_confere` 0,609 e
 * 0,552. Sao perguntas cuja resposta e "sim" nos dois casos — claro que o
 * simbolo confere, o agente copiou codigo real; claro que esta em linha
 * alterada, ele ancora ali. Perguntas sem variancia nao discriminam, por
 * melhor que seja a redacao.
 *
 * Lendo os 118 falsos positivos, o que difere nao e a alegacao: e a
 * CONSEQUENCIA. O falso positivo costuma descrever algo verdadeiro que nao
 * importa, ou uma consequencia que nao se sustenta. Tambem foi testado e
 * descartado o caminho textual: hedging ("may", "could") deu AUC 0,455 e
 * tamanho 0,476 — eles nao escrevem diferente.
 *
 * `autor_concordaria` e a aposta principal: nao pergunta se a alegacao e
 * verdadeira, pergunta que reacao ela teria. A maior familia de falso positivo
 * daqui e coisa que o autor responderia "isso e intencional" ou "ja era assim".
 */
/**
 * v5 — perguntas abertas, de julgamento, em vez de factuais.
 *
 * Escolha guiada pelo que as quatro rodadas anteriores mostraram, nao por
 * intuicao: a pergunta MAIS VAGA foi consistentemente a melhor. "Um revisor
 * senior postaria isto?" deu AUC 0,682, acima de todas as factuais —
 * `simbolo_confere` 0,603, `introduzido_aqui` 0,539, `consequencia_certa`
 * 0,484. Decompor em fatos verificaveis piorou toda vez.
 *
 * A leitura: o modelo nao consegue responder "esta alegacao e verdadeira?",
 * mas tem alguma nocao difusa de "isto merece existir como comentario". Entao
 * em vez de fugir do julgamento subjetivo, esta rodada o ataca de cinco
 * angulos diferentes — prioridade, reacao do autor, valor, custo de oportunidade
 * e familiaridade com a base — para ver se algum deles carrega mais sinal que
 * a pergunta generica.
 *
 * Se todos ficarem na mesma faixa de 0,6, a conclusao e que o teto nao esta na
 * pergunta: esta no que o modelo consegue distinguir.
 */
const perguntas = {
    senior_corrigiria: {
        type: 'noul',
        instructions:
            'Would an experienced developer who owns this codebase change the code because of this comment, before merging?',
        criteria: {
            true: 'They would fix it — it is worth holding the merge for',
            false: 'They would merge as is, and at most open a follow-up',
        },
    },
    gastaria_o_tempo: {
        type: 'noul',
        instructions:
            'A reviewer has five minutes for this pull request and can leave three comments. Is this one of them?',
        criteria: {
            true: 'It is among the most valuable things to say about this change',
            false: 'Other things in this pull request deserve those minutes more',
        },
    },
    irritaria_o_autor: {
        type: 'noul',
        instructions:
            'Would this comment annoy the author — the kind of review note that feels like noise rather than help?',
        criteria: {
            true: 'The author would find it pedantic, obvious, out of scope, or already handled',
            false: 'The author would be glad someone caught it',
        },
    },
    humano_acharia: {
        type: 'noul',
        instructions:
            'Is this something a careful human reviewer would have found on their own reading this diff?',
        criteria: {
            true: 'A human reading this diff would notice it',
            false: 'Only an automated pass would surface this; a human would read past it',
        },
    },
    conhece_a_base: {
        type: 'noul',
        instructions:
            'Would a reviewer who already knows this codebase well agree with this comment, or would they know something that makes it moot?',
        criteria: {
            true: 'Even someone familiar with the code would treat it as a real problem',
            false: 'Someone familiar with the code would know why it is fine, intentional, or handled elsewhere',
        },
    },
};

async function perguntar(state) {
    for (let t = 0; t < 4; t++) {
        try {
            const r = await fetch('https://api.typesafe.ai/v1/systemone', {
                method: 'POST',
                headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ state, model: 'jev-latest', questions: perguntas }),
            });
            if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 140)}`);
            return await r.json();
        } catch (e) {
            if (t === 3) return { erro: String(e.message || e).slice(0, 160) };
            await new Promise((s) => setTimeout(s, 1500 * 2 ** t));
        }
    }
}

/** O simbolo que o achado e sobre: o identificador mais longo citado no
 *  resumo, que na pratica e o nome da funcao ou do campo em questao. */
function simboloPrincipal(texto) {
    const cands = [...String(texto).matchAll(/\b([A-Za-z_][A-Za-z0-9_]{5,})\b/g)].map((m) => m[1]);
    const ruins = new Set(['should', 'return', 'without', 'because', 'instead', 'create', 'update', 'delete', 'request', 'response', 'function', 'method']);
    return cands.filter((c) => !ruins.has(c.toLowerCase())).sort((a, b) => b.length - a.length)[0] || null;
}

async function montarContexto(cmd, it) {
    const partes = [];
    const linha = Number(it.linha) || 0;
    if (cmd && it.file && linha) {
        try {
            const trecho = await cmd.read(it.file, Math.max(1, linha - 40), linha + 40);
            if (trecho) partes.push(`## Code around ${it.file}:${linha}\n${String(trecho).slice(0, 5000)}`);
        } catch {}
    }
    const sym = simboloPrincipal(it.resumo);
    if (cmd && sym) {
        try {
            const g = String(await cmd.grep(sym)).split('\n').filter(Boolean).slice(0, 12).join('\n');
            if (g) partes.push(`## Every place "${sym}" appears\n${g.slice(0, 3000)}`);
        } catch {}
    }
    return partes.join('\n\n');
}

(async () => {
    if (!KEY) { console.error('TYPESAFE_API_KEY ausente'); process.exit(1); }

    // Pool PRE-reducer com rotulo proprio. Ver a nota em `label-candidates.js`:
    // `metadata.findingHit` so rotula o que o reducer deixou passar.
    const hits = await rotular(DUMPS, { force: process.argv.includes('--relabel') });
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) diffs[v.caseId] = Object.fromEntries(J(v.changedFilesFull).map((x) => [x.filename, x.patchWithLinesStr || '']));
        } catch {}
    }

    const itens = [];
    for (const d of DUMPS) {
        const dir = path.join(S, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const h = hits[j.caseId] || [];
            (j.trace?.preFilterCandidates || []).forEach((x, i) => {
                itens.push({
                    caseId: j.caseId,
                    acerto: !!h[i],
                    file: x.relevantFile,
                    resumo: x.oneSentenceSummary,
                    linha: x.relevantLinesStart,
                    linhaFim: x.relevantLinesEnd,
                    codigo: String(x.existingCode || '').slice(0, 250),
                    reason: String(x.reason || '').slice(0, 700),
                    conteudo: String(x.suggestionContent || '').slice(0, 700),
                    diff: String((diffs[j.caseId] || {})[x.relevantFile] || '').slice(0, 7000),
                });
            });
        }
    }
    const lista = LIMIT ? itens.slice(0, LIMIT) : itens;
    console.log(`${lista.length} achados rotulados (${lista.filter((x) => x.acerto).length} acertos, ${lista.filter((x) => !x.acerto).length} falsos positivos)\n`);

    // Um worktree por caso, reaproveitado entre os achados do mesmo PR.
    const repos = {};
    const handles = [];
    if (COMCTX) {
        const { prepareRepo } = require('./prepare-repo');
        const { LocalRepoCommands } = require('./local-repo-commands');
        const casos = [...new Set(lista.map((x) => x.caseId))];
        for (const cid of casos) {
            try {
                const vars = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', `${cid}.json`), 'utf8'))[0].vars;
                const h = await prepareRepo(vars, cid);
                if (h) { repos[cid] = new LocalRepoCommands(h.dir); handles.push(h); }
            } catch {}
        }
        console.log(`contexto: ${Object.keys(repos).length}/${casos.length} repos prontos\n`);
    }

    const res = [];
    for (let b = 0; b < lista.length; b += PAR) {
        const lote = await Promise.all(lista.slice(b, b + PAR).map(async (it) => {
            const ctx = COMCTX ? await montarContexto(repos[it.caseId], it) : '';
            const state = `## Finding\nfile: ${it.file}:${it.linha ?? '?'}\n${it.resumo}\n${it.conteudo}\n\n## Diff of that file\n${it.diff}${ctx ? `\n\n${ctx}` : ''}`;
            const a = await perguntar(state);
            return { ...it, diff: undefined, jev: a?.answers || null, erro: a?.erro, usage: a?.usage };
        }));
        res.push(...lote);
        process.stdout.write(`  ${res.length}/${lista.length}\r`);
    }
    console.log('');
    for (const h of handles) { try { await h.cleanup?.(); } catch {} }

    const ok = res.filter((x) => x.jev?.senior_corrigiria?.noul != null);
    console.log(`${ok.length} pontuados · ${res.length - ok.length} com erro`);
    const erros = res.filter((x) => x.erro);
    if (erros.length) {
        const c = {};
        for (const e of erros) c[e.erro] = (c[e.erro] || 0) + 1;
        for (const [m, n] of Object.entries(c)) console.log(`   ${n}x ${m}`);
    }

    // Varredura preliminar sobre `postaria`. A combinação boa sai da análise
    // offline com os rótulos, não daqui.
    console.log(`\n${'corte'.padStart(6)} ${'mantidos'.padStart(9)} ${'tp'.padStart(4)} ${'fp'.padStart(4)} ${'recall'.padStart(8)} ${'precision'.padStart(10)}`);
    const TPtot = ok.filter((x) => x.acerto).length;
    const curva = [];
    for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]) {
        const mant = ok.filter((x) => x.jev.senior_corrigiria.noul >= 1 - t);
        const tp = mant.filter((x) => x.acerto).length;
        const fp = mant.length - tp;
        const rec = TPtot ? tp / TPtot : 0;
        const pre = mant.length ? tp / mant.length : 0;
        curva.push({ corte: t, mantidos: mant.length, tp, fp, recallRelativo: rec, precision: pre });
        console.log(`${t.toFixed(2).padStart(6)} ${String(mant.length).padStart(9)} ${String(tp).padStart(4)} ${String(fp).padStart(4)} ${(rec * 100).toFixed(1).padStart(7)}% ${(pre * 100).toFixed(1).padStart(9)}%`);
    }
    console.log(`\n(recall aqui e RELATIVO aos ${TPtot} acertos que o pipeline ja postava — 100% = nao perdeu nenhum)`);

    fs.writeFileSync(OUT, JSON.stringify({ curva, itens: res }, null, 2));
    console.log(`\n-> ${OUT}`);
})();
