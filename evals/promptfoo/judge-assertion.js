/**
 * Custom LLM judge assertion - calls Sonnet + GPT APIs directly.
 * Bypasses promptfoo's llm-rubric which only works reliably with GPT.
 */

// Call Anthropic Claude Sonnet API
async function callSonnet(prompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8192,
            temperature: 0,
        }),
        signal: AbortSignal.timeout(180000),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = await resp.json();
    return data.content?.[0]?.text || '';
}

// Call OpenAI GPT API
async function callGPT(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: 'gpt-5.2',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
        }),
        signal: AbortSignal.timeout(180000),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`OpenAI API ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
}

// Extract coverage_score, validity_score, final_score from judge response.
// Looks for lines like "coverage_score = 2/2 = 1.0" and takes the value after the last "=".
function extractScores(text) {
    const lines = text.split('\n');
    let coverage = null, validity = null, final = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.includes('=')) continue;

        const lower = trimmed.toLowerCase();
        const parts = trimmed.split('=');
        const lastPart = parts[parts.length - 1].trim();
        const match = lastPart.match(/^([\d.]+)/);
        if (!match) continue;
        const value = Math.min(parseFloat(match[1]), 1.0);
        if (isNaN(value)) continue;

        if (/^coverage[_ ]?score/i.test(lower)) {
            coverage = value;
        } else if (/^validity[_ ]?score/i.test(lower)) {
            validity = value;
        } else if (/^final[_ ]?score/i.test(lower)) {
            final = value;
        }
    }

    return { coverage, validity, final };
}

function buildJudgePrompt(referenceSuggestions, modelOutput, refCount) {
    const divider = refCount === 0 ? '1' : 'total_reference_bugs';

    return `You are a harsh, skeptical judge evaluating code review suggestions. Your job is to REJECT anything that is not a clear, provable issue — whether it is a bug, a performance problem, or a security vulnerability.

## Reference issues (ground truth):
${referenceSuggestions}

## Model output to evaluate:
${modelOutput}

## Step 1: Evaluate EACH suggestion individually

For EVERY suggestion the model made, you MUST write this exact structure:

### Suggestion N: [one-line summary]
- Category: BUG | PERFORMANCE | SECURITY
- Concrete scenario: [specific scenario that proves the issue — see criteria below]
- Expected behavior: [what should happen]
- Actual behavior: [what actually happens due to the issue]
- Verdict: VALID or INVALID
- Reason: [why]

A suggestion is VALID ONLY if you can demonstrate a concrete scenario that proves the issue exists:
- **Bug**: Provide a specific input that triggers wrong behavior — what the output should be vs. what it actually is.
- **Performance**: Describe a realistic workload where the code causes measurable degradation (e.g., O(n²) with large dataset, unbounded memory growth, blocking I/O on hot path, N+1 queries). The degradation must be demonstrable with concrete numbers or data sizes.
- **Security**: Describe a realistic attack vector that an external user or attacker could exploit (e.g., path traversal, injection, timing attack, SSRF) and the concrete consequence (data leak, unauthorized access, etc.).

If you cannot construct a specific, concrete scenario for any of these categories, the suggestion is INVALID.

### What counts as INVALID (reject aggressively):
- You cannot demonstrate a concrete scenario proving the issue
- The issue is about code style, naming, or formatting
- The suggestion is about missing validation for inputs the API is not designed to handle
- The suggestion describes a "best practice" violation without a concrete negative consequence
- The scenario requires absurd or impossible inputs that would never occur in practice (note: for security issues, realistic attack vectors from external users ARE valid — only reject truly impossible scenarios)
- The description is vague ("could cause issues", "might fail", "potential problem")
- It is defensive programming ("missing null check") without proving null is reachable through normal code paths
- It is about missing features or unused options
- It is about error handling that "could be better" without showing a concrete failure
- It is about resource leaks that only matter in theory (e.g., "timer not cleared" but the object is garbage collected anyway)
- It duplicates another suggestion about the same underlying issue

When in doubt, mark INVALID. A suggestion must pass a high bar to be VALID.

## Step 2: Coverage

Which reference issues were found by at least one VALID suggestion?
- List each reference issue and whether it was FOUND or MISSED
- coverage_score = found_count / ${divider}

## Step 3: Validity

- Count VALID suggestions vs total suggestions
- validity_score = valid_count / total_suggestions
- If the model made 0 suggestions: validity_score = 0.0

## Step 4: Final Score

score = (coverage_score * 0.5) + (validity_score * 0.5)

You MUST end your response with EXACTLY these three lines (no other text after them):
coverage_score = X/Y = Z
validity_score = A/B = W
final_score = Z * 0.5 + W * 0.5 = SCORE`;
}

module.exports = async (output, context) => {
    const referenceSuggestions = context.vars.referenceCodeSuggestions || '[]';
    const refBugs = JSON.parse(context.vars.referenceBugs || '[]');

    const evalPrompt = buildJudgePrompt(referenceSuggestions, output, refBugs.length);

    // Call both judges in parallel
    const [sonnetResult, gptResult] = await Promise.allSettled([
        callSonnet(evalPrompt),
        callGPT(evalPrompt),
    ]);

    let sonnetScores = { coverage: null, validity: null, final: null };
    let gptScores = { coverage: null, validity: null, final: null };
    let sonnetReason = '';
    let gptReason = '';

    if (sonnetResult.status === 'fulfilled') {
        sonnetReason = sonnetResult.value;
        sonnetScores = extractScores(sonnetReason);
    } else {
        sonnetReason = 'JUDGE_ERROR: ' + sonnetResult.reason.message;
    }

    if (gptResult.status === 'fulfilled') {
        gptReason = gptResult.value;
        gptScores = extractScores(gptReason);
    } else {
        gptReason = 'JUDGE_ERROR: ' + gptResult.reason.message;
    }

    // Combined score — average only available judges (skip missing ones)
    const sScore = sonnetScores.final !== null && !isNaN(sonnetScores.final) ? sonnetScores.final : null;
    const gScore = gptScores.final !== null && !isNaN(gptScores.final) ? gptScores.final : null;
    const availableScores = [sScore, gScore].filter(s => s !== null);
    const combined = availableScores.length > 0
        ? availableScores.reduce((a, b) => a + b, 0) / availableScores.length
        : 0;

    // Build structured reason for analyze-results.js
    const fmt = v => v !== null && !isNaN(v) ? v.toFixed(4) : 'null';
    const metrics = `JUDGE_METRICS sonnet_score=${fmt(sonnetScores.final)} gpt_score=${fmt(gptScores.final)} sonnet_coverage=${fmt(sonnetScores.coverage)} sonnet_validity=${fmt(sonnetScores.validity)} gpt_coverage=${fmt(gptScores.coverage)} gpt_validity=${fmt(gptScores.validity)}`;

    const reason = `${metrics}\n\n--- SONNET JUDGE ---\n${sonnetReason.slice(-1000)}\n\n--- GPT JUDGE ---\n${gptReason.slice(-1000)}`;

    return {
        pass: combined >= 0.7,
        score: combined,
        reason,
    };
};
