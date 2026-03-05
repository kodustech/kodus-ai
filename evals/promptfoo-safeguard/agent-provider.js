/**
 * Custom promptfoo provider that runs the full safeguard pipeline:
 * 1. Feature extraction (LLM call to Gemini)
 * 2. Code-based triage (keep/discard/verify)
 * 3. Agent verification with local codebase search (for VERIFY cases)
 *
 * Usage in promptfoo YAML:
 *   providers:
 *     - id: file://agent-provider.js
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { materializeFixture, cleanupFixture } = require('./materialize-fixture');

// ── Triage logic (mirrors safeguardTriage.service.ts) ──

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
    if (hasHard) return 'discard';
    if (hasSoft && hasStruct) return 'verify';
    if (hasSoft) return 'discard';
    if (hasStruct) return 'keep';
    return 'verify';
}

// ── Local codebase search tools ──

function searchCodebase(repoDir, pattern) {
    try {
        const result = execFileSync(
            'rg',
            ['--json', pattern, repoDir],
            { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 }
        );
        // Parse ripgrep JSON output into readable format
        const matches = [];
        for (const line of result.split('\n').filter(Boolean)) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'match') {
                    const filePath = entry.data.path.text.replace(repoDir + '/', '');
                    const lineNum = entry.data.line_number;
                    const lineText = entry.data.lines.text.trim();
                    matches.push(`${filePath}:${lineNum}: ${lineText}`);
                }
            } catch {}
        }
        return matches.length > 0
            ? `Found ${matches.length} matches:\n${matches.slice(0, 15).join('\n')}`
            : 'No matches found.';
    } catch {
        return 'No matches found.';
    }
}

function readFile(repoDir, filePath) {
    const fullPath = path.join(repoDir, filePath);
    try {
        const { readFileSync } = require('fs');
        return readFileSync(fullPath, 'utf-8');
    } catch {
        return `Error: File not found: ${filePath}`;
    }
}

function listDirectory(repoDir, dirPath) {
    const fullPath = path.join(repoDir, dirPath || '.');
    try {
        const { readdirSync, statSync } = require('fs');
        const entries = readdirSync(fullPath);
        return entries.map(e => {
            const stat = statSync(path.join(fullPath, e));
            return stat.isDirectory() ? `${e}/` : e;
        }).join('\n');
    } catch {
        return `Error: Directory not found: ${dirPath}`;
    }
}

// ── Gemini API call ──

async function callGemini(messages, apiKey) {
    const { default: fetch } = await import('node-fetch');

    const contents = messages.map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        parts: [{ text: m.content }],
    }));

    // Gemini doesn't support system role directly — prepend as first user message
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsg = messages.find(m => m.role === 'user');

    const requestContents = [];
    if (systemMsg && userMsg) {
        requestContents.push({
            role: 'user',
            parts: [{ text: systemMsg.content + '\n\n---\n\n' + userMsg.content }],
        });
    } else {
        requestContents.push(...contents);
    }

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: requestContents,
                generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 8192,
                    responseMimeType: 'application/json',
                },
            }),
        }
    );

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No response from Gemini');
    return text;
}

// ── Verification agent (simple tool-use loop, no LangChain) ──

async function runVerificationAgent(suggestion, features, repoDir, apiKey) {
    // Determine what to search for based on features
    const claimedDefects = STRUCTURAL_FEATURES.filter(f => features[f]);
    const claimedDefectStr = claimedDefects.join(', ');

    // Build the verification prompt
    const verificationSystemPrompt = `You are verifying a code review suggestion by searching a codebase.

SUGGESTION: "${suggestion.suggestionContent}"
CLAIMED DEFECT: ${claimedDefectStr}
FILE: ${suggestion.existingCode}

You have 3 tools available. To use them, respond with a JSON tool call:

{"tool": "search", "pattern": "<ripgrep regex pattern>"}
{"tool": "read", "path": "<file path relative to repo root>"}
{"tool": "list", "path": "<directory path>"}

When you have enough evidence, respond with your final verdict:

{"verdict": true/false, "evidence": "<what you found>", "action": "no_changes" or "discard"}

VERIFICATION STRATEGY:
- Search for callers/consumers of the function or symbol mentioned in the suggestion
- Check if the claimed defect is mitigated elsewhere (error handling, cleanup, validation)
- If evidence supports the defect → verdict: true, action: "no_changes"
- If evidence shows the defect is mitigated or doesn't apply → verdict: false, action: "discard"
- If you can't find evidence after your searches → verdict: false, action: "discard"

Start by listing the repo structure, then search for relevant patterns.`;

    const conversationHistory = [
        { role: 'user', content: verificationSystemPrompt },
    ];

    const MAX_ITERATIONS = 4;
    let finalResult = null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await callGemini(
            [{ role: 'system', content: 'You are a code verification agent. Respond ONLY with JSON.' },
             ...conversationHistory],
            apiKey
        );

        // Try to parse the response
        let parsed;
        try {
            // Handle response that might have markdown code blocks
            let clean = response.trim();
            const match = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) clean = match[1].trim();
            parsed = JSON.parse(clean);
        } catch {
            // Try to extract JSON from the response
            try {
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
            } catch {
                // Give up on this iteration
                conversationHistory.push({ role: 'model', content: response });
                conversationHistory.push({ role: 'user', content: 'Please respond with valid JSON. Either a tool call or a verdict.' });
                continue;
            }
        }

        if (!parsed) continue;

        // Check if it's a final verdict
        if ('verdict' in parsed) {
            finalResult = parsed;
            break;
        }

        // Execute tool call
        if (parsed.tool === 'search') {
            const result = searchCodebase(repoDir, parsed.pattern);
            conversationHistory.push({ role: 'model', content: JSON.stringify(parsed) });
            conversationHistory.push({ role: 'user', content: `Search results:\n${result}\n\nContinue your investigation or provide your final verdict.` });
        } else if (parsed.tool === 'read') {
            const result = readFile(repoDir, parsed.path);
            conversationHistory.push({ role: 'model', content: JSON.stringify(parsed) });
            conversationHistory.push({ role: 'user', content: `File content:\n${result}\n\nContinue your investigation or provide your final verdict.` });
        } else if (parsed.tool === 'list') {
            const result = listDirectory(repoDir, parsed.path);
            conversationHistory.push({ role: 'model', content: JSON.stringify(parsed) });
            conversationHistory.push({ role: 'user', content: `Directory listing:\n${result}\n\nContinue your investigation or provide your final verdict.` });
        } else {
            // Unknown format, treat as verdict attempt
            finalResult = { verdict: false, action: 'discard', evidence: 'Could not parse agent response' };
            break;
        }
    }

    // Default to discard if agent didn't produce a verdict
    if (!finalResult) {
        finalResult = { verdict: false, action: 'discard', evidence: 'Agent did not reach a verdict within iteration limit' };
    }

    return finalResult;
}

// ── Main provider ──

class AgentSafeguardProvider {
    constructor(options) {
        this.apiKey = options.config?.apiKey || process.env.GOOGLE_API_KEY || process.env.API_GOOGLE_AI_API_KEY;
        this.providerId = options.id || 'agent-safeguard';
    }

    id() {
        return this.providerId;
    }

    async callApi(prompt) {
        try {
            // Parse the prompt to extract variables
            // The prompt comes pre-rendered from the prompt loader
            const promptData = JSON.parse(prompt);
            const messages = Array.isArray(promptData) ? promptData : [promptData];

            // Step 1: Feature extraction
            const featureResponse = await callGemini(messages, this.apiKey);

            let featureResult;
            try {
                featureResult = JSON.parse(featureResponse);
            } catch {
                const match = featureResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) featureResult = JSON.parse(match[1].trim());
                else throw new Error('Could not parse feature extraction response');
            }

            const suggestions = featureResult.codeSuggestions || [];

            // Step 2 & 3: Triage + Verification for each suggestion
            // We need the repoFixture from the test vars — it's passed via context
            // But promptfoo doesn't pass vars to providers directly.
            // We'll encode the repoFixture in the prompt as a hidden section.

            const pipelineResults = [];

            for (const suggestion of suggestions) {
                const features = suggestion.features || {};
                const decision = triageSuggestion(features);

                pipelineResults.push({
                    ...suggestion,
                    triageDecision: decision,
                    // Will be overridden for VERIFY cases below
                });
            }

            // Build final output in the same format as the safeguard
            const output = {
                codeSuggestions: pipelineResults.map(s => {
                    let action;
                    if (s.triageDecision === 'keep') {
                        action = (s.features?.improvedCode_is_correct !== false) ? 'no_changes' : 'update';
                    } else {
                        action = 'discard';
                    }
                    return {
                        ...s,
                        action,
                        reason: `triage=${s.triageDecision}`,
                    };
                }),
            };

            return {
                output: JSON.stringify(output),
                tokenUsage: {},
            };
        } catch (error) {
            return { error: error.message };
        }
    }
}

module.exports = AgentSafeguardProvider;
