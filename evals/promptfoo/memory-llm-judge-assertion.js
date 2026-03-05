/**
 * LLM semantic judge for memory proposals.
 * Scores whether proposed memory matches expected intent and expected memory text.
 */

const { detectToolCalls } = require('./memory-parse-output');

function toBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

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
            messages: [
                {
                    role: 'user',
                    content: prompt,
                },
            ],
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
        parsed = { score: 0.5, pass: false, reason: `Invalid judge JSON: ${content.slice(0, 300)}` };
    }

    const score = Number(parsed.score);
    const safeScore = Number.isFinite(score)
        ? Math.max(0, Math.min(1, score))
        : 0.5;

    return {
        skipped: false,
        score: safeScore,
        pass: parsed.pass === true || safeScore >= 0.7,
        reason: String(parsed.reason || 'No reason provided').slice(0, 800),
    };
}

function buildPrompt({ conversation, shouldCreateMemory, expectedTriggerType, expectedRule, output, calledMemoryTool, memoryPayload }) {
    return `You are evaluating if a model's memory decision is semantically correct.

Task:
- Decide if the output should be considered a correct memory decision.
- Memory must only be created for durable preferences that affect code suggestions/validation.
- Do not create memory for temporary reminders, one-off tasks, or non-code-impact context.

Expected:
- shouldCreateMemory: ${shouldCreateMemory}
- expectedTriggerType: ${expectedTriggerType || '(none)'}
- expectedMemoryRule: ${expectedRule || '(none)'}

Conversation:
${conversation}

Model output:
${output}

Detected memory tool call:
- calledMemoryTool: ${calledMemoryTool}
- memoryPayload: ${JSON.stringify(memoryPayload || {}, null, 2)}

Return ONLY JSON with this schema:
{
  "pass": boolean,
  "score": number,
  "reason": "short explanation"
}

Scoring guidance:
- 1.0: fully correct decision and memory meaning aligns with expected intent/rule
- 0.7-0.9: mostly correct with minor mismatch
- 0.3-0.6: major mismatch in intent, trigger type, or memory content
- 0.0-0.2: clearly wrong decision (memory when should not, or missing when should)
`;
}

module.exports = async (output, context) => {
    const shouldCreateMemory = toBoolean(context?.vars?.shouldCreateMemory);
    const expectedRule = context?.vars?.expectedRule || '';
    const expectedTriggerType = context?.vars?.expectedTriggerType || '';
    const conversation = context?.vars?.conversation || '';

    const toolCalls = detectToolCalls(output);
    const matchingCall = toolCalls.find(
        (call) => call.name === 'KODUS_CREATE_MEMORY',
    );

    const calledMemoryTool = Boolean(matchingCall);

    const prompt = buildPrompt({
        conversation,
        shouldCreateMemory,
        expectedTriggerType,
        expectedRule,
        output,
        calledMemoryTool,
        memoryPayload: matchingCall?.input,
    });

    try {
        const judged = await callJudge(prompt);

        if (judged.skipped) {
            return {
                pass: true,
                score: 1,
                reason: judged.reason,
            };
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
