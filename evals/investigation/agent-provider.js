require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

// The current review stack imports BYOK helpers that eagerly load the crypto util.
// The investigation eval does not decrypt org secrets, so a deterministic dummy
// key is enough to let those modules load without requiring full app runtime env.
if (!process.env.API_CRYPTO_KEY) {
    process.env.API_CRYPTO_KEY = '0'.repeat(64);
}

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

function normalizePath(value) {
    return String(value || '')
        .replace(/^\/+/, '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
}

function normalizeChangedFiles(files) {
    return (files || []).map((file) => ({
        filename: normalizePath(file.filename || file.path || file.filePath),
        patchWithLinesStr:
            file.patchWithLinesStr || file.patch || file.diff || '',
        patch: file.patch || file.patchWithLinesStr || file.diff || '',
    }));
}

function normalizeRequestedCategories(value) {
    const parsed = parseMaybeJson(value);

    if (Array.isArray(parsed)) {
        return parsed.filter(Boolean).map(String);
    }

    if (typeof parsed === 'string' && parsed.trim()) {
        return [parsed.trim()];
    }

    return undefined;
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
    const provider = config.provider || 'google';
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

function fixtureMatches(match, actual) {
    return Object.entries(match || {}).every(([key, expectedValue]) => {
        if (expectedValue === undefined || expectedValue === null) return true;

        if (key === 'pathEndsWith') {
            return normalizePath(actual.path).endsWith(normalizePath(expectedValue));
        }

        if (key === 'patternIncludes') {
            return String(actual.pattern || '').includes(String(expectedValue));
        }

        const actualValue = actual[key];
        if (key.toLowerCase().includes('path')) {
            return normalizePath(expectedValue) === normalizePath(actualValue);
        }
        return expectedValue === actualValue;
    });
}

class ReplayRemoteCommands {
    constructor(replay) {
        this.replay = replay || {};
        this.calls = [];
        this.unexpectedCalls = [];
        this.readFileCorpus = Array.isArray(this.replay.readFile)
            ? this.replay.readFile
                  .map((entry) => ({
                      path: normalizePath(entry?.match?.path),
                      content: String(entry?.result || ''),
                  }))
                  .filter((entry) => entry.path && entry.content)
            : [];
    }

    _findFixture(kind, actual) {
        const entries = this.replay[kind] || [];
        return (
            entries.find((entry) =>
                fixtureMatches(entry.match || {}, actual),
            ) || null
        );
    }

    _recordCall(kind, actual, matched) {
        this.calls.push({ kind, actual, matched });
        if (!matched) {
            this.unexpectedCalls.push({ kind, actual });
        }
    }

    _lookup(kind, actual) {
        const match = this._findFixture(kind, actual);
        this._recordCall(kind, actual, !!match);
        if (!match) {
            return null;
        }

        return match.result || '';
    }

    _matchesPathScope(filePath, searchPath) {
        const normalizedFilePath = normalizePath(filePath);
        const normalizedSearchPath = normalizePath(searchPath || '.');

        if (!normalizedSearchPath || normalizedSearchPath === '.') return true;
        return (
            normalizedFilePath === normalizedSearchPath ||
            normalizedFilePath.startsWith(`${normalizedSearchPath}/`)
        );
    }

    _matchesGlob(filePath, glob) {
        if (!glob) return true;
        const normalizedFilePath = normalizePath(filePath);

        if (/^\*\.[^*]+$/.test(glob)) {
            return normalizedFilePath.endsWith(glob.slice(1));
        }

        return true;
    }

    _compilePattern(pattern) {
        try {
            return new RegExp(String(pattern || ''));
        } catch {
            const escaped = String(pattern || '').replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            return new RegExp(escaped);
        }
    }

    _searchReadFileCorpus(actual) {
        const regex = this._compilePattern(actual.pattern);
        const matches = [];

        for (const entry of this.readFileCorpus) {
            if (!this._matchesPathScope(entry.path, actual.path)) continue;
            if (!this._matchesGlob(entry.path, actual.glob)) continue;

            const lines = entry.content.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                regex.lastIndex = 0;
                if (!regex.test(line)) continue;

                matches.push(`${entry.path}:${index + 1}:${line}`);
                if (matches.length >= 40) {
                    return matches.join('\n');
                }
            }
        }

        return matches.length ? matches.join('\n') : null;
    }

    async grep(pattern, searchPath, glob) {
        const actual = {
            pattern: pattern || '',
            path: normalizePath(searchPath || '.'),
            glob: glob || '',
        };

        const fixture = this._findFixture('grep', actual);
        if (fixture) {
            this._recordCall('grep', actual, true);
            return fixture.result || '';
        }

        const synthesized = this._searchReadFileCorpus(actual);
        if (synthesized !== null) {
            this.calls.push({
                kind: 'grep',
                actual,
                matched: 'synthetic-readfile-corpus',
            });
            return synthesized;
        }

        this._recordCall('grep', actual, false);
        return 'No matches found.';
    }

    async read(filePath, start, end) {
        const actual = {
            path: normalizePath(filePath),
            startLine: start || 0,
            endLine: end || 0,
        };
        const result = this._lookup('readFile', actual);
        if (result !== null) return result;
        return `No replay fixture matched readFile(${actual.path}, ${actual.startLine}, ${actual.endLine}).`;
    }

    async listDir(dirPath, maxDepth) {
        const actual = {
            path: normalizePath(dirPath || '.'),
            maxDepth: maxDepth || 2,
        };
        const exact = this._findFixture('listDir', actual);
        if (exact) {
            this._recordCall('listDir', actual, true);
            return exact.result || '';
        }

        const relaxed = (this.replay.listDir || []).find(
            (entry) =>
                normalizePath(entry?.match?.path || '.') === actual.path,
        );
        if (relaxed) {
            this.calls.push({
                kind: 'listDir',
                actual,
                matched: 'relaxed-path-only',
            });
            return relaxed.result || '';
        }

        this._recordCall('listDir', actual, false);
        return '';
    }
}

function buildCurrentPrompts(caseData) {
    const { GeneralistAgentProvider } = require(
        path.join(
            __dirname,
            '../../libs/code-review/infrastructure/agents/generalist-agent.provider.ts',
        ),
    );

    const provider = new GeneralistAgentProvider({}, {}, {});
    const input = {
        organizationAndTeamData: {
            organizationId: 'eval-org',
            teamId: 'eval-team',
        },
        changedFiles: normalizeChangedFiles(parseMaybeJson(caseData.changedFiles)),
        remoteCommands: {},
        prNumber: caseData.prNumber || 1,
        repositoryFullName: caseData.repositoryFullName || 'eval/repo',
        languageResultPrompt: caseData.languageResultPrompt || '',
        memoryRules: parseMaybeJson(caseData.memoryRules) || [],
        v2PromptOverrides: parseMaybeJson(caseData.v2PromptOverrides),
        generationMain: caseData.generationMain,
        prTitle: caseData.prTitle,
        prBody: caseData.prBody,
        reviewMode: caseData.reviewMode || 'normal',
        maxSteps: caseData.maxSteps || 12,
        requestedCategories:
            normalizeRequestedCategories(caseData.requestedCategories),
        callGraph: parseMaybeJson(caseData.callGraph),
        baseBranch: caseData.baseBranch || 'main',
    };

    return {
        input,
        systemPrompt: provider.buildSystemPrompt(input),
        userPrompt: provider.buildUserPrompt(input),
    };
}

function serializeResult(caseId, agentResult, remoteCommands) {
    return {
        caseId,
        reasoning: agentResult.findings?.reasoning || '',
        findings: agentResult.findings?.suggestions || [],
        trace: {
            steps: agentResult.steps,
            finishReason: agentResult.finishReason,
            source: agentResult.source,
            usage: agentResult.usage,
            coverage: agentResult.coverage,
            anomalies: agentResult.anomalies,
            verification: agentResult.verification,
            toolCalls: (agentResult.toolCalls || []).map((call) => ({
                tool: call.toolName || call.tool,
                args: call.args || {},
            })),
            unexpectedToolCalls: remoteCommands.unexpectedCalls,
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

class InvestigationAgentProvider {
    constructor(options) {
        this.config = options.config || {};
        this.providerId =
            this.config.label ||
            `${this.config.provider || 'google'}:${this.config.model || 'unknown'}`;
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

            stage = 'load-agent-loop';
            const { runAgentLoop } = require(
                path.join(
                    __dirname,
                    '../../libs/code-review/infrastructure/agents/llm/agent-loop.ts',
                ),
            );

            stage = 'create-model';
            const model = await createModel(this.config);
            stage = 'build-prompts';
            const { input, systemPrompt, userPrompt } =
                buildCurrentPrompts(caseData);
            stage = 'build-replay-commands';
            const remoteCommands = new ReplayRemoteCommands(
                parseMaybeJson(caseData.toolReplay) || {},
            );

            stage = 'run-agent-loop';
            const agentResult = await runAgentLoop({
                model,
                systemPrompt,
                userPrompt,
                remoteCommands,
                changedFiles: input.changedFiles,
                prNumber: input.prNumber,
                repositoryFullName: input.repositoryFullName,
                baseBranch: input.baseBranch,
                reviewMode: input.reviewMode,
                maxSteps: input.maxSteps,
                agentName: `investigation-eval:${this.providerId}`,
            });

            stage = 'serialize-result';
            const output = serializeResult(
                caseData.caseId || 'unknown-case',
                agentResult,
                remoteCommands,
            );
            writeResultArtifact('last-output.json', output);

            return {
                output: JSON.stringify(output),
                tokenUsage: {
                    prompt: agentResult.usage.inputTokens,
                    completion: agentResult.usage.outputTokens,
                    total: agentResult.usage.totalTokens,
                },
            };
        } catch (error) {
            const payload = {
                error:
                    error instanceof Error ? error.message : String(error),
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
            try {
                fs.writeFileSync(
                    path.join(__dirname, 'results', 'last-error.json'),
                    JSON.stringify(payload, null, 2),
                );
            } catch {}

            return {
                ...payload,
            };
        }
    }
}

module.exports = InvestigationAgentProvider;
