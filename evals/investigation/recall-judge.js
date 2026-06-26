/**
 * Sonnet judge for finder-recall: does a candidate finding match a golden bug?
 * Same matching algorithm as scripts/benchmark/scorecard.ts so eval numbers are
 * comparable to the full benchmark. Runs locally (no droplet) — needs an
 * Anthropic key (ANTHROPIC_API_KEY / BYOK_ANTHROPIC_API_KEY, or ~/.kodus-dev/config).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const JUDGE_MODEL = 'claude-sonnet-4-6';
const MATCH_CONFIDENCE = 0.5;

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

function loadJudgeKey() {
    const envKey = process.env.ANTHROPIC_API_KEY || process.env.BYOK_ANTHROPIC_API_KEY;
    if (envKey) return envKey;
    try {
        const text = fs.readFileSync(path.join(os.homedir(), '.kodus-dev', 'config'), 'utf8');
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*(ANTHROPIC_API_KEY|BYOK_ANTHROPIC_API_KEY)\s*=\s*(.*)/);
            if (m) {
                const v = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
                if (v && !v.startsWith('op://')) return v;
            }
        }
    } catch {
        /* no config file */
    }
    return null;
}

async function judgeCall(apiKey, prompt) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90000);
        try {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: JUDGE_MODEL,
                    max_tokens: 256,
                    messages: [{ role: 'user', content: prompt }],
                }),
                signal: ctrl.signal,
            });
            if (resp.ok) {
                const data = await resp.json();
                return (data.content || []).find((c) => c.type === 'text')?.text ?? '{}';
            }
            const body = await resp.text();
            if (resp.status === 401 || resp.status === 400) {
                throw new Error(`judge HTTP ${resp.status} ${body.slice(0, 150)}`);
            }
            lastErr = new Error(`judge HTTP ${resp.status}`);
        } catch (e) {
            lastErr = e;
            if (/HTTP (401|400)/.test(e.message)) throw e;
        } finally {
            clearTimeout(timer);
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw new Error(`judge exhausted retries: ${lastErr && lastErr.message}`);
}

async function matchComment(apiKey, golden, candidate) {
    const prompt = JUDGE_PROMPT.replace('{golden_comment}', golden).replace(
        '{candidate}',
        String(candidate || '').slice(0, 4000),
    );
    const text = await judgeCall(apiKey, prompt);
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try {
        const p = JSON.parse(json);
        return !!p.match && (p.confidence ?? 0) >= MATCH_CONFIDENCE;
    } catch {
        return false;
    }
}

module.exports = { loadJudgeKey, matchComment };
