#!/usr/bin/env node
/**
 * End-to-end eval for the safeguard agent verification pipeline.
 * Supports multiple LLM providers: Gemini, Claude, GPT, GLM, Kimi.
 *
 * Usage:
 *   node run-agent-eval.js [--model=MODEL] [--dry-run] [--limit=N]
 *
 * Models:
 *   gemini-2.5-flash (default)
 *   claude-sonnet-4-5
 *   gpt-5.2
 *   glm-5
 *   kimi-k2.5
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { materializeFixture, cleanupFixture } = require('./materialize-fixture');

// ── Load API keys from .env ──
const ENV = (() => {
    try {
        const envFile = fs.readFileSync(path.join(__dirname, '../../.env'), 'utf-8');
        const vars = {};
        for (const line of envFile.split('\n')) {
            const match = line.match(/^([A-Z_]+)=(.+)/);
            if (match) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
        }
        return vars;
    } catch { return {}; }
})();

const KEYS = {
    google: ENV.API_GOOGLE_AI_API_KEY || process.env.API_GOOGLE_AI_API_KEY,
    openai: ENV.API_OPEN_AI_API_KEY || process.env.API_OPEN_AI_API_KEY,
    anthropic: ENV.API_ANTHROPIC_API_KEY || process.env.API_ANTHROPIC_API_KEY,
    openrouter: ENV.API_OPENROUTER_KEY || process.env.API_OPENROUTER_KEY,
    cerebras: ENV.API_CEREBRAS_API_KEY || process.env.API_CEREBRAS_API_KEY,
};

// ── Model configs ──
const MODEL_CONFIGS = {
    'gemini-2.5-flash': {
        provider: 'google',
        modelId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
    },
    'gemini-2.5-pro': {
        provider: 'google',
        modelId: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
    },
    'gemini-3-flash': {
        provider: 'google',
        modelId: 'gemini-3-flash-preview',
        displayName: 'Gemini 3.0 Flash',
    },
    'gemini-3.1-flash-lite': {
        provider: 'google',
        modelId: 'gemini-3.1-flash-lite-preview',
        displayName: 'Gemini 3.1 Flash Lite',
    },
    'claude-sonnet-4-5': {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5-20250929',
        displayName: 'Claude Sonnet 4.5',
    },
    'gpt-5.2': {
        provider: 'openai',
        modelId: 'gpt-5.2',
        displayName: 'GPT 5.2',
    },
    'glm-5': {
        provider: 'openrouter',
        modelId: 'z-ai/glm-5',
        displayName: 'GLM 5',
        noJsonMode: true,
    },
    'kimi-k2.5': {
        provider: 'openrouter',
        modelId: 'moonshotai/kimi-k2.5',
        displayName: 'Kimi K2.5',
    },
    'gpt-oss': {
        provider: 'cerebras',
        modelId: 'gpt-oss-120b',
        displayName: 'GPT OSS 120B (Cerebras)',
        baseUrl: 'https://api.cerebras.ai/v1',
    },
};

// ── CLI args ──
const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const modelArg = process.argv.find(a => a.startsWith('--model='));
const modelKey = modelArg ? modelArg.split('=')[1] : 'gemini-2.5-flash';

const MODEL = MODEL_CONFIGS[modelKey];
if (!MODEL) {
    console.error(`Unknown model: ${modelKey}. Available: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
    process.exit(1);
}

const API_KEY = KEYS[MODEL.provider];
if (!API_KEY) {
    console.error(`No API key for provider "${MODEL.provider}". Check .env file.`);
    process.exit(1);
}

// ── Triage logic ──
const STRUCTURAL_FEATURES = [
    'has_resource_leak', 'has_inconsistent_contract', 'has_wrong_algorithm',
    'has_data_exposure', 'has_missing_error_handling', 'has_redundant_work_in_loop',
];
const HARD_DISCARD_FEATURES = ['is_quality_opinion', 'targets_unchanged_code'];
const SOFT_SPECULATION_FEATURES = ['requires_assumed_input', 'requires_assumed_workload', 'is_anti_pattern_only'];

function triageSuggestion(features) {
    const hasHard = HARD_DISCARD_FEATURES.some(f => features[f]);
    const hasSoft = SOFT_SPECULATION_FEATURES.some(f => features[f]);
    const hasStruct = STRUCTURAL_FEATURES.some(f => features[f]);
    // Structural defects always go to agent verification, even if also flagged as opinion
    if (hasStruct) return 'verify';
    if (hasHard) return 'discard';
    if (hasSoft) return 'discard';
    return 'verify';
}

// ── Local search tools ──
function searchCodebase(repoDir, pattern) {
    try {
        const result = execFileSync(
            'grep',
            ['-rEn', pattern, repoDir],
            { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 }
        );
        if (!result.trim()) return 'No matches found.';
        const lines = result.trim().split('\n').map(l => l.replace(repoDir + '/', '')).slice(0, 25);
        return `Found ${lines.length} matches:\n${lines.join('\n')}`;
    } catch {
        return 'No matches found.';
    }
}

function readFile(repoDir, filePath) {
    try {
        return fs.readFileSync(path.join(repoDir, filePath), 'utf-8');
    } catch {
        return `Error: File not found: ${filePath}`;
    }
}

function listDir(repoDir, dirPath) {
    try {
        const fullPath = path.join(repoDir, dirPath || '.');
        const entries = fs.readdirSync(fullPath);
        return entries.map(e => {
            const stat = fs.statSync(path.join(fullPath, e));
            return stat.isDirectory() ? `${e}/` : e;
        }).join('\n');
    } catch {
        return `Error: Directory not found: ${dirPath}`;
    }
}

// ── Retry wrapper ──
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 429 || response.status >= 500) {
                const delay = Math.pow(2, attempt) * 3000;
                process.stdout.write(`[retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s] `);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return response;
        } catch (e) {
            if (attempt === maxRetries - 1) throw e;
            const delay = Math.pow(2, attempt) * 3000;
            process.stdout.write(`[retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s] `);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('Max retries exceeded');
}

// ── Provider-specific API calls ──

// Google Gemini
async function callGeminiSingle(systemPrompt, userPrompt, jsonMode) {
    const genConfig = { temperature: 0, maxOutputTokens: 8192 };
    if (jsonMode) genConfig.responseMimeType = 'application/json';

    const response = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL.modelId}:generateContent?key=${API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\n' + userPrompt }] }],
                generationConfig: genConfig,
            }),
        }
    );
    if (!response.ok) throw new Error(`Gemini error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGeminiChat(messages) {
    const contents = [];
    let pendingUserParts = [];

    for (const msg of messages) {
        if (msg.role === 'system' || msg.role === 'user') {
            pendingUserParts.push({ text: msg.content });
        } else if (msg.role === 'model' || msg.role === 'assistant') {
            if (pendingUserParts.length > 0) {
                contents.push({ role: 'user', parts: pendingUserParts });
                pendingUserParts = [];
            }
            contents.push({ role: 'model', parts: [{ text: msg.content }] });
        }
    }
    if (pendingUserParts.length > 0) {
        contents.push({ role: 'user', parts: pendingUserParts });
    }

    const response = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL.modelId}:generateContent?key=${API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents,
                generationConfig: { temperature: 0, maxOutputTokens: 4096 },
            }),
        }
    );
    if (!response.ok) throw new Error(`Gemini error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// OpenAI / OpenRouter (OpenAI-compatible)
async function callOpenAISingle(systemPrompt, userPrompt, jsonMode) {
    const isOpenRouter = MODEL.provider === 'openrouter';
    const baseUrl = MODEL.baseUrl || (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');

    const body = {
        model: MODEL.modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0,
    };

    // GPT 5.x uses max_completion_tokens, others use max_tokens
    if (MODEL.modelId.startsWith('gpt-5')) {
        body.max_completion_tokens = 8192;
    } else {
        body.max_tokens = 8192;
    }

    if (jsonMode && !MODEL.noJsonMode) {
        body.response_format = { type: 'json_object' };
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
    };
    if (isOpenRouter) {
        headers['HTTP-Referer'] = 'https://kodus.io';
        headers['X-Title'] = 'Kodus Eval';
    }

    const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${MODEL.provider} error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

async function callOpenAIChat(messages) {
    const isOpenRouter = MODEL.provider === 'openrouter';
    const baseUrl = MODEL.baseUrl || (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');

    // Convert roles: 'model' → 'assistant'
    const apiMessages = messages.map(m => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: m.content,
    }));

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
    };
    if (isOpenRouter) {
        headers['HTTP-Referer'] = 'https://kodus.io';
        headers['X-Title'] = 'Kodus Eval';
    }

    const chatBody = {
        model: MODEL.modelId,
        messages: apiMessages,
        temperature: 0,
    };
    if (MODEL.modelId.startsWith('gpt-5')) {
        chatBody.max_completion_tokens = 4096;
    } else {
        chatBody.max_tokens = 4096;
    }

    const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(chatBody),
    });
    if (!response.ok) throw new Error(`${MODEL.provider} error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

// Anthropic Claude
async function callAnthropicSingle(systemPrompt, userPrompt, _jsonMode) {
    const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: MODEL.modelId,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            max_tokens: 8192,
            temperature: 0,
        }),
    });
    if (!response.ok) throw new Error(`Anthropic error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.content?.[0]?.text || '';
}

async function callAnthropicChat(messages) {
    // Extract system message, convert rest
    let system = '';
    const apiMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (system ? '\n\n' : '') + msg.content;
        } else {
            apiMessages.push({
                role: msg.role === 'model' ? 'assistant' : msg.role,
                content: msg.content,
            });
        }
    }

    const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: MODEL.modelId,
            system: system || undefined,
            messages: apiMessages,
            max_tokens: 4096,
            temperature: 0,
        }),
    });
    if (!response.ok) throw new Error(`Anthropic error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.content?.[0]?.text || '';
}

// ── Unified LLM interface ──
async function callLLM(systemPrompt, userPrompt, jsonMode = false) {
    switch (MODEL.provider) {
        case 'google': return callGeminiSingle(systemPrompt, userPrompt, jsonMode);
        case 'openai':
        case 'openrouter':
        case 'cerebras': return callOpenAISingle(systemPrompt, userPrompt, jsonMode);
        case 'anthropic': return callAnthropicSingle(systemPrompt, userPrompt, jsonMode);
        default: throw new Error(`Unknown provider: ${MODEL.provider}`);
    }
}

async function callLLMChat(messages) {
    switch (MODEL.provider) {
        case 'google': return callGeminiChat(messages);
        case 'openai':
        case 'openrouter':
        case 'cerebras': return callOpenAIChat(messages);
        case 'anthropic': return callAnthropicChat(messages);
        default: throw new Error(`Unknown provider: ${MODEL.provider}`);
    }
}

// ── Robust JSON parser ──
function cleanAndParseJSON(raw) {
    if (!raw || !raw.trim()) throw new Error('Empty response');

    // 1. Try direct parse
    try { return JSON.parse(raw); } catch {}

    // 2. Extract from markdown code blocks
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
        try { return JSON.parse(codeBlock[1].trim()); } catch {}
    }

    // 3. Extract outermost JSON object
    let json = raw;
    const objStart = json.indexOf('{');
    if (objStart === -1) throw new Error('No JSON object found in response');
    json = json.substring(objStart);

    // Find matching closing brace (handle nested)
    let depth = 0, inStr = false, escape = false, end = -1;
    for (let i = 0; i < json.length; i++) {
        const c = json[i];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) json = json.substring(0, end + 1);

    // 4. Try parse after extraction
    try { return JSON.parse(json); } catch {}

    // 5. Clean common issues:
    let cleaned = json
        // Remove trailing commas before } or ]
        .replace(/,\s*([\]}])/g, '$1')
        // Remove single-line comments
        .replace(/\/\/[^\n]*/g, '')
        // Remove multi-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // Fix unquoted keys (simple cases): { key: -> { "key":
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try { return JSON.parse(cleaned); } catch {}

    // 6. Fix unterminated strings — find where JSON.parse fails and close the string
    try {
        JSON.parse(cleaned);
    } catch (e) {
        const posMatch = e.message.match(/position\s+(\d+)/i);
        if (posMatch) {
            const pos = parseInt(posMatch[1]);
            // Try closing the string at the error position
            const before = cleaned.substring(0, pos);
            const after = cleaned.substring(pos);
            // If we're inside an unterminated string, close it
            const fixed = before + '"' + after;
            try { return JSON.parse(fixed); } catch {}
            // Try truncating at the error and closing all open structures
            const truncated = before + '"}]}';
            try { return JSON.parse(truncated); } catch {}
        }
    }

    // 7. Nuclear option: extract key-value pairs with regex
    try {
        const result = {};
        // Look for "codeSuggestions" array pattern
        const sugMatch = cleaned.match(/"codeSuggestions"\s*:\s*\[([\s\S]*)\]/);
        if (sugMatch) {
            // Try to parse just the features object
            const featMatch = sugMatch[1].match(/"features"\s*:\s*(\{[^}]+\})/);
            if (featMatch) {
                const features = JSON.parse(featMatch[1].replace(/,\s*}/g, '}'));
                result.codeSuggestions = [{ features }];
                return result;
            }
        }
    } catch {}

    throw new Error('Could not parse feature extraction response');
}

// ── Feature Extraction ──
async function extractFeatures(testCase) {
    const promptLoader = require('./prompt-loader-C.js');
    const promptMessages = JSON.parse(promptLoader());

    const systemContent = promptMessages[0].content;
    const userTemplate = promptMessages[1].content;

    const suggestionsContext = JSON.stringify(testCase.suggestionsToEvaluate, null, 2);

    const userContent = userTemplate
        .replace('{{fileContent}}', testCase.fileContent || '')
        .replace('{{patchWithLinesStr}}', testCase.patchWithLinesStr || '')
        .replace('{{filePath}}', testCase.filePath || '')
        .replace('{{suggestionsContext}}', suggestionsContext)
        .replace('{{codebaseContext}}', '');

    const response = await callLLM(systemContent, userContent, true);

    try {
        return cleanAndParseJSON(response);
    } catch (firstErr) {
        // Retry once: ask model to return valid JSON
        process.stdout.write('[parse-retry] ');
        const retryResponse = await callLLM(
            'You are a JSON formatter. Return ONLY valid JSON, no markdown, no comments, no trailing commas.',
            `The following response was supposed to be valid JSON but had syntax errors. Fix it and return ONLY the corrected JSON:\n\n${response}`,
            true,
        );
        try {
            return cleanAndParseJSON(retryResponse);
        } catch {
            throw new Error(`Could not parse feature extraction response: ${firstErr.message}`);
        }
    }
}

// ── Agent Verification ──
async function verifyWithAgent(suggestion, features, repoDir) {
    const claimedDefects = STRUCTURAL_FEATURES.filter(f => features[f]);

    const systemPrompt = `You are a code verification agent. You search a codebase to VERIFY or DISPROVE a code review suggestion.

SUGGESTION: "${suggestion.suggestionContent}"
CLAIMED DEFECTS: ${claimedDefects.join(', ')}
CODE UNDER REVIEW:
\`\`\`
${suggestion.existingCode}
\`\`\`

You have 3 tools. To use one, respond with ONLY a JSON object:
- {"tool": "search", "pattern": "<grep pattern>"} — searches all files recursively
- {"tool": "read", "path": "<file path>"} — reads a file's full content
- {"tool": "list", "path": "<directory path>"} — lists directory contents

When you have enough evidence, respond with your final verdict:
{"verdict": true, "evidence": "<what confirms the defect is REAL>", "action": "no_changes"}
OR
{"verdict": false, "evidence": "<what shows the defect is mitigated or not applicable>", "action": "discard"}

CRITICAL STRATEGY — follow this order:
1. IMMEDIATELY search for the key function/symbol name to find ALL usages across the codebase. Use simple patterns (e.g. search for "getClient" not "getClient\\(")
2. Read files that import or call the affected code to check if callers handle the issue
3. Check if there's cleanup/mitigation code elsewhere (error handlers, finally blocks, middleware, wrappers)
4. If callers don't use the flagged method directly but handle the concern themselves (e.g. they call a lower-level API with proper cleanup instead of the convenience method), the suggestion is unnecessary
5. Deliver verdict based on evidence

KEY PRINCIPLE: A defect claimed in one file may be MITIGATED by code in OTHER files (callers that catch errors, cleanup routines, wrappers that add missing handling). Search broadly — read the actual caller code.

RESOURCE LEAK RULE: For resource leaks, check WHO actually calls the leaking method:
- Search for ALL usages of the method across the codebase
- If callers bypass the leaking method entirely (using lower-level APIs with their own cleanup), the leak exists only in unused/dead code → verdict: false
- If callers DO use the leaking method and don't compensate → verdict: true
- A method that leaks but is never called (or only called by code that handles cleanup independently) is NOT a real defect

ALGORITHM/CONTEXT RULE: For wrong algorithm suggestions, verify WHAT the output is used for:
- SHA-256 for file checksums/cache keys/integrity = FINE → verdict: false
- SHA-256 for password hashing = REAL defect → verdict: true
- The same algorithm can be correct or wrong depending on the use case — always check callers

RACE CONDITION RULE: For race condition / concurrency suggestions:
- Search for locking mechanisms (pg_advisory_lock, mutex, FOR UPDATE, synchronized) in ALL callers of the affected method
- If ALL callers acquire a lock before calling the method → verdict: false (race condition is impossible in practice)
- If ANY caller invokes the method without locking → verdict: true

REDUNDANT WORK RULE: For "expensive call inside loop" suggestions:
- Read the ACTUAL file and verify the exact line positions of the expensive call vs the loop
- If the expensive call is OUTSIDE the loop (called once before iteration) → verdict: false (suggestion has wrong line references)
- If the call is genuinely INSIDE the loop body → verdict: true

VERDICT RULES:
- If callers/consumers ALREADY handle the issue → verdict: false, action: "discard" (suggestion is unnecessary)
- If the defect is REAL and NOT mitigated elsewhere → verdict: true, action: "no_changes" (suggestion is correct)
- If unsure after searching → verdict: true, action: "no_changes" (assume defect is real if you can't disprove it)

You MUST respond with JSON only. No markdown, no explanation text.`;

    const messages = [{ role: 'user', content: systemPrompt }];
    const MAX_TURNS = 12;
    const toolLog = [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await callLLMChat(messages);

        let parsed;
        try {
            parsed = cleanAndParseJSON(response);
        } catch {}

        if (!parsed) {
            messages.push({ role: 'model', content: response });
            messages.push({ role: 'user', content: 'Respond with valid JSON only. Either a tool call or a verdict.' });
            continue;
        }

        // Final verdict
        if ('verdict' in parsed) {
            return { ...parsed, toolLog, turns: turn + 1 };
        }

        // Tool call
        let toolResult;
        if (parsed.tool === 'search') {
            toolResult = searchCodebase(repoDir, parsed.pattern);
            toolLog.push({ tool: 'search', pattern: parsed.pattern, resultPreview: toolResult.substring(0, 200) });
        } else if (parsed.tool === 'read') {
            toolResult = readFile(repoDir, parsed.path);
            toolLog.push({ tool: 'read', path: parsed.path, resultPreview: toolResult.substring(0, 200) });
        } else if (parsed.tool === 'list') {
            toolResult = listDir(repoDir, parsed.path);
            toolLog.push({ tool: 'list', path: parsed.path, resultPreview: toolResult.substring(0, 200) });
        } else {
            return { verdict: false, action: 'discard', evidence: 'Unknown tool', toolLog, turns: turn + 1 };
        }

        messages.push({ role: 'model', content: JSON.stringify(parsed) });
        messages.push({ role: 'user', content: `Tool result:\n${toolResult}\n\nContinue investigating or provide your final verdict as JSON.` });
    }

    return { verdict: true, action: 'no_changes', evidence: 'Max turns reached — defaulting to keep', toolLog, turns: MAX_TURNS };
}

// ── Main ──
async function main() {
    const datasetPath = path.join(__dirname, 'safeguard_datasets/verify/agent_verification.jsonl');
    const lines = fs.readFileSync(datasetPath, 'utf-8').split('\n').filter(Boolean);
    const testCases = lines.slice(0, limit).map(l => JSON.parse(l));

    console.log(`\n=== Agent Verification Pipeline Eval ===`);
    console.log(`Test cases: ${testCases.length}`);
    console.log(`Model: ${MODEL.displayName} (${MODEL.modelId})`);
    console.log(`Provider: ${MODEL.provider}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no LLM calls)' : 'LIVE'}\n`);

    const results = [];

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const inputs = tc.inputs;
        const expected = tc.outputs.expectedActions[0];
        const scenario = tc.metadata.scenario;

        process.stdout.write(`[${i + 1}/${testCases.length}] ${scenario}... `);

        if (dryRun) {
            console.log('SKIPPED (dry run)');
            results.push({ scenario, expected: expected.action, action: 'skipped', triage: 'skipped' });
            continue;
        }

        if (i > 0) await new Promise(r => setTimeout(r, 2000));

        try {
            // Step 1: Feature extraction
            const featureResult = await extractFeatures(inputs);
            let suggestion = featureResult.codeSuggestions?.[0];

            // Fallback: some models return features at top level or alternative structures
            if (!suggestion) {
                if (featureResult.features) {
                    suggestion = { features: featureResult.features };
                } else if (featureResult.suggestions?.[0]) {
                    suggestion = featureResult.suggestions[0];
                } else if (Array.isArray(featureResult) && featureResult[0]?.features) {
                    suggestion = featureResult[0];
                } else {
                    // Try to find any object with boolean feature keys
                    const allKeys = Object.keys(featureResult);
                    const featureKeys = allKeys.filter(k => STRUCTURAL_FEATURES.includes(k) || HARD_DISCARD_FEATURES.includes(k) || SOFT_SPECULATION_FEATURES.includes(k));
                    if (featureKeys.length >= 2) {
                        suggestion = { features: featureResult };
                    } else {
                        throw new Error('No suggestion in feature extraction output');
                    }
                }
            }

            const features = suggestion.features || {};
            const trueFeatures = Object.entries(features).filter(([, v]) => v).map(([k]) => k);

            // Step 2: Triage
            const triage = triageSuggestion(features);
            let finalAction;
            let verificationResult = null;

            if (triage === 'keep') {
                finalAction = (features.improvedCode_is_correct !== false) ? 'no_changes' : 'update';
            } else if (triage === 'discard') {
                finalAction = 'discard';
            } else {
                const repoDir = materializeFixture(inputs.repoFixture);
                try {
                    verificationResult = await verifyWithAgent(
                        inputs.suggestionsToEvaluate[0],
                        features,
                        repoDir,
                    );
                    finalAction = verificationResult.action;
                } finally {
                    cleanupFixture(repoDir);
                }
            }

            const correct = finalAction === expected.action;
            const icon = correct ? '✓' : '✗';
            console.log(`${icon} triage=${triage} action=${finalAction} expected=${expected.action} features=[${trueFeatures.join(', ')}]`);

            if (verificationResult) {
                console.log(`    agent: verdict=${verificationResult.verdict} turns=${verificationResult.turns} evidence="${verificationResult.evidence?.substring(0, 100)}"`);
                if (verificationResult.toolLog?.length) {
                    verificationResult.toolLog.forEach(t => {
                        console.log(`    tool: ${t.tool}(${t.pattern || t.path}) → ${t.resultPreview?.substring(0, 80)}`);
                    });
                }
            }

            results.push({
                scenario,
                expected: expected.action,
                action: finalAction,
                triage,
                correct,
                features: trueFeatures,
                verification: verificationResult,
            });
        } catch (error) {
            console.log(`ERROR: ${error.message.substring(0, 200)}`);
            results.push({ scenario, expected: expected.action, action: 'error', error: error.message });
        }
    }

    // Summary
    const valid = results.filter(r => r.action !== 'skipped' && r.action !== 'error');
    const correct = valid.filter(r => r.correct);
    const verified = valid.filter(r => r.triage === 'verify');
    const verifyCorrect = verified.filter(r => r.correct);
    const errors = results.filter(r => r.action === 'error');

    console.log(`\n=== Summary (${MODEL.displayName}) ===`);
    console.log(`Total: ${valid.length}, Correct: ${correct.length} (${valid.length > 0 ? (100 * correct.length / valid.length).toFixed(1) : 0}%)`);
    if (errors.length > 0) console.log(`Errors: ${errors.length}`);
    console.log(`Triage distribution: keep=${valid.filter(r => r.triage === 'keep').length} discard=${valid.filter(r => r.triage === 'discard').length} verify=${verified.length}`);
    if (verified.length > 0) {
        console.log(`Agent verification: ${verifyCorrect.length}/${verified.length} correct (${(100 * verifyCorrect.length / verified.length).toFixed(1)}%)`);
    }

    const baselineCorrect = valid.filter(r => {
        if (r.triage === 'verify') return 'discard' === r.expected;
        return r.correct;
    });
    console.log(`\nBaseline (without agent): ${baselineCorrect.length}/${valid.length} (${valid.length > 0 ? (100 * baselineCorrect.length / valid.length).toFixed(1) : 0}%)`);
    console.log(`With agent: ${correct.length}/${valid.length} (${valid.length > 0 ? (100 * correct.length / valid.length).toFixed(1) : 0}%)`);
    const delta = correct.length - baselineCorrect.length;
    console.log(`Delta: ${delta >= 0 ? '+' : ''}${delta}`);

    // Save results
    const outputPath = path.join(__dirname, `results/agent-eval-${modelKey}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({
        model: MODEL,
        results,
        summary: { total: valid.length, correct: correct.length, verified: verified.length, verifyCorrect: verifyCorrect.length, errors: errors.length },
    }, null, 2));
    console.log(`\nResults saved to ${outputPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
