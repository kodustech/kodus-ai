/**
 * LLM judge for finder-recall / dedup: does a candidate finding match a golden
 * bug? Same matching algorithm and prompt as scripts/benchmark/scorecard.ts so
 * eval numbers stay comparable to the full benchmark. Runs locally (no droplet).
 *
 * MULTI-PROVIDER: the judge model is picked by JUDGE_MODEL (default
 * `claude-sonnet-4-6`) and routed to the right API by name prefix:
 *   claude    → Anthropic native   (API_/BYOK_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY)
 *   gpt / oN  → OpenAI chat         (BYOK_/API_OPEN_AI_API_KEY, OPENAI_API_KEY)
 *   gemini    → Google AI Studio    (BYOK_GOOGLE_API_KEY, API_GOOGLE_AI_API_KEY, GEMINI_API_KEY)
 * Keys resolve from env, then .env.local/.env, then ~/.kodus-dev/config.
 *
 * The judge is load-bearing (every recall/dedup number the gate depends on comes
 * from it), so JUDGE_MODEL is validated against Sonnet on a labeled agreement set
 * before being changed — see evals/investigation/agreement/.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Default judge: claude-haiku-4-5. Chosen over the old claude-sonnet-4-6 in the
// agreement study (evals/investigation/agreement/) — κ=0.93 vs Sonnet (highest of
// the candidates), recalls 95.7% of Sonnet's matches, shifts finder-recall mean
// by −0.3pp (≪ cross-PR noise, so targets.json floors stay valid), at ~1.6× the
// speed and a fraction of the cost. Set JUDGE_MODEL to override (e.g.
// gpt-5.4-mini for the cheapest/fastest option, κ=0.89).
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-haiku-4-5';
const MATCH_CONFIDENCE = 0.5;

// provider → ordered env names (first present wins). Mirrors tier0-models.js so
// the same local/CI secrets drive both the finder and the judge.
const PROVIDER_KEY_ENVS = {
    anthropic: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'],
    openai: ['API_OPEN_AI_API_KEY', 'BYOK_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    google: ['API_GOOGLE_AI_API_KEY', 'BYOK_GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

const JUDGE_PROMPT = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
{golden_comment}

Candidate Issue (from the tool's review):
{candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

// claude-* → anthropic, gpt-*/o1/o3/o4 → openai, gemini-* → google.
function providerFor(model) {
    const m = String(model || '');
    if (/^claude/i.test(m)) return 'anthropic';
    if (/^gemini/i.test(m)) return 'google';
    if (/^(gpt|o\d)/i.test(m)) return 'openai';
    throw new Error(`judge: cannot route unknown model '${model}' to a provider`);
}

function findKeyInText(text, envNames) {
    const values = new Map();
    const names = envNames.join('|');
    const re = new RegExp(`^\\s*(${names})\\s*=\\s*(.*)`);
    for (const line of String(text || '').split('\n')) {
        const m = line.match(re);
        if (!m) continue;
        const v = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
        if (v && !v.startsWith('op://')) values.set(m[1], v);
    }
    for (const name of envNames) {
        if (values.has(name)) return values.get(name);
    }
    return null;
}

// Resolve the API key for a given model's provider: process.env → .env files →
// ~/.kodus-dev/config, in env-name priority order.
function loadKeyForModel(model) {
    const envNames = PROVIDER_KEY_ENVS[providerFor(model)];

    for (const name of envNames) {
        if (process.env[name]) return process.env[name];
    }

    const files = [
        path.join(__dirname, '..', '..', '.env.local'),
        path.join(__dirname, '..', '..', '.env'),
        path.join(os.homedir(), '.kodus-dev', 'config'),
    ];
    for (const file of files) {
        try {
            const value = findKeyInText(fs.readFileSync(file, 'utf8'), envNames);
            if (value) return value;
        } catch {
            /* no such file */
        }
    }
    return null;
}

// Back-compat: callers do `const apiKey = loadJudgeKey()` then pass it to
// matchComment — resolve the key for the configured JUDGE_MODEL's provider.
function loadJudgeKey() {
    return loadKeyForModel(JUDGE_MODEL);
}

function isHardError(status) {
    return status === 400 || status === 401 || status === 403 || status === 404;
}

// One judge call. Routes by provider, returns the model's raw text response.
async function judgeCall(model, apiKey, prompt) {
    const provider = providerFor(model);
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90000);
        try {
            let url;
            let headers;
            let body;
            if (provider === 'anthropic') {
                url = 'https://api.anthropic.com/v1/messages';
                headers = {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                };
                body = {
                    model,
                    max_tokens: 256,
                    messages: [{ role: 'user', content: prompt }],
                };
            } else if (provider === 'openai') {
                url = 'https://api.openai.com/v1/chat/completions';
                headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
                // gpt-5.x uses max_completion_tokens; no temperature override
                // (some minis only accept the default), and reasoning eats
                // tokens so give it headroom.
                body = {
                    model,
                    max_completion_tokens: 2048,
                    messages: [{ role: 'user', content: prompt }],
                };
            } else {
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                headers = { 'content-type': 'application/json' };
                body = {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
                };
            }

            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            if (resp.ok) {
                const data = await resp.json();
                return extractText(provider, data);
            }
            const errBody = await resp.text();
            if (isHardError(resp.status)) {
                throw new Error(`judge HTTP ${resp.status} ${errBody.slice(0, 150)}`);
            }
            lastErr = new Error(`judge HTTP ${resp.status}`);
        } catch (e) {
            lastErr = e;
            if (/HTTP (400|401|403|404)/.test(e.message)) throw e;
        } finally {
            clearTimeout(timer);
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw new Error(`judge exhausted retries: ${lastErr && lastErr.message}`);
}

function extractText(provider, data) {
    if (provider === 'anthropic') {
        return (data.content || []).find((c) => c.type === 'text')?.text ?? '{}';
    }
    if (provider === 'openai') {
        return data.choices?.[0]?.message?.content ?? '{}';
    }
    // google
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('') || '{}';
}

function parseMatch(text) {
    // Now shared across Anthropic/OpenAI/Google, whose responses may wrap the
    // JSON in ```json fences or leading/trailing prose. Try the fence-stripped
    // whole response first, then fall back to the outermost {..} span.
    const raw = String(text || '')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
    const candidates = [raw];
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
    for (const json of candidates) {
        try {
            const p = JSON.parse(json);
            return !!p.match && (p.confidence ?? 0) >= MATCH_CONFIDENCE;
        } catch {
            /* try the next candidate */
        }
    }
    return false;
}

// Judge a (golden, candidate) pair with an explicit model — used by the
// agreement harness to compare candidate judges against the reference.
async function matchCommentWith(model, apiKey, golden, candidate) {
    const prompt = JUDGE_PROMPT.replace('{golden_comment}', golden).replace(
        '{candidate}',
        String(candidate || '').slice(0, 4000),
    );
    return parseMatch(await judgeCall(model, apiKey, prompt));
}

// Judge with the configured JUDGE_MODEL. Same signature as before so
// recall-assertion.js / dedup-eval.js don't change.
async function matchComment(apiKey, golden, candidate) {
    return matchCommentWith(JUDGE_MODEL, apiKey, golden, candidate);
}

module.exports = {
    JUDGE_MODEL,
    loadJudgeKey,
    loadKeyForModel,
    providerFor,
    matchComment,
    matchCommentWith,
};
