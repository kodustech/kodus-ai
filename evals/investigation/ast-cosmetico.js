/**
 * #1821: o patch do verify muda so comentario/espaco ou so texto literal?
 * Compara a sequencia de tokens (folhas da arvore do tree-sitter) do arquivo antes
 * e depois do patch: sem comentarios, e depois tambem com cada string trocada por
 * um marcador. Linguagem sem gramatica -> null (a checagem nao se aplica).
 * Parser instalado fora do repo: TREE_SITTER_DIR=<pasta com web-tree-sitter e tree-sitter-wasms>.
 */
const path = require('path');
const DIR = process.env.TREE_SITTER_DIR;
const GRAMATICA = { ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', rb: 'ruby', go: 'go', java: 'java', py: 'python' };
let Parser, cache = {};
async function linguagem(arquivo) {
    const g = GRAMATICA[path.extname(arquivo).slice(1).toLowerCase()];
    if (!g || !DIR) return null;
    if (!Parser) { Parser = require(path.join(DIR, 'node_modules/web-tree-sitter')); await Parser.init(); }
    if (!cache[g]) cache[g] = await Parser.Language.load(path.join(DIR, 'node_modules/tree-sitter-wasms/out', `tree-sitter-${g}.wasm`));
    return cache[g];
}
function tokens(raiz, semString) {
    const out = [];
    const anda = (n) => {
        if (/comment/.test(n.type)) return;
        if (semString && /string|template_literal|heredoc/.test(n.type)) { out.push('<STR>'); return; }
        if (n.childCount === 0) { out.push(n.text); return; }
        for (let i = 0; i < n.childCount; i++) anda(n.child(i));
    };
    anda(raiz);
    return out.join('\u0001');
}
async function cosmetico(arquivo, antes, depois) {
    const lang = await linguagem(arquivo);
    if (!lang) return null;
    const p = new Parser(); p.setLanguage(lang);
    const a = p.parse(antes).rootNode, d = p.parse(depois).rootNode;
    return { soComentario: tokens(a, false) === tokens(d, false), soTexto: tokens(a, true) === tokens(d, true) };
}
module.exports = { cosmetico };
