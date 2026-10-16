// The shapes a recorded run end is replayed in. `as-sent` is the model's own.
// The rest reproduce what production lost, on a recorded run end, each from the
// counts and samples in #2112 (CloudWatch `[DONE-TOOL]`, 8 days, and Langfuse
// `submitResult` inputs of 193 failing reviews):
//
//   apply(payload) → what the runner stores as the artifact: an object, or the
//                    raw string when the model's JSON does not parse
//   expect(item, i) → what the shape leaves of the i-th finding as the model
//                    wrote it: 'keep', 'drop' (the shape made it unpostable), or
//                    'either' (lost to the shape's own broken JSON; not counted).
//                    A finding that was never postable is expected dropped
//                    whatever the shape (run.js)
//   prose          → the shape reaches the prose recovery call (the model)
//   checks         → the case's sentence on the quality panel
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const each = (fn) => (p) => ({ ...p, suggestions: p.suggestions.map(fn) });
const keep = () => 'keep';
const firstDropped = (s, i) => (i === 0 ? 'drop' : 'keep');

// A finding written out as prose, the way a reviewer lists it in its analysis.
const asProse = (s, i) =>
    `${i + 1}. In \`${s.relevantFile}\`, lines ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? s.relevantLinesStart ?? '?'} (${s.severity || 'medium'}): ${s.suggestionContent}`;

// The JSON a model writes when it does not escape a quote inside code: a raw
// `"` in the second finding's code (or, without code, its description), so the
// string breaks there. Throws when nothing broke: a case that still parses
// would pass without measuring the break.
function brokenAtSecond(suggestions) {
    const json = JSON.stringify(suggestions);
    const second = JSON.stringify(suggestions[1]);
    const field = ['improvedCode', 'existingCode', 'suggestionContent'].find((k) => typeof suggestions[1]?.[k] === 'string');
    const broken = field ? second.replace(`"${field}":"`, `"${field}":"x = "y" + `) : second;
    if (broken === second) throw new Error('suggestions-broken-json: the second finding has no string field to break');
    return json.replace(second, broken);
}

const SHAPES = {
    'as-sent': {
        checks: (model, caseId) => `Keeps every postable finding ${model} wrote on ${caseId} as it sent them, and adds none to a run that wrote none`,
        apply: (p) => p,
        expect: keep,
    },
    'only-reasoning-prose': {
        checks: () => 'Recovers findings written as prose in reasoning with no suggestions key (343 reviews in 8 days, #2112)',
        apply: (p) => ({ reasoning: `${p.reasoning || 'Review of the changed code.'}\n\nFindings:\n${p.suggestions.map(asProse).join('\n')}` }),
        expect: keep,
        prose: true,
    },
    'suggestions-as-json-string': {
        checks: () => 'Keeps the findings when suggestions arrives as a JSON string (90 reviews in 8 days, #2112)',
        apply: (p) => ({ ...p, suggestions: JSON.stringify(p.suggestions) }),
        expect: keep,
    },
    'suggestions-broken-json': {
        checks: () => 'Keeps the findings before an unescaped quote breaks the suggestions JSON string (#2112)',
        apply: (p) => ({ ...p, suggestions: brokenAtSecond(p.suggestions) }),
        expect: (s, i) => (i === 0 ? 'keep' : 'either'),
    },
    'array-then-stray-brace': {
        checks: () => 'Keeps a valid suggestions array followed by a stray closing brace (#2112)',
        apply: (p) => ({ ...p, suggestions: `${JSON.stringify(p.suggestions)}}` }),
        expect: keep,
    },
    'string-items-mixed-in': {
        checks: () => 'Keeps the object findings when the array also holds plain-string items (22 reviews, #2112)',
        apply: (p) => ({ ...p, suggestions: [...p.suggestions, 'see the comment above', 'also check the tests'] }),
        expect: keep,
    },
    'text-node-split': {
        checks: () => 'Keeps the postable part of a finding split into {"$text"} items, as MiniMax-M3 sends them (#2112)',
        apply: (p) => ({
            ...p,
            suggestions: p.suggestions.flatMap((s, i) =>
                i === 0
                    ? [
                          { relevantFile: s.relevantFile, suggestionContent: s.suggestionContent, severity: s.severity },
                          { $text: String(s.relevantLinesStart ?? '') },
                          { $text: String(s.improvedCode ?? '') },
                      ]
                    : [s],
            ),
        }),
        expect: keep,
    },
    'improved-code-missing': {
        checks: () => 'Keeps a finding with no improvedCode (122 findings in 8 days, #2112)',
        apply: each(({ improvedCode, ...s }) => s),
        expect: keep,
    },
    'existing-code-missing': {
        checks: () => 'Keeps a finding with no existingCode (49 findings in 8 days, #2112)',
        apply: each(({ existingCode, ...s }) => s),
        expect: keep,
    },
    'improved-code-null': {
        checks: () => 'Keeps a finding whose improvedCode is null (#2112)',
        apply: each((s) => ({ ...s, improvedCode: null })),
        expect: keep,
    },
    'rule-uuid-null': {
        checks: () => 'Keeps a finding whose ruleUuid is null (76 findings in 8 days, #2112)',
        apply: each((s) => ({ ...s, ruleUuid: null })),
        expect: keep,
    },
    'revises-id-null': {
        checks: () => 'Keeps a finding whose revisesSuggestionId is null (10 findings in 8 days, #2112)',
        apply: each((s) => ({ ...s, revisesSuggestionId: null })),
        expect: keep,
    },
    'label-lines-confidence-null': {
        checks: () => 'Keeps a finding whose label, relevantLinesEnd or confidence is null (#2112)',
        apply: each((s) => ({ ...s, label: null, relevantLinesEnd: null, confidence: null })),
        expect: keep,
    },
    'severity-capitalized': {
        checks: () => 'Keeps a finding whose severity is capitalized, such as "High" (#2112)',
        apply: each((s) => ({ ...s, severity: cap(s.severity || 'high') })),
        expect: keep,
    },
    'one-without-file': {
        checks: () => 'Drops a finding with no relevantFile and keeps the rest (control)',
        apply: (p) => ({ ...p, suggestions: p.suggestions.map((s, i) => (i === 0 ? { ...s, relevantFile: '' } : s)) }),
        expect: firstDropped,
    },
    'one-without-description': {
        checks: () => 'Drops a finding with no description and keeps the rest (control)',
        apply: (p) => ({ ...p, suggestions: p.suggestions.map((s, i) => (i === 0 ? { ...s, suggestionContent: '' } : s)) }),
        expect: firstDropped,
    },
};

module.exports = { SHAPES };
