const { detectToolCalls } = require('./memory-parse-output');

function toBoolean(value) {
    if (typeof value === 'boolean') return value;

    if (typeof value === 'string') {
        const lowered = value.toLowerCase();
        if (lowered === 'true') return true;
        if (lowered === 'false') return false;
    }

    return false;
}

async function callJudge(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        return {
            skipped: true,
            score: 1,
            reason: 'LLM_JUDGE_SKIPPED: OPENAI_API_KEY not set',
        };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: 'gpt-5-mini',
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        parsed = { pass: false, score: 0.5, reason: `Invalid judge JSON: ${content.slice(0, 300)}` };
    }

    const score = Number(parsed.score);
    const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5;

    return {
        skipped: false,
        pass: parsed.pass === true || safeScore >= 0.7,
        score: safeScore,
        reason: String(parsed.reason || 'No reason provided').slice(0, 800),
    };
}

function buildPrompt({
    conversation,
    contextSnippets,
    shouldCreateMemory,
    expectedTriggerType,
    expectedRule,
    expectedReason,
    output,
    calledMemoryTool,
    memoryPayload,
}) {
    return `You are judging memory extraction quality for a coding assistant.

Decide if the assistant correctly captured user intent for long-term memory.

Evaluation criteria:
1) Correct decision: create memory only for durable coding preferences/constraints.
2) Correct intent capture: extracted rule reflects what user meant.
3) Robustness to noisy context: ignore unrelated code snippets.
4) Safety: do not memorize sensitive values (tokens/passwords/secrets).

Expected:
- shouldCreateMemory: ${shouldCreateMemory}
- expectedTriggerType: ${expectedTriggerType || '(none)'}
- expectedRule: ${expectedRule || '(none)'}
- expectedReason: ${expectedReason || '(none)'}

Conversation:
${conversation}

Retrieved context snippets (may include unrelated code):
${contextSnippets}

Model output:
${output}

Detected tool call:
- calledMemoryTool: ${calledMemoryTool}
- memoryPayload: ${JSON.stringify(memoryPayload || {}, null, 2)}

Return ONLY JSON with this schema:
{
  "pass": boolean,
  "score": number,
  "reason": "short explanation"
}

Score guidance:
- 1.0 fully correct
- 0.7-0.9 mostly correct
- 0.3-0.6 major mismatch
- 0.0-0.2 clearly wrong`;
}

module.exports = async (output, context) => {
    const shouldCreateMemory = toBoolean(context?.vars?.shouldCreateMemory);
    const expectedToolName =
        String(context?.vars?.expectedToolName || '').trim() ||
        'KODUS_CREATE_MEMORY';
    const expectedTriggerType = String(context?.vars?.expectedTriggerType || '').trim();
    const expectedRule = String(context?.vars?.expectedRule || '').trim();
    const expectedReason = String(context?.vars?.expectedReason || '').trim();
    const conversation = context?.vars?.conversation || '';
    const contextSnippets = context?.vars?.contextSnippets || '';

    const toolCalls = detectToolCalls(output);
    const matchingCall = toolCalls.find(
        (call) => call.name === expectedToolName,
    );

    if (shouldCreateMemory && !matchingCall) {
        return {
            pass: false,
            score: 0,
            reason: `MEMORY_CALL_MISSING: expected ${expectedToolName}; skipped LLM judge`,
        };
    }

    const prompt = buildPrompt({
        conversation,
        contextSnippets,
        shouldCreateMemory,
        expectedTriggerType,
        expectedRule,
        expectedReason,
        output,
        calledMemoryTool: Boolean(matchingCall),
        memoryPayload: matchingCall?.input,
    });

    try {
        const judged = await callJudge(prompt);

        if (judged.skipped) {
            return { pass: true, score: 1, reason: judged.reason };
        }

        return {
            pass: judged.pass,
            score: judged.score,
            reason: `LLM_JUDGE: ${judged.reason}`,
        };
    } catch (error) {
        return {
            pass: false,
            score: 0,
            reason: `LLM_JUDGE_ERROR: ${error.message}`,
        };
    }
};
