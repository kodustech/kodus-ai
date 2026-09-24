/**
 * Rotula o pool PRE-reducer contra os goldens, uma vez, em cache.
 *
 * Por que isto existe: `question-battery.js` e `typesafe-filter.js` liam
 * `j.findings` — o conjunto que sai DEPOIS do reducer — e tiravam o rotulo de
 * acerto de `metadata.findingHit`, um array alinhado a esse indice. Ou seja,
 * mediam a capacidade de filtrar um conjunto ja filtrado. O experimento que
 * queremos e sobre o pool completo (`trace.preFilterCandidates`), e para esse
 * pool nao existe rotulo pronto: `findingHit` nao se aplica, os indices sao
 * outros e o pool e maior.
 *
 * Julgar custa uma chamada por (candidato x golden), entao o resultado vai para
 * disco e os dois scripts leem daqui. A chave inclui o conjunto de dumps, para
 * um dump novo nao herdar rotulo de outro.
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

function carregarPool(dumps) {
    const pool = {}, goldens = {}, vars = {};
    for (const d of dumps) {
        const dir = path.join(S, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const c = j.trace?.preFilterCandidates || [];
            if (c.length) (pool[j.caseId] ||= []).push(...c);
        }
    }
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) { goldens[v.caseId] = J(v.goldenComments); vars[v.caseId] = v; }
        } catch {}
    }
    return { pool, goldens, vars };
}

/** Devolve { [caseId]: number[][] } alinhado a ordem de preFilterCandidates:
 *  para cada candidato, os indices dos goldens com que ele casou. Lista vazia
 *  = falso positivo. */
async function rotular(dumps, { par = 8, force = false } = {}) {
    const cacheFile = path.join(__dirname, 'results', `labels-${dumps.join('+')}.json`);
    if (!force && fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
    const { pool, goldens } = carregarPool(dumps);
    const key = loadJudgeKey();
    if (!key) throw new Error('sem chave de judge');

    const labels = {};
    const ids = Object.keys(pool).filter((c) => goldens[c]?.length);
    for (const cid of ids) {
        const cands = pool[cid];
        const gs = goldens[cid];
        // QUAIS goldens, nao apenas "casou com algum". Com o booleano nao da
        // para contar goldens distintos por etapa do funil, e ai o colapso de
        // duplicata aparece como perda: cinco candidatos descrevendo o mesmo
        // golden contam cinco acertos, o reducer funde em um, e some quatro
        // "acerto" sem nenhum golden ter sido perdido.
        const marca = cands.map(() => []);
        const tarefas = [];
        for (let i = 0; i < cands.length; i++) {
            const txt = [cands[i].oneSentenceSummary, cands[i].suggestionContent]
                .filter(Boolean).join('\n').slice(0, 1800);
            gs.forEach((g, gi) => tarefas.push({ i, gi, comment: g.comment, txt }));
        }
        for (let b = 0; b < tarefas.length; b += par) {
            await Promise.all(tarefas.slice(b, b + par).map(async (t) => {
                try {
                    const v = await matchCommentDetailed(key, t.comment, t.txt);
                    if (v?.match && (v.confidence ?? 0) >= 0.5) marca[t.i].push(t.gi);
                } catch {}
            }));
        }
        labels[cid] = marca;
        const n = marca.filter((x) => x.length).length;
        console.log(`  ${cid.slice(0, 46).padEnd(48)} ${n}/${cands.length} candidatos casam com golden`);
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(labels, null, 2));
    console.log(`-> ${cacheFile}`);
    return labels;
}

module.exports = { rotular, carregarPool };

if (require.main === module) {
    const arg = (n, d) => {
        const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
        return h ? h.slice(n.length + 3) : d;
    };
    require('./eval-tracing').registerTracing('label-candidates');
    rotular(arg('dumps', 'ds16b').split(','), {
        par: Number(arg('par', '8')),
        force: process.argv.includes('--force'),
    }).catch((e) => { console.error(e); process.exit(1); });
}
