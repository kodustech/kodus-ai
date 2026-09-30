#!/usr/bin/env node
/**
 * Converte a saida de `codex review` (codex-review-bench.js) em pool, para o
 * judge (matriz-prefilter.js) pontuar igual as outras rodadas. Cada comentario
 * "- [P<n>] titulo — <caminho>:<ini>-<fim>" + corpo vira um candidato; a
 * prioridade vira severidade (P0 critical, P1 high, P2 medium, P3 low).
 *
 *   node codex-para-pool.js --in=<dir da saida> --out=<nome do pool>
 */
const fs = require('fs');
const path = require('path');
const arg = (n) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const IN = arg('in');
const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const OUT = path.join(S, arg('out'));
fs.mkdirSync(OUT, { recursive: true });
const SEV = ['critical', 'high', 'medium', 'low'];

for (const f of fs.readdirSync(IN).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf8'));
    const texto = String(j.stdout || '');
    // "Full review comments:" com varios, "Review comment:" com um so.
    const m0 = /^(Full review comments|Review comment):/m.exec(texto);
    const corpo = m0 ? texto.slice(m0.index) : '';
    const cands = [];
    const re = /^- \[P(\d)\] (.+?) — (.+?):(\d+)(?:-(\d+))?\n([\s\S]*?)(?=\n- \[P\d\] |\s*$)/gm;
    for (const m of corpo.matchAll(re)) {
        // caminho absoluto do worktree -> caminho relativo ao repo
        const rel = m[3].replace(/^.*?\/\.worktrees\/[^/]+\//, '');
        cands.push({
            producedBy: 'codex-review',
            relevantFile: rel,
            relevantLinesStart: Number(m[4]),
            relevantLinesEnd: Number(m[5] || m[4]),
            oneSentenceSummary: m[2].trim(),
            suggestionContent: m[6].replace(/\s+/g, ' ').trim(),
            severity: SEV[Number(m[1])] || 'medium',
            confidence: 5,
        });
    }
    fs.writeFileSync(
        path.join(OUT, `${j.caseId}.raw.txt`),
        JSON.stringify({ caseId: j.caseId, reasoning: '', findings: [], trace: { preFilterCandidates: cands, recallPasses: [], codexExit: j.code, codexMs: j.ms } }),
    );
    console.log(`  ${j.caseId.slice(0, 50).padEnd(52)} ${cands.length} comentarios`);
}
