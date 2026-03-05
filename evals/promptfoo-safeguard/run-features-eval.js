#!/usr/bin/env node
/**
 * Isolated eval for feature extraction accuracy.
 * Tests whether the LLM correctly detects boolean features per code review suggestion.
 *
 * Usage:
 *   node run-features-eval.js [--model=MODEL] [--dry-run] [--limit=N]
 */

const fs = require('fs');
const path = require('path');

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
    'gemini-2.5-flash': { provider: 'google', modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    'gemini-3-flash': { provider: 'google', modelId: 'gemini-3-flash-preview', displayName: 'Gemini 3.0 Flash' },
    'gemini-3.1-flash-lite': { provider: 'google', modelId: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash Lite' },
    'claude-sonnet-4-5': { provider: 'anthropic', modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5' },
    'gpt-5.2': { provider: 'openai', modelId: 'gpt-5.2', displayName: 'GPT 5.2' },
    'glm-5': { provider: 'openrouter', modelId: 'z-ai/glm-5', displayName: 'GLM 5', noJsonMode: true },
    'kimi-k2.5': { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5', displayName: 'Kimi K2.5' },
    'gpt-oss': { provider: 'cerebras', modelId: 'gpt-oss-120b', displayName: 'GPT OSS 120B (Cerebras)', baseUrl: 'https://api.cerebras.ai/v1' },
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

// ── Features evaluated (excludes improvedCode_is_correct — not relevant for triage) ──
const ALL_FEATURES = [
    'has_resource_leak', 'has_inconsistent_contract', 'has_wrong_algorithm',
    'has_data_exposure', 'has_missing_error_handling', 'has_redundant_work_in_loop',
    'requires_assumed_input', 'requires_assumed_workload', 'is_anti_pattern_only',
    'is_quality_opinion', 'targets_unchanged_code',
];

// ── Ground truth: expected features per scenario ──
const EXPECTED_FEATURES = {
    resource_leak_mitigated: {
        has_resource_leak: true,
    },
    resource_leak_real: {
        has_resource_leak: true,
    },
    null_check_already_handled: {
        has_missing_error_handling: true,
        requires_assumed_input: true,
    },
    null_check_missing: {
        has_missing_error_handling: true,
        requires_assumed_input: true,
    },
    wrong_algorithm_context_ok: {
        has_wrong_algorithm: true,
    },
    wrong_algorithm_passwords: {
        has_wrong_algorithm: true,
    },
    error_handling_caller_catches: {
        has_missing_error_handling: true,
    },
    error_handling_no_catch: {
        has_missing_error_handling: true,
    },
    inconsistent_sync_framework_handles: {
        requires_assumed_workload: true,
    },
    data_exposure_real: {
        has_data_exposure: true,
    },
    race_condition_mitigated: {
        requires_assumed_workload: true,
    },
    race_condition_real: {
        requires_assumed_workload: true,
    },
    redundant_work_mitigated: {
        has_redundant_work_in_loop: true,
    },
    redundant_work_real: {
        has_redundant_work_in_loop: true,
    },
};

function getExpectedFeatures(scenario) {
    const expected = EXPECTED_FEATURES[scenario] || {};
    const full = {};
    for (const f of ALL_FEATURES) {
        full[f] = expected[f] === true;
    }
    return full;
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

// ── Robust JSON parser ──
function cleanAndParseJSON(raw) {
    if (!raw || !raw.trim()) throw new Error('Empty response');
    try { return JSON.parse(raw); } catch {}

    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
        try { return JSON.parse(codeBlock[1].trim()); } catch {}
    }

    let json = raw;
    const objStart = json.indexOf('{');
    if (objStart === -1) throw new Error('No JSON object found');
    json = json.substring(objStart);

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

    try { return JSON.parse(json); } catch {}

    let cleaned = json
        .replace(/,\s*([\]}])/g, '$1')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try { return JSON.parse(cleaned); } catch {}

    try {
        JSON.parse(cleaned);
    } catch (e) {
        const posMatch = e.message.match(/position\s+(\d+)/i);
        if (posMatch) {
            const pos = parseInt(posMatch[1]);
            const before = cleaned.substring(0, pos);
            const fixed = before + '"' + cleaned.substring(pos);
            try { return JSON.parse(fixed); } catch {}
            try { return JSON.parse(before + '"}]}'); } catch {}
        }
    }

    try {
        const sugMatch = cleaned.match(/"codeSuggestions"\s*:\s*\[([\s\S]*)\]/);
        if (sugMatch) {
            const featMatch = sugMatch[1].match(/"features"\s*:\s*(\{[^}]+\})/);
            if (featMatch) {
                const features = JSON.parse(featMatch[1].replace(/,\s*}/g, '}'));
                return { codeSuggestions: [{ features }] };
            }
        }
    } catch {}

    throw new Error('Could not parse JSON');
}

// ── Provider-specific API calls ──

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
        process.stdout.write('[parse-retry] ');
        const retryResponse = await callLLM(
            'You are a JSON formatter. Return ONLY valid JSON, no markdown, no comments, no trailing commas.',
            `Fix this JSON and return ONLY the corrected version:\n\n${response}`,
            true,
        );
        try {
            return cleanAndParseJSON(retryResponse);
        } catch {
            throw new Error(`Parse failed: ${firstErr.message}`);
        }
    }
}

// ── Comparison logic ──
function compareFeatures(extracted, expected) {
    const errors = [];
    let correct = 0;

    for (const feature of ALL_FEATURES) {
        const got = !!extracted[feature];
        const want = !!expected[feature];

        if (got === want) {
            correct++;
        } else if (got && !want) {
            errors.push({ feature, type: 'FP', got, want });
        } else {
            errors.push({ feature, type: 'FN', got, want });
        }
    }

    return { correct, total: ALL_FEATURES.length, errors };
}

// ── Main ──
async function main() {
    const datasetPath = path.join(__dirname, 'safeguard_datasets/verify/agent_verification.jsonl');
    const lines = fs.readFileSync(datasetPath, 'utf-8').split('\n').filter(Boolean);
    const testCases = lines.slice(0, limit).map(l => JSON.parse(l));

    console.log(`\n=== Feature Extraction Eval ===`);
    console.log(`Model: ${MODEL.displayName} (${MODEL.modelId})`);
    console.log(`Provider: ${MODEL.provider}`);
    console.log(`Cases: ${testCases.length}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

    const results = [];
    // Per-feature tracking
    const featureStats = {};
    for (const f of ALL_FEATURES) {
        featureStats[f] = { tp: 0, fp: 0, fn: 0, tn: 0 };
    }

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const scenario = tc.metadata.scenario;
        const expected = getExpectedFeatures(scenario);

        process.stdout.write(`[${i + 1}/${testCases.length}] ${scenario}... `);

        if (dryRun) {
            const trueExpected = ALL_FEATURES.filter(f => expected[f]);
            console.log(`SKIP (expected: ${trueExpected.join(', ')})`);
            results.push({ scenario, status: 'skipped' });
            continue;
        }

        if (i > 0) await new Promise(r => setTimeout(r, 2000));

        try {
            const featureResult = await extractFeatures(tc.inputs);

            // Extract features from response
            let suggestion = featureResult.codeSuggestions?.[0];
            if (!suggestion) {
                if (featureResult.features) {
                    suggestion = { features: featureResult.features };
                } else if (featureResult.suggestions?.[0]) {
                    suggestion = featureResult.suggestions[0];
                } else {
                    const allKeys = Object.keys(featureResult);
                    const featureKeys = allKeys.filter(k => ALL_FEATURES.includes(k));
                    if (featureKeys.length >= 2) {
                        suggestion = { features: featureResult };
                    } else {
                        throw new Error('No features in response');
                    }
                }
            }

            const extracted = suggestion.features || {};
            const comparison = compareFeatures(extracted, expected);

            // Update per-feature stats
            for (const f of ALL_FEATURES) {
                const got = !!extracted[f];
                const want = !!expected[f];
                if (got && want) featureStats[f].tp++;
                else if (got && !want) featureStats[f].fp++;
                else if (!got && want) featureStats[f].fn++;
                else featureStats[f].tn++;
            }

            const icon = comparison.errors.length === 0 ? '✓' : '✗';
            const errorDesc = comparison.errors.map(e => `${e.type}:${e.feature}`).join(', ');
            console.log(`${icon} ${comparison.correct}/${comparison.total}${errorDesc ? ` (${errorDesc})` : ''}`);

            results.push({
                scenario,
                status: 'ok',
                correct: comparison.correct,
                total: comparison.total,
                perfect: comparison.errors.length === 0,
                errors: comparison.errors,
                extractedTrue: ALL_FEATURES.filter(f => !!extracted[f]),
                expectedTrue: ALL_FEATURES.filter(f => !!expected[f]),
            });
        } catch (error) {
            console.log(`ERROR: ${error.message.substring(0, 200)}`);
            results.push({ scenario, status: 'error', error: error.message });
        }
    }

    // ── Summary ──
    const valid = results.filter(r => r.status === 'ok');
    const perfect = valid.filter(r => r.perfect);
    const totalCorrect = valid.reduce((s, r) => s + r.correct, 0);
    const totalFeatures = valid.reduce((s, r) => s + r.total, 0);
    const errors = results.filter(r => r.status === 'error');

    console.log(`\n=== Per-Feature Results (${MODEL.displayName}) ===`);
    console.log(`${'Feature'.padEnd(35)} ${'P'.padStart(5)} ${'R'.padStart(5)} ${'F1'.padStart(5)}  Detail`);
    console.log('-'.repeat(80));

    for (const f of ALL_FEATURES) {
        const s = featureStats[f];
        const precision = (s.tp + s.fp) > 0 ? s.tp / (s.tp + s.fp) : 1;
        const recall = (s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn) : 1;
        const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

        const detail = [];
        if (s.tp > 0) detail.push(`${s.tp}TP`);
        if (s.fp > 0) detail.push(`${s.fp}FP`);
        if (s.fn > 0) detail.push(`${s.fn}FN`);
        if (s.tn > 0) detail.push(`${s.tn}TN`);

        const warn = (s.fp > 0 || s.fn > 0) ? ' !' : '';
        console.log(`${f.padEnd(35)} ${precision.toFixed(2).padStart(5)} ${recall.toFixed(2).padStart(5)} ${f1.toFixed(2).padStart(5)}  ${detail.join(' ')}${warn}`);
    }

    console.log(`\n=== Overall (${MODEL.displayName}) ===`);
    console.log(`Feature accuracy: ${totalCorrect}/${totalFeatures} (${totalFeatures > 0 ? (100 * totalCorrect / totalFeatures).toFixed(1) : 0}%)`);
    console.log(`Perfect cases: ${perfect.length}/${valid.length}`);
    if (errors.length > 0) console.log(`Parse errors: ${errors.length}`);

    // ── Missed cases detail ──
    const imperfect = valid.filter(r => !r.perfect);
    if (imperfect.length > 0) {
        console.log(`\n=== Errors by Case ===`);
        for (const r of imperfect) {
            const fps = r.errors.filter(e => e.type === 'FP').map(e => e.feature);
            const fns = r.errors.filter(e => e.type === 'FN').map(e => e.feature);
            let line = `  ${r.scenario}: `;
            if (fps.length > 0) line += `FP=[${fps.join(', ')}] `;
            if (fns.length > 0) line += `FN=[${fns.join(', ')}]`;
            console.log(line);
        }
    }

    // ── Save results ──
    const outputPath = path.join(__dirname, `results/features-eval-${modelKey}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({
        model: MODEL,
        featureStats,
        results,
        summary: {
            totalCorrect,
            totalFeatures,
            accuracy: totalFeatures > 0 ? totalCorrect / totalFeatures : 0,
            perfectCases: perfect.length,
            validCases: valid.length,
            errors: errors.length,
        },
    }, null, 2));
    console.log(`\nResults saved to ${outputPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
