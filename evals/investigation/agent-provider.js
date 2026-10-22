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

const { resolveRoute, evalPermissionService, NotAProductionRoute } = require('../shared/model-route');
const { reviewPullRequest } = require('../shared/review-stage');
const { filesBetween } = require('../shared/repo-mirror');

// RECALL_CATEGORIES=bug,security: the team's category toggles (reviewOptions),
// for an experiment. Without it the team set none, so production runs all three.
function reviewOptionsFromEnv() {
    const raw = process.env.RECALL_CATEGORIES;
    if (!raw) return undefined;
    const on = new Set(raw.split(',').map((c) => c.trim()).filter(Boolean));
    return { bug: on.has('bug'), security: on.has('security'), performance: on.has('performance') };
}

// What the team set, from the case's data: its language, its memories as a
// member writes them (stored by production's write, shared/review-stage.js
// teamStore), and the review options and prompt overrides it saved. A run's
// `--team-config` (run-recall.js, shared/team-config.js) is saved over the
// case's own keys, as a team saving those keys would: "Use coding-agent
// instructions in reviews" is one of them (evals/repo-instructions/team-config.json).
// The instruction files a case gives are the repository's (prOf), on either way.
function teamOf(caseData, teamConfig = null) {
    const memories = parseMaybeJson(caseData.memoryRules) || [];
    const reviewOptions = reviewOptionsFromEnv();
    const v2PromptOverrides = parseMaybeJson(caseData.v2PromptOverrides);
    const configs = {
        ...(reviewOptions ? { reviewOptions } : {}),
        ...(v2PromptOverrides ? { v2PromptOverrides } : {}),
        ...(caseData.reviewMode ? { reviewMode: caseData.reviewMode } : {}),
        ...(teamConfig || {}),
    };
    return {
        language: caseData.languageResultPrompt || undefined,
        memories: memories.map((m) => ({ title: m.title, rule: m.rule, path: m.path ?? null })),
        codeReviewConfig: Object.keys(configs).length ? { configs, repositories: [] } : null,
    };
}

// The coding-agent instruction files the case's target branch holds, as
// { path: text }: the recorded branch (targetBranchFiles: its instruction
// files and the files they point to, from RECALL_REPO_INSTRUCTIONS), else the
// collected list (the repo-instructions eval's cases). Production's stage
// selects and reads them.
function instructionFilesOf(caseData) {
    const recorded = parseMaybeJson(caseData.targetBranchFiles);
    if (recorded && Object.keys(recorded).length) return recorded;
    const files = parseMaybeJson(caseData.repoInstructions)?.files || [];
    return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

// The PR as the platform returns it: the adapter output recorded for a real PR
// (evals/investigation/fetch-pr-data.js), or, for a repository written for the
// eval (repoFiles over repoBase), what the platform computes between the two.
function prOf(caseData) {
    const repoFiles = parseMaybeJson(caseData.repoFiles);
    const repoBase = parseMaybeJson(caseData.repoBase) || {};
    const files = repoFiles ? filesBetween(repoBase, repoFiles) : parseMaybeJson(caseData.prFiles);
    if (!files) throw new Error(`case ${caseData.caseId} has no prFiles: run evals/investigation/fetch-pr-data.js`);
    return {
        repo: repoFiles ? undefined : caseData.repositoryFullName,
        number: caseData.prNumber ?? undefined,
        title: caseData.prTitle,
        body: caseData.prBody,
        headRef: caseData.prHead?.ref,
        headSha: caseData.prHead?.sha,
        baseRef: caseData.prBase?.ref || caseData.baseBranch || 'main',
        baseSha: caseData.prBase?.sha,
        files,
        commits: parseMaybeJson(caseData.prCommits) || [],
        repoFiles,
        repoBase: repoFiles ? repoBase : undefined,
        targetBranchFiles: instructionFilesOf(caseData),
    };
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
        droppedByVerify: results.flatMap((r) => r.droppedByVerify || []),
        toolCalls: results.flatMap((r) => r.toolCalls || []),
    };
}

// What the verifier refuted, so a missed known bug can be told apart: never
// reported, or reported and refuted.
function refutedFindings(agentResult) {
    return (agentResult.droppedByVerify || []).map((f) => ({
        path: f.relevantFile,
        startLine: f.relevantLinesStart ?? null,
        endLine: f.relevantLinesEnd ?? null,
        description: f.suggestionContent || '',
    }));
}

function agentRunFailure(agentResult) {
    if (!agentResult || typeof agentResult !== 'object') return 'agent loop returned no result';
    const finishReason = agentResult.finishReason || 'unknown';
    const totalTokens = Number(agentResult.usage?.totalTokens || 0);
    const steps = Number(agentResult.steps || 0);
    const trace = Array.isArray(agentResult.debugTrace) ? agentResult.debugTrace : [];
    const errorEvent = [...trace].reverse().find((event) => event && event.kind === 'error');
    const errorMessage = errorEvent?.detail && typeof errorEvent.detail.message === 'string' ? errorEvent.detail.message : '';
    if (finishReason === 'error') {
        return errorMessage ? `agent loop finished with error: ${errorMessage}` : 'agent loop finished with error';
    }
    if (steps === 0 && totalTokens === 0) return 'agent loop produced zero steps and zero tokens';
    return null;
}

function writeResultArtifact(filename, payload) {
    try {
        fs.writeFileSync(path.join(__dirname, 'results', filename), JSON.stringify(payload, null, 2));
    } catch {}
}

class InvestigationAgentProvider {
    constructor(options) {
        this.config = options.config || {};
        this.teamConfig = options.teamConfig || null;
        this.providerId = this.config.label || `${this.config.provider || 'google'}:${this.config.model || 'unknown'}`;
    }

    id() {
        return this.providerId;
    }

    async callApi(prompt, context, options) {
        let stage = 'parse-prompt';
        try {
            const rawPrompt = typeof prompt === 'string' ? prompt : prompt && typeof prompt === 'object' && 'prompt' in prompt ? prompt.prompt : prompt;
            const caseData = parseMaybeJson(rawPrompt);
            if (!caseData || typeof caseData !== 'object') {
                throw new Error(`Expected prompt loader to provide a JSON object, got ${JSON.stringify(summarizeInput(caseData))}`);
            }

            stage = 'resolve-model';
            const route = resolveRoute(this.config);
            const permissionService = evalPermissionService(route.storedConfig);

            stage = 'run-review';
            const review = await reviewPullRequest({ pr: prOf(caseData), team: teamOf(caseData, this.teamConfig), route, permissionService });
            if (review.skipped) throw new Error(`production skipped the review: ${review.skipped}`);
            // The stage records a failed agent or step and goes on with what it has:
            // a review that failed measured the failure, not the finder.
            const failure = review.context?.lastReviewError;
            if (failure) throw new Error(`production review failed: ${failure.category} ${String(failure.providerMessage || failure.friendlyMessage || '').slice(0, 200)}`);
            const failedAgents = (review.context?.errors || []).filter((e) => /agent|review/i.test(String(e?.stage || e?.message || '')));
            if (!review.loops.length) {
                throw new Error(
                    `production ran no finder loop the eval could observe${failedAgents.length ? `: ${failedAgents.map((e) => e.message).join('; ').slice(0, 300)}` : ''}`,
                );
            }
            // A review with every loop failed measured nothing, whatever production made of it.
            const loopFailures = review.loops.map((l) => agentRunFailure(l.result));
            if (loopFailures.every(Boolean)) {
                const r = review.loops[0].result;
                throw new Error(`${loopFailures[0]} (finishReason=${r?.finishReason || 'unknown'}, steps=${r?.steps ?? 'n/a'}, tokens=${r?.usage?.totalTokens ?? 'n/a'})`);
            }
            const agentResult = combineLoops(review.loops.filter((_, i) => !loopFailures[i]));

            stage = 'serialize-result';
            const first = review.loops[0].params;
            const output = {
                caseId: caseData.caseId || 'unknown-case',
                reasoning: agentResult.findings?.reasoning || '',
                // What the stage ships: after the mapper, anchoring, repeat drop,
                // dedup, severity and the formatter. The gated metric scores these.
                findings: review.shipped,
                // What the finder's loops returned, before those steps: reported next to it.
                loopFindings: agentResult.findings?.suggestions || [],
                discarded: review.discarded.map((d) => ({ relevantFile: d.relevantFile, relevantLinesStart: d.relevantLinesStart, priorityStatus: d.priorityStatus })),
                trace: {
                    steps: agentResult.steps,
                    finishReason: agentResult.finishReason,
                    source: agentResult.source,
                    usage: agentResult.usage,
                    coverage: agentResult.coverage,
                    anomalies: agentResult.anomalies,
                    verification: agentResult.verification,
                    droppedByVerify: refutedFindings(agentResult),
                    toolCalls: (agentResult.toolCalls || []).map((call) => ({ tool: call.toolName || call.tool, args: call.args || {} })),
                    production: {
                        route: route.route,
                        model: first.modelName ?? null,
                        reasoningEffort: first.reasoningEffort ?? null,
                        contextWindowTokens: first.contextWindowTokens ?? null,
                        prFiles: review.context.changedFiles?.length ?? null,
                        batches: review.loops.map((l) => ({
                            files: l.params.changedFiles?.length ?? null,
                            tiered: !!l.params.fileTiers,
                            maxSteps: l.params.maxSteps ?? null,
                            steps: l.result?.steps ?? null,
                        })),
                        failedBatches: loopFailures.filter(Boolean),
                    },
                },
            };
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
                error: error instanceof Error ? error.message : String(error),
                metadata: {
                    stage,
                    providerId: this.providerId,
                    prompt: summarizeInput(prompt),
                    context: summarizeInput(context),
                    options: summarizeInput(options),
                    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 20).join('\n') : undefined,
                },
            };
            try {
                fs.writeFileSync(path.join(__dirname, 'results', 'last-error.json'), JSON.stringify(payload, null, 2));
            } catch {}
            return { ...payload };
        }
    }
}

module.exports = InvestigationAgentProvider;
// For the specs: how a case reaches production's review.
module.exports.internals = { resolveRoute, evalPermissionService, reviewOptionsFromEnv, combineLoops, refutedFindings, teamOf, prOf, NotAProductionRoute };
