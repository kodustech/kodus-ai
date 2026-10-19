// What a formatted suggestion owes the reader, checked without a model. Each
// check is a rule the formatter prompt states (format-prompt.ts) or the team's
// configuration sets:
//   labels      no WHAT/WHY/HOW (or numbered "1. WHAT:") label left
//   identifiers at least half of the code names the finding cited are still in
//               front of the reader: in the text, or in the title shown above it
//   no-code     no fenced code block (the fix is shown separately)
//   title       the first sentence does not repeat the title
//   length      at most `maxSentences` sentences
//   words       at most `maxWords` words, when the variant sets it (#2157)
//   line-refs   no line number: the comment already sits on the lines, and a
//               number elsewhere points at code the reader cannot see (#2157)
//   title-cut   the title shown was not cut by code: one over the ceiling is
//               the formatter's to rewrite (#2157)
//   language    written in the configured language
// The checks read the text a reviewer sees; they do not judge whether the
// claim is still the same one.
const LABEL = /(^|[^\p{L}])(\d+\.\s*)?[*_]{0,2}\s*(WHAT|WHY|HOW)\s*[*_]{0,2}\s*:/iu;
const FENCE = /```/;

// Code names the finding cites: a `backticked` name, or a word a reader can only
// mean as code (snake_case, camelCase or PascalCase compounds, dotted names,
// calls). Expressions (`count >= limit`) are not names and are left out.
const NAME = /(?<![\w$.])(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[a-z_$][\w$]*[A-Z_][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*)(?:\(\))?(?![\w$])/g;
function identifiers(text) {
    const out = new Set();
    const s = String(text || '');
    // A backticked name or path; an expression (`!list.includes(x)`) is not one.
    const NAME_OR_PATH = /^(?:[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*(?:\(\))?|[\w.-]+(?:\/[\w.-]+)+)$/;
    for (const m of s.matchAll(/`([^`\n]{3,80})`/g)) if (NAME_OR_PATH.test(m[1].trim())) out.add(m[1].trim());
    for (const m of s.replace(/`[^`\n]*`/g, ' ').matchAll(NAME)) out.add(m[0]);
    // Not names: e.g./i.e., and example domains or addresses.
    return [...out].filter((x) => x.length >= 3 && !/^(e\.g|i\.e|etc)\.?$/i.test(x) && !/\.(com|org|net|io|dev)$/i.test(x));
}

// Prose without code, links or file names, for counting sentences and words.
const prose = (text) =>
    String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' x ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[\w./-]+\.(ts|tsx|js|jsx|py|rb|go|java|rs|kt|cs|php|json|ya?ml)\b/g, ' x ');

function sentences(text) {
    return prose(text)
        .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{Lo}"'(])|(?<=[。！？])/u)
        .map((x) => x.trim())
        .filter((x) => /[\p{L}\p{N}]/u.test(x));
}

const STOP = {
    en: ['the', 'is', 'are', 'and', 'to', 'of', 'this', 'that', 'when', 'which', 'with', 'it', 'be', 'not', 'so', 'instead'],
    pt: ['não', 'é', 'são', 'uma', 'um', 'que', 'com', 'quando', 'isso', 'está', 'pelo', 'pela', 'também', 'ao', 'os', 'as', 'do', 'da'],
    es: ['no', 'es', 'son', 'una', 'un', 'que', 'con', 'cuando', 'esto', 'está', 'el', 'los', 'las', 'del', 'también', 'al', 'lo'],
};

// The language a text is written in: by script for CJK, by function words for
// the Latin-script languages the eval configures. 'unknown' when too short to tell.
function languageOf(text) {
    const p = prose(text);
    const letters = (p.match(/\p{L}/gu) || []).length || 1;
    const share = (re) => (p.match(re) || []).length / letters;
    if (share(/[぀-ヿ]/g) > 0.05) return 'ja';
    if (share(/[가-힯]/g) > 0.2) return 'ko';
    if (share(/\p{Script=Han}/gu) > 0.2) return 'zh';
    if (share(/\p{Script=Cyrillic}/gu) > 0.3) return 'ru';
    const words = p.toLowerCase().match(/\p{L}+/gu) || [];
    const score = Object.fromEntries(Object.entries(STOP).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length]));
    score.pt += (p.match(/ção|ções|ã|õ/g) || []).length;
    score.es += (p.match(/ción|ciones|ñ/g) || []).length;
    const [best, hits] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    return hits >= 2 ? best : 'unknown';
}

// "line 31", "lines 20-30", "linha 12", "línea 4", "第 3 行", "assignTicket.ts:7-19".
const LINE_REF = /\b(?:lines?|linhas?|l[ií]neas?)\s+\d+|第\s*\d+\s*行|\.[a-z]{1,5}:\d+/iu;

const words4 = (s) => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) || []));

/**
 * The checks one formatted suggestion fails.
 * @param original  the finding as the finder wrote it ({ title, suggestionContent })
 * @param out       the text the formatter shipped
 * @param want      { language: 'en' | 'pt' | 'es' | 'zh', maxSentences, maxWords?, only? }
 *                  `only` limits the result to the named checks
 * @param title     the title the comment shows, when the caller has it
 */
function failedChecks(original, out, want, title) {
    const all = allFailed(original, out, want, title);
    return want.only ? all.filter((c) => want.only.includes(c.replace(/ \(.*/, ''))) : all;
}

function allFailed(original, out, want, shownTitle) {
    const text = String(out || '');
    if (!text.trim()) return ['empty'];
    const failed = [];
    if (LABEL.test(text)) failed.push('labels');
    // The title the reader sees: the shipped one when the caller has it.
    const readerTitle = shownTitle ?? original.title;
    const cited = identifiers(original.suggestionContent);
    const shown = `${readerTitle || ''}\n${text}`;
    if (cited.length && cited.filter((x) => shown.includes(x)).length < cited.length / 2) failed.push('identifiers');
    if (FENCE.test(text)) failed.push('no-code');
    const title = words4(readerTitle);
    const first = words4(sentences(text)[0]);
    if (title.size >= 3 && [...title].filter((w) => first.has(w)).length / title.size >= 0.8) failed.push('title');
    if (sentences(text).length > want.maxSentences) failed.push('length');
    if (want.maxWords && (prose(text).match(/[\p{L}\p{N}_]+/gu) || []).length > want.maxWords) failed.push('words');
    if (LINE_REF.test(text)) failed.push('line-refs');
    if (shownTitle && shownTitle.endsWith('…') && !String(original.title || '').trim().endsWith('…')) failed.push('title-cut');
    const lang = languageOf(text);
    // 'unknown' is a text too short to tell, not a wrong language: only a
    // competing language fails.
    if (!['unknown', want.language].includes(lang)) failed.push(`language (${lang})`);
    return failed;
}

module.exports = { failedChecks, identifiers, sentences, languageOf, LABEL, LINE_REF };
