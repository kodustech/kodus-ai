// The configurations the formatter runs under in production, each as the stage
// passes it (agent-review.stage.ts, formatSuggestionContent): the team's
// language_config as `languageResultPrompt`, and its writing guidelines when
// they are a real edit (presets and shipped defaults are not passed,
// libs/common/utils/writing-guidelines.ts).
//
// Teams per language_config, active parameters, BigQuery mirror 2026-10-15:
// en-US 700, pt-BR 148, zh-CN 28, es-ES 18, then under 20 each. Writing
// guidelines: 280 teams store one; most are copies of a shipped preset, and
// the real edits ask for shorter comments or another language. The guideline
// below is written for the eval, after that kind of edit.
const VARIANTS = {
    'en-US': {
        checks: 'in English (700 teams, and the default)',
        languageResultPrompt: 'en-US',
        want: { language: 'en', maxSentences: 2 },
    },
    'pt-BR': {
        checks: 'in Brazilian Portuguese (148 teams)',
        languageResultPrompt: 'pt-BR',
        want: { language: 'pt', maxSentences: 2 },
    },
    'zh-CN': {
        checks: 'in Simplified Chinese (28 teams)',
        languageResultPrompt: 'zh-CN',
        want: { language: 'zh', maxSentences: 2 },
    },
    'es-ES': {
        checks: 'in Spanish (18 teams)',
        languageResultPrompt: 'es-ES',
        want: { language: 'es', maxSentences: 2 },
    },
    'en-US-one-sentence': {
        checks: 'in English with a team guideline asking for one sentence',
        languageResultPrompt: 'en-US',
        customWritingGuidelines: 'Keep every comment to a single sentence. Cut any word that does not change what the developer has to do.',
        want: { language: 'en', maxSentences: 1 },
    },
};

module.exports = { VARIANTS };
