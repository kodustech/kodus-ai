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

// The PR's changed files as the dataset recorded them: the whole diff
// (changedFilesFull, rendered by production's chain in materialize-full-diff.js)
// or the corpus's first, partial field. Passed through: filename, status,
// additions and deletions are the platform's, never recomputed. The datasets
// carry no raw patch; production's only reader of `patch` on this path (the
// coverage ledger's changed ranges) reads the hunk headers, which the rendered
// patchWithLinesStr keeps, so it stands in for the patch a file does not carry.
function changedFilesOf(caseData) {
    const files = parseMaybeJson(caseData.changedFilesFull) || parseMaybeJson(caseData.changedFiles) || [];
    return files.map((file) => (file.patch ? file : { ...file, patch: file.patchWithLinesStr }));
}

const { resolveRoute, evalPermissionService, NotAProductionRoute, EVAL_ORG } = require('../shared/model-route');

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

// ── What production's loop receives and returns, observed ─────────────────────
// The review runs as production runs it (reviewAsProduction): the eval does not
// rebuild any of it. To score the finder's own findings (before the mapper,
// which evals/parse measures) it observes production's loop entry,
// runAgentLoopViaCore, which BaseCodeReviewAgentProvider.execute calls once per
// review (once per batch when it splits the PR): the wrapper records the call's
// parameters and result and returns that result untouched.
const { AsyncLocalStorage } = require('async_hooks');
const observedLoops = new AsyncLocalStorage();
let loopObserved = false;
function observeTheLoop() {
    if (loopObserved) return;
    const adapterPath = require.resolve(
        path.join(__dirname, '../../libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts'),
    );
    const real = require(adapterPath);
    require.cache[adapterPath].exports = {
        ...real,
        runAgentLoopViaCore: async (params, secrets) => {
            const result = await real.runAgentLoopViaCore(params, secrets);
            observedLoops.getStore()?.push({ params, result });
            return result;
        },
    };
    loopObserved = true;
}

// RECALL_CATEGORIES=bug,security: the team's category toggles (reviewOptions),
// for an experiment. Without it the team set none, so production runs all three.
function reviewOptionsFromEnv() {
    const raw = process.env.RECALL_CATEGORIES;
    if (!raw) return undefined;
    const on = new Set(raw.split(',').map((c) => c.trim()).filter(Boolean));
    return { bug: on.has('bug'), security: on.has('security'), performance: on.has('performance') };
}

/**
 * One review of the case's PR through production's own path: the review
 * config the team stores (from the dataset) routed by ValidateConfigStage's
 * routeCodeReviewModel, AgentReviewStage's resolveAgentReviewSettings, the
 * stage's buildOrchestratorInput, and ReviewOrchestratorService.execute running
 * the generalist. The eval supplies only data: the stored config, the PR, the
 * changed files and the tools' answers (remoteCommands). Returns the
 * orchestrator's output and every loop production ran, observed.
 */
async function reviewAsProduction(caseData, route, permissionService, remoteCommands, sandboxType) {
    const lib = (p) => require(path.join(__dirname, '../../libs', p));
    observeTheLoop();
    const { ReviewOrchestratorService } = lib('code-review/infrastructure/agents/review-orchestrator.service.ts');
    const { GeneralistAgentProvider } = lib('code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
    const { BugAgentProvider } = lib('code-review/infrastructure/agents/providers/bug-agent.provider.ts');
    const { SecurityAgentProvider } = lib('code-review/infrastructure/agents/providers/security-agent.provider.ts');
    const { PerformanceAgentProvider } = lib('code-review/infrastructure/agents/providers/performance-agent.provider.ts');
    const { buildOrchestratorInput } = lib('code-review/pipeline/stages/build-orchestrator-input.ts');
    const { routeCodeReviewModel } = lib('code-review/pipeline/stages/route-code-review-model.ts');
    const { resolveAgentReviewSettings } = lib('code-review/pipeline/stages/agent-review-settings.ts');

    // The review config the team stores (the dataset's), then the model
    // ValidateConfigStage routes for it into the same two fields it writes.
    const reviewOptions = reviewOptionsFromEnv();
    const codeReviewConfig = {
        languageResultPrompt: caseData.languageResultPrompt,
        kodyMemoryRules: parseMaybeJson(caseData.memoryRules),
        v2PromptOverrides: parseMaybeJson(caseData.v2PromptOverrides),
        reviewMode: caseData.reviewMode,
        ...(reviewOptions ? { reviewOptions } : {}),
    };
    const { resolvedModelSlot } = routeCodeReviewModel(route.storedConfig, codeReviewConfig);
    codeReviewConfig.resolvedModelSlot = resolvedModelSlot;
    codeReviewConfig.byokConfig = resolvedModelSlot;

    // The pipeline context the agent stage reads, from the case's data.
    const baseBranch = caseData.baseBranch || 'main';
    const context = {
        organizationAndTeamData: EVAL_ORG,
        codeReviewConfig,
        pullRequest: { number: caseData.prNumber || 1, title: caseData.prTitle, body: caseData.prBody, base: { ref: baseBranch } },
        repository: { fullName: caseData.repositoryFullName || 'eval/repo', defaultBranch: baseBranch },
        sandboxHandle: { type: sandboxType, remoteCommands, baseBranch },
        traceDecisions: parseMaybeJson(caseData.traceDecisions) || undefined,
    };
    const settings = resolveAgentReviewSettings(codeReviewConfig);
    const input = buildOrchestratorInput(context, {
        changedFiles: changedFilesOf(caseData),
        prNumber: context.pullRequest.number,
        repositoryId: caseData.repositoryId,
        reviewOptions: settings.reviewOptions,
        // No call graph: the stage builds one from the repository's AST graph
        // (GraphContextService), which the datasets do not carry; it starts as
        // '' and stays so when none is built.
        callGraph: '',
        adaptiveProfile: settings.adaptiveProfile,
        // RECALL_HEAVY=1: the review asks for heavy mode (the stage then checks
        // its release gate; the eval asks for it directly).
        heavy: process.env.RECALL_HEAVY === '1',
    });

    const agent = (Provider) => new Provider(permissionService, {}, undefined, undefined);
    // No Kody Rules agent: the finder eval measures the generalist alone.
    const orchestrator = new ReviewOrchestratorService(
        agent(BugAgentProvider),
        agent(SecurityAgentProvider),
        agent(PerformanceAgentProvider),
        agent(GeneralistAgentProvider),
    );
    const loops = [];
    const output = await observedLoops.run(loops, () => orchestrator.execute(input));
    return { output, loops, input, settings };
}

// The loops of one review as one row: one loop, or one per batch in the order
// production ran them, findings concatenated and counts summed. An account of
// what was observed, not a step of the review.
function combineLoops(loops) {
    const results = loops.map((l) => l.result);
    if (results.length === 1) return results[0];
    const sum = (key) => results.reduce((n, r) => n + Number(r.usage?.[key] || 0), 0);
    return {
        findings: {
            reasoning: results.map((r) => r.findings?.reasoning || '').filter(Boolean).join('\n\n'),
            suggestions: results.flatMap((r) => r.findings?.suggestions || []),
        },
        steps: results.reduce((n, r) => n + Number(r.steps || 0), 0),
        finishReason: results[results.length - 1]?.finishReason,
        source: results.map((r) => r.source).join(','),
        usage: {
            inputTokens: sum('inputTokens'),
            outputTokens: sum('outputTokens'),
            totalTokens: sum('totalTokens'),
            reasoningTokens: sum('reasoningTokens'),
            cacheReadTokens: sum('cacheReadTokens'),
            cacheWriteTokens: sum('cacheWriteTokens'),
        },
        coverage: results.map((r) => r.coverage),
        anomalies: results.map((r) => r.anomalies),
        verification: results.map((r) => r.verification),
        toolCalls: results.flatMap((r) => r.toolCalls || []),
    };
}

// The grep, read and listDir production's local sandbox (the self-hosted path)
// hands the agent, over a prepared worktree: the same output and the same
// errors for those three. Built by the sandbox's own method, so they cannot
// drift from production. exec is left out for now, as in the replay, so the
// exec-gated tools (checkTypes, findNearestProjectFile, findFile's fd/find
// path) are not registered: a smaller tool set than production's, recorded as
// `sandboxExec` in each row. Wrapped only to count calls for the fidelity
// metric: a real answer, empty or not, is never an unserved call.
function sandboxCommands(repoDir) {
    const { LocalSandboxService } = require(
        path.join(
            __dirname,
            '../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts',
        ),
    );
    // buildRemoteCommands is private in TypeScript; it reads no instance
    // state, and the constructor ignores its ConfigService.
    const inner = new LocalSandboxService(undefined).buildRemoteCommands(
        repoDir,
    );
    const commands = { calls: [], unexpectedCalls: [] };
    for (const name of ['grep', 'read', 'listDir']) {
        const fn = inner[name];
        const kind = name === 'read' ? 'readFile' : name;
        commands[name] = (...args) => {
            commands.calls.push({ kind, actual: args, matched: true });
            return fn(...args);
        };
    }
    return commands;
}

// The files of an inline repository, written to a fresh directory. Same
// handle shape as prepareRepo's; there is no commit to name.
function writeInlineRepo(files) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eval-inline-repo-'));
    // The caller only cleans a handle it got back: a throw here removes the
    // directory itself.
    try {
        for (const [file, content] of Object.entries(files || {})) {
            const target = path.join(dir, file);
            if (!target.startsWith(dir + path.sep)) throw new Error(`repoFiles path escapes the repository: ${file}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(content));
        }
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return { dir, sha: null, cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function serializeResult(caseId, agentResult, remoteCommands, repoHandle, production) {
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
            // Total calls the replay actually fielded (served + unserved) — the
            // correct denominator for the replay hit-rate. The agent's toolCalls
            // array undercounts (no retries/internal reads), so don't use it.
            replayCalls: Array.isArray(remoteCommands.calls)
                ? remoteCommands.calls.length
                : null,
            repoPrepared: !!repoHandle,
            headSha: repoHandle ? repoHandle.sha : null,
            // false: the exec-gated tools were not registered for this case.
            sandboxExec: typeof remoteCommands.exec === 'function',
            // How production ran this review: its model route and model, the
            // window, the files it got, and each batch (one unless split).
            production: production || null,
        },
    };
}

function agentRunFailure(agentResult) {
    if (!agentResult || typeof agentResult !== 'object') {
        return 'agent loop returned no result';
    }

    const finishReason = agentResult.finishReason || 'unknown';
    const usage = agentResult.usage || {};
    const totalTokens = Number(usage.totalTokens || 0);
    const steps = Number(agentResult.steps || 0);
    const trace = Array.isArray(agentResult.debugTrace)
        ? agentResult.debugTrace
        : [];
    const errorEvent = [...trace]
        .reverse()
        .find((event) => event && event.kind === 'error');
    const errorMessage =
        errorEvent?.detail && typeof errorEvent.detail.message === 'string'
            ? errorEvent.detail.message
            : '';

    if (finishReason === 'error') {
        return errorMessage
            ? `agent loop finished with error: ${errorMessage}`
            : 'agent loop finished with error';
    }

    if (steps === 0 && totalTokens === 0) {
        return 'agent loop produced zero steps and zero tokens';
    }

    return null;
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
        // Declared outside the try so the finally below can always release it.
        let repoHandle = null;
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

            stage = 'resolve-model';
            const route = resolveRoute(this.config);
            const permissionService = evalPermissionService(route.storedConfig);
            stage = 'build-replay-commands';
            // RECALL_REAL_REPO=1: answer the tools from a git worktree at the
            // PR's head instead of replaying recorded tool calls. The replay
            // only answers calls captured when the dataset was built; any other
            // call gets an empty answer the real repository would not give.
            // Falls back to replay when the commit can't be fetched;
            // `repoPrepared` in the trace says which one ran.
            let remoteCommands;
            // A case written for an eval can carry its repository inline
            // (`repoFiles`: every file at the PR's head): the tools then answer
            // from it through the same local sandbox, never from a replay.
            if (caseData.repoFiles) {
                repoHandle = writeInlineRepo(parseMaybeJson(caseData.repoFiles));
                remoteCommands = sandboxCommands(repoHandle.dir);
            } else if (process.env.RECALL_REAL_REPO === '1') {
                const { prepareRepo } = require('./prepare-repo');
                repoHandle = await prepareRepo(caseData, caseData.caseId);
                if (repoHandle) remoteCommands = sandboxCommands(repoHandle.dir);
            }
            const sandboxType = remoteCommands ? 'local' : 'replay';
            if (!remoteCommands) {
                remoteCommands = new ReplayRemoteCommands(
                    parseMaybeJson(caseData.toolReplay) || {},
                );
            }

            stage = 'run-review';
            const { output: review, loops, settings } = await reviewAsProduction(
                caseData,
                route,
                permissionService,
                remoteCommands,
                sandboxType,
            );
            // Production's own account of a failed agent (the orchestrator
            // records a thrown run as a failure).
            if (review.failures?.length) {
                throw new Error(
                    `the finder failed: ${review.failures.map((f) => `${f.agentName}: ${f.error?.message || f.error}`).join('; ').slice(0, 400)}`,
                );
            }
            if (!loops.length) {
                throw new Error('production ran no finder loop the eval could observe (the loop observer is not attached)');
            }
            // A review with every loop failed measured nothing, whatever
            // production made of it.
            const loopFailures = loops.map((l) => agentRunFailure(l.result));
            if (loopFailures.every(Boolean)) {
                const r = loops[0].result;
                throw new Error(
                    `${loopFailures[0]} (finishReason=${r?.finishReason || 'unknown'}, ` +
                        `steps=${r?.steps ?? 'n/a'}, ` +
                        `tokens=${r?.usage?.totalTokens ?? 'n/a'})`,
                );
            }
            const agentResult = combineLoops(loops.filter((_, i) => !loopFailures[i]));

            stage = 'serialize-result';
            const first = loops[0].params;
            const output = serializeResult(
                caseData.caseId || 'unknown-case',
                agentResult,
                remoteCommands,
                repoHandle,
                {
                    route: route.route,
                    model: first.modelName ?? null,
                    reasoningEffort: first.reasoningEffort ?? null,
                    contextWindowTokens: first.contextWindowTokens ?? null,
                    prFiles: changedFilesOf(caseData).length,
                    fullDiff: !!parseMaybeJson(caseData.changedFilesFull),
                    categories: Object.entries(settings.reviewOptions)
                        .filter(([, on]) => on !== false)
                        .map(([category]) => category),
                    batches: loops.map((l) => ({
                        files: l.params.changedFiles?.length ?? null,
                        tiered: !!l.params.fileTiers,
                        maxSteps: l.params.maxSteps ?? null,
                        steps: l.result?.steps ?? null,
                    })),
                    failedBatches: loopFailures.filter(Boolean),
                },
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
        } finally {
            // Always drop the worktree: cases run in parallel and each one adds
            // a full checkout to disk.
            if (repoHandle) {
                try {
                    await repoHandle.cleanup();
                } catch {}
            }
        }
    }
}

module.exports = InvestigationAgentProvider;
// For the specs: how a case reaches production's loop.
module.exports.internals = { resolveRoute, evalPermissionService, changedFilesOf, reviewOptionsFromEnv, combineLoops, NotAProductionRoute };
// The dataset's recorded tools, for evals that run a part of the finder on the same PR (evals/funnel/verify).
module.exports.ReplayRemoteCommands = ReplayRemoteCommands;
