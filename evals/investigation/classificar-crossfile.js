#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Anota cada golden do v002 com `crossFile`.
 *
 * O golden set tem tres campos — comment, severity, category — e nenhum diz se
 * o defeito atravessa arquivo. Sem isso nao da para responder "quanto do que a
 * gente perde e cross-file?", que e uma pergunta de produto: um revisor humano
 * tambem erra mais nesses, e e onde uma ferramenta deveria ganhar dele.
 *
 * O diff do PR vai junto DE PROPOSITO. Classificar pelo texto do comentario
 * sozinho e adivinhar: "o handler nao valida a entrada" nao diz se o handler e
 * a validacao estao no mesmo arquivo. Com o diff, a pergunta vira verificavel.
 *
 * NAO sobrescreve goldens.json. Grava ao lado, para o rotulo poder ser
 * conferido antes de virar parte do conjunto.
 *
 *   node classificar-crossfile.js [--set=light] [--rodadas=1] [--out=...]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const SET = arg('set', '');
const RODADAS = Number(arg('rodadas', '1'));
const OUT = arg('out', path.join(__dirname, 'results', 'goldens-crossfile.json'));
const PAR = Number(arg('par', '4'));
const MODEL = process.env.RECALL_MODEL || 'deepseek-v4.1-flash@fireworks';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

const esquema = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    crossFile: {
                        type: 'boolean',
                        description: 'true when seeing this defect requires reading more than one file.',
                    },
                    arquivos: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'The files a reviewer must read to see it. One entry when it is single-file.',
                    },
                    porque: { type: 'string', description: 'One sentence.' },
                },
                required: ['indice', 'crossFile', 'arquivos', 'porque'],
                additionalProperties: false,
            },
        },
    },
    required: ['itens'],
    additionalProperties: false,
};

const prompt = (goldens, diff) => `Below are defects a human reviewer found in this pull request, and the pull request's diff. For each defect, decide whether seeing it requires reading MORE THAN ONE file.

<Diff>
${String(diff || '').slice(0, 50000)}
</Diff>

<Defects>
${goldens.map((g, i) => `[${i}] ${g.comment}`).join('\n\n')}
</Defects>

CROSS-FILE means a reviewer cannot conclude the defect from one file alone. The
evidence is split: the root cause sits in one file and what makes it wrong sits
in another. Typical shapes:

  - a function's contract changed here, and a caller in another file still
    relies on the old one
  - a value is produced in one file and consumed in another under a different
    assumption (type, unit, nullability, ordering, encoding)
  - a guard, default or validation exists in one file and is missing on a second
    path that reaches the same sink
  - a name, key or constant is written in one file and read in another, and they
    disagree

SINGLE-FILE means everything needed to see it is in one file, even when that
file is long, even when the fix touches other files afterwards, and even when
the defect repeats in several files. The same mistake copy-pasted into five
files is FIVE single-file defects, not one cross-file defect — each is visible
on its own.

Judge what a reviewer must READ to be convinced, not where the change lands.
When the defect names a symbol, check the diff for where it is defined and where
it is used before deciding.

In "arquivos", list the files a reviewer must read. One file means crossFile is
false; two or more means it is true. Keep the two consistent.

Answer every index exactly once.`;

(async () => {
    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)} · ${RODADAS} rodada(s)`);
    const v2 = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'),
    );
    // diffs, do mesmo corpus que a revisao usa
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const vars = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (vars?.caseId)
                diffs[vars.caseId] = J(vars.changedFilesFull)
                    .map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || ''}`)
                    .join('\n\n');
        } catch {}
    }
    let alvo = v2.prs.filter((p) => (p.comments || []).length);
    if (SET) {
        const src = fs.readFileSync(path.join(__dirname, 'recall-tests.js'), 'utf8');
        const b = src.match(new RegExp(`${SET.toUpperCase()}_CASES\\s*=\\s*\\[([\\s\\S]*?)\\]`));
        const ids = new Set([...b[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
        alvo = alvo.filter((p) => ids.has(p.caseId));
    }
    console.log(`${alvo.length} PRs · ${alvo.reduce((n, p) => n + p.comments.length, 0)} goldens\n`);

    const saida = {};
    const um = async (pr) => {
        const gs = pr.comments;
        const rodadas = [];
        for (let r = 0; r < RODADAS; r++) {
            try {
                const out = await generateText({
                    model,
                    prompt: prompt(gs, diffs[pr.caseId]),
                    tools: {
                        registrar: tool({
                            description: 'Registra a classificacao. Chame exatamente uma vez.',
                            inputSchema: jsonSchema(esquema),
                            execute: async () => ({ output: 'ok' }),
                        }),
                    },
                    toolChoice: { type: 'tool', toolName: 'registrar' },
                });
                const call = (out.toolCalls || []).find((t) => (t.toolName ?? t.name) === 'registrar');
                rodadas.push(((call?.input ?? call?.args)?.itens) || []);
            } catch (e) {
                console.log(`  ${pr.caseId.slice(0, 42)} FALHOU: ${String(e.message || e).slice(0, 80)}`);
                rodadas.push([]);
            }
        }
        const itens = gs.map((g, i) => {
            const votos = rodadas.map((r) => r.find((x) => x.indice === i)).filter(Boolean);
            const sim = votos.filter((x) => x.crossFile).length;
            return {
                indice: i,
                comment: g.comment,
                category: g.category,
                severity: g.severity,
                crossFile: sim * 2 > votos.length,
                votos: `${sim}/${votos.length}`,
                arquivos: votos[0]?.arquivos || [],
                porque: votos[0]?.porque || '',
            };
        });
        saida[pr.caseId] = itens;
        const n = itens.filter((x) => x.crossFile).length;
        console.log(`  ${pr.caseId.slice(0, 46).padEnd(48)} ${gs.length} goldens -> ${n} cross-file`);
    };
    for (let b = 0; b < alvo.length; b += PAR) {
        await Promise.all(alvo.slice(b, b + PAR).map(um));
    }
    fs.writeFileSync(OUT, JSON.stringify({ modelo: MODEL, rodadas: RODADAS, saida }, null, 2));
    const todos = Object.values(saida).flat();
    console.log(`\n${todos.length} goldens · ${todos.filter((x) => x.crossFile).length} cross-file (${(100 * todos.filter((x) => x.crossFile).length / todos.length).toFixed(0)}%)`);
    console.log(`-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
