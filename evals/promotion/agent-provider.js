require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { generateText, Output, jsonSchema } = require('ai');

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

if (!process.env.API_CRYPTO_KEY) {
    process.env.API_CRYPTO_KEY = '0'.repeat(64);
}

const {
    buildVerifierPrompt,
} = require('../../libs/code-review/infrastructure/agents/llm/agent-loop.ts');

function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;

    if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    }

    return value;
}

function summarizeInput(value) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null' };
    if (typeof value === 'string') {
        return {
            type: 'string',
            length: value.length,
            preview: value.slice(0, 180),
        };
    }
    if (Array.isArray(value)) {
        return {
            type: 'array',
            length: value.length,
        };
    }
    if (typeof value === 'object') {
        return {
            type: 'object',
            keys: Object.keys(value).slice(0, 20),
        };
    }

    return { type: typeof value };
}

function truncateText(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

function defaultApiKeyEnv(provider) {
    switch (provider) {
        case 'openai':
            return 'API_OPEN_AI_API_KEY';
        case 'openai-compatible':
            return 'API_OPEN_AI_API_KEY';
        case 'anthropic':
            return 'API_ANTHROPIC_API_KEY';
        case 'openrouter':
            return 'API_OPENROUTER_KEY';
        case 'google':
        default:
            return 'API_GOOGLE_AI_API_KEY';
    }
}

function buildOpenRouterProviderRouting(config) {
    const providerOrder = Array.isArray(config.providerOrder)
        ? config.providerOrder.filter(Boolean)
        : [];

    if (
        providerOrder.length === 0 &&
        typeof config.allowFallbacks !== 'boolean' &&
        typeof config.requireParameters !== 'boolean'
    ) {
        return null;
    }

    return {
        ...(providerOrder.length > 0 ? { order: providerOrder } : {}),
        ...(typeof config.allowFallbacks === 'boolean'
            ? { allow_fallbacks: config.allowFallbacks }
            : {}),
        ...(typeof config.requireParameters === 'boolean'
            ? { require_parameters: config.requireParameters }
            : {}),
    };
}

function buildOpenAICompatibleConfig(config, apiKey, defaultName) {
    const openRouterProviderRouting =
        config.provider === 'openrouter'
            ? buildOpenRouterProviderRouting(config)
            : null;

    return {
        name: config.providerName || defaultName,
        apiKey,
        baseURL:
            config.baseURL ||
            (config.provider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                : undefined),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.queryParams ? { queryParams: config.queryParams } : {}),
        ...(openRouterProviderRouting
            ? {
                  transformRequestBody: (body) => ({
                      ...body,
                      provider: {
                          ...(body.provider || {}),
                          ...openRouterProviderRouting,
                      },
                  }),
              }
            : {}),
    };
}

async function createModel(config) {
    const provider = config.provider || 'openai';
    const model = config.model;
    const apiKeyEnv = config.apiKeyEnv || defaultApiKeyEnv(provider);
    const apiKey = config.apiKey || process.env[apiKeyEnv];

    if (!model) {
        throw new Error('Missing provider config.model');
    }
    if (!apiKey) {
        throw new Error(`Missing API key for ${provider} in ${apiKeyEnv}`);
    }

    if (provider === 'google') {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey })(model);
    }

    if (provider === 'anthropic') {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({
            apiKey,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        })(model);
    }

    if (provider === 'openai') {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({
            apiKey,
            ...(config.headers ? { headers: config.headers } : {}),
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        })(model);
    }

    if (provider === 'openrouter' || provider === 'openai-compatible') {
        const { createOpenAICompatible } = await import(
            '@ai-sdk/openai-compatible'
        );
        return createOpenAICompatible(
            buildOpenAICompatibleConfig(
                config,
                apiKey,
                provider === 'openrouter' ? 'openrouter' : 'openai-compatible',
            ),
        )(model);
    }

    throw new Error(`Unsupported provider: ${provider}`);
}

function parseCandidateFinding(rawValue) {
    const parsed = parseMaybeJson(rawValue) || {};
    const location = String(parsed.location || '');
    const match = location.match(/^(.*?):(\d+)(?:-(\d+))?$/);
    const relevantFile = parsed.relevantFile || (match ? match[1] : '');
    const relevantLinesStart = parsed.relevantLinesStart
        ? Number(parsed.relevantLinesStart)
        : match
          ? Number(match[2])
          : null;
    const relevantLinesEnd = parsed.relevantLinesEnd
        ? Number(parsed.relevantLinesEnd)
        : match && match[3]
          ? Number(match[3])
          : relevantLinesStart;

    return {
        ...parsed,
        relevantFile,
        relevantLinesStart,
        relevantLinesEnd,
    };
}

function buildEvidenceBundle(caseData) {
    const candidate = parseCandidateFinding(caseData.candidateFinding);
    const relatedFiles = parseMaybeJson(caseData.relatedFiles) || [];
    const matchedGoldens = parseMaybeJson(caseData.matchedGoldenComments) || [];

    return {
        candidate,
        diffSnippet: String(caseData.diffSnippet || ''),
        fileSnippet: String(caseData.fileSnippet || ''),
        investigationSummary: String(caseData.investigationSummary || ''),
        callGraphHint: String(caseData.callGraphHint || ''),
        relatedFiles,
        matchedGoldens,
    };
}

function parseVerificationDecision(text) {
    const rawText = String(text || '').trim();
    if (!rawText) return null;

    const tryParse = (raw) => {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.keep !== 'boolean') return null;
            return {
                keep: parsed.keep,
                rationale: parsed.rationale || '',
                confidence: parsed.confidence || '',
            };
        } catch {
            return null;
        }
    };

    const direct = tryParse(rawText);
    if (direct) return direct;

    const codeBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
        const parsed = tryParse(codeBlockMatch[1].trim());
        if (parsed) return parsed;
    }

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        return tryParse(rawText.slice(firstBrace, lastBrace + 1));
    }

    return null;
}

async function structureVerificationDecisionWithFallbackModel(
    model,
    verificationText,
    index,
) {
    try {
        const result = await generateText({
            model,
            output: Output.object({
                schema: jsonSchema({
                    type: 'object',
                    properties: {
                        index: { type: 'number' },
                        keep: { type: 'boolean' },
                        rationale: { type: 'string' },
                        confidence: {
                            type: 'string',
                            enum: ['high', 'medium', 'low'],
                        },
                    },
                    required: ['keep', 'rationale'],
                }),
            }),
            system: `You are a JSON extraction assistant.

You receive the raw text output of a code-review verifier and must extract only its final verdict.

Rules:
- Recover the verifier's intended keep/drop decision exactly when possible.
- Do not invent a new bug or a new rationale not supported by the text.
- If the text contains uncertainty, keep the rationale faithful to that uncertainty.
- Output only the structured decision object.`,
            prompt: `Extract the verifier verdict from this text:

---
${verificationText}
---

Return:
- index
- keep
- rationale
- confidence (if present)`,
        });

        const output = result.object || result.output;
        const keep =
            typeof output?.keep === 'boolean'
                ? output.keep
                : parseVerificationDecision(result.text || '')?.keep;

        if (typeof keep !== 'boolean') {
            return null;
        }

        return {
            decision: {
                index: typeof output?.index === 'number' ? output.index : index,
                keep,
                rationale:
                    output?.rationale ||
                    parseVerificationDecision(result.text || '')?.rationale ||
                    '',
                confidence:
                    output?.confidence ||
                    parseVerificationDecision(result.text || '')?.confidence ||
                    '',
            },
            usage: result.usage || result.totalUsage || {},
        };
    } catch {
        return null;
    }
}

function buildFrozenEvidenceBundle(caseData, evidence) {
    const { candidate } = evidence;

    return `<Finding index="${caseData.candidateIndex ?? 0}">
File: ${candidate.relevantFile}
Lines: ${candidate.relevantLinesStart ?? 'unknown'}-${candidate.relevantLinesEnd ?? 'unknown'}
Candidate hypothesis (may be wrong):
Summary: ${candidate.oneSentenceSummary || 'N/A'}
${candidate.comment || 'N/A'}

Existing code:
\`\`\`
${truncateText(candidate.existingCode || '', 800)}
\`\`\`

Diff snippet:
\`\`\`diff
${evidence.diffSnippet || 'N/A'}
\`\`\`

File snippet:
\`\`\`
${evidence.fileSnippet || 'N/A'}
\`\`\`

Relevant investigation log:
${evidence.investigationSummary || '- No file-specific tool log found'}

Call graph hints:
\`\`\`text
${evidence.callGraphHint || 'N/A'}
\`\`\`
</Finding>`;
}

function serializeResult(caseId, decision, rawText, usage, parseMode = 'direct') {
    return {
        caseId,
        decision,
        trace: {
            steps: 1,
            finishReason: 'stop',
            parseMode,
            rawTextPreview: truncateText(rawText, 600),
            usage: {
                inputTokens: usage.inputTokens || 0,
                outputTokens: usage.outputTokens || 0,
                reasoningTokens: usage.reasoningTokens || 0,
                totalTokens:
                    usage.totalTokens ||
                    (usage.inputTokens || 0) + (usage.outputTokens || 0),
            },
            toolCalls: [],
        },
    };
}

function writeResultArtifact(filename, payload) {
    try {
        fs.writeFileSync(
            path.join(__dirname, 'results', filename),
            JSON.stringify(payload, null, 2),
        );
    } catch {}
}

class PromotionAgentProvider {
    constructor(options) {
        this.config = options.config || {};
        this.providerId =
            this.config.label ||
            `${this.config.provider || 'openai'}:${this.config.model || 'unknown'}`;
    }

    id() {
        return this.providerId;
    }

    async callApi(prompt, context, options) {
        let stage = 'parse-prompt';

        try {
            const rawPrompt =
                typeof prompt === 'string'
                    ? prompt
                    : prompt && typeof prompt === 'object' && 'prompt' in prompt
                      ? prompt.prompt
                      : prompt;
            const caseData = parseMaybeJson(rawPrompt);
            if (!caseData || typeof caseData !== 'object') {
                throw new Error(
                    `Expected prompt loader to provide a JSON object, got ${JSON.stringify(
                        summarizeInput(caseData),
                    )}`,
                );
            }

            if ((caseData.mode || 'verification') !== 'verification') {
                throw new Error(
                    `Unsupported promotion eval mode: ${caseData.mode}. Only "verification" is implemented.`,
                );
            }

            stage = 'create-model';
            const model = await createModel(this.config);

            stage = 'build-evidence';
            const evidence = buildEvidenceBundle(caseData);
            const { system, prompt: userPrompt } = buildVerifierPrompt(
                buildFrozenEvidenceBundle(caseData, evidence),
                Number(caseData.candidateIndex || 0),
            );

            stage = 'generate';
            const result = await generateText({
                model,
                system,
                prompt: userPrompt,
            });

            const rawText = result.text || '';
            stage = 'parse-output';
            let decision = parseVerificationDecision(rawText);
            let parseMode = 'direct';

            if (!decision && rawText.trim()) {
                const fallback = await structureVerificationDecisionWithFallbackModel(
                    model,
                    rawText,
                    Number(caseData.candidateIndex || 0),
                );

                if (fallback?.decision) {
                    decision = fallback.decision;
                    parseMode = 'fallback-llm';
                    result.usage = {
                        inputTokens:
                            (result.usage?.inputTokens || result.totalUsage?.inputTokens || 0) +
                            (fallback.usage?.inputTokens || 0),
                        outputTokens:
                            (result.usage?.outputTokens || result.totalUsage?.outputTokens || 0) +
                            (fallback.usage?.outputTokens || 0),
                        reasoningTokens:
                            (result.usage?.reasoningTokens ||
                                result.totalUsage?.reasoningTokens ||
                                0) + (fallback.usage?.reasoningTokens || 0),
                        totalTokens:
                            ((result.usage?.inputTokens ||
                                result.totalUsage?.inputTokens ||
                                0) +
                                (fallback.usage?.inputTokens || 0)) +
                            ((result.usage?.outputTokens ||
                                result.totalUsage?.outputTokens ||
                                0) +
                                (fallback.usage?.outputTokens || 0)),
                    };
                }
            }

            if (!decision) {
                throw new Error(
                    `Model output was not parseable as verification JSON. Raw output preview: ${truncateText(rawText, 1200)}`,
                );
            }

            stage = 'serialize-result';
            const usage = result.usage || result.totalUsage || {};
            const outputPayload = serializeResult(
                caseData.caseId || 'unknown-case',
                decision,
                rawText,
                usage,
                parseMode,
            );
            writeResultArtifact('last-output.json', outputPayload);

            return {
                output: JSON.stringify(outputPayload),
                tokenUsage: {
                    prompt: usage.inputTokens || 0,
                    completion: usage.outputTokens || 0,
                    total:
                        usage.totalTokens ||
                        (usage.inputTokens || 0) + (usage.outputTokens || 0),
                },
            };
        } catch (error) {
            const payload = {
                error: error instanceof Error ? error.message : String(error),
                metadata: {
                    stage,
                    providerId: this.providerId,
                    prompt: summarizeInput(prompt),
                    context: summarizeInput(context),
                    options: summarizeInput(options),
                    stack:
                        error instanceof Error
                            ? error.stack?.split('\n').slice(0, 20).join('\n')
                            : undefined,
                },
            };
            writeResultArtifact('last-error.json', payload);
            return payload;
        }
    }
}

module.exports = PromotionAgentProvider;
