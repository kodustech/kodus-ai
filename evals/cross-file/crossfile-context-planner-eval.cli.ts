#!/usr/bin/env npx ts-node

/**
 * LangSmith eval runner for the cross-file context **planner** prompt.
 *
 * Evaluates how well the planner identifies impactful symbols and generates
 * appropriate ripgrep search queries given a PR diff.
 *
 * Usage:
 *   npx ts-node evals/cross-file/crossfile-context-planner-eval.cli.ts --env=.env.prod
 *   npx ts-node evals/cross-file/crossfile-context-planner-eval.cli.ts --max-concurrency=4 --experiment-prefix=planner
 *   npx ts-node evals/cross-file/crossfile-context-planner-eval.cli.ts --inspect
 *
 * Datasets should contain examples with:
 *   Input:  { changedFiles: FileChange[] (with diffs), changedFilenames: string[] }
 *   Output: { expectedSymbols: string[], expectedUpstreamSymbols?: string[], expectedRiskLevels: Record<string, string>, knownConsumerFiles?: string[] }
 */

import * as dotenv from 'dotenv';
import { Client } from 'langsmith';
import {
    evaluate,
    type EvaluatorT,
    type EvaluationResult,
} from 'langsmith/evaluation';
import { Logger } from '@nestjs/common';
import {
    BYOKProviderService,
    LLMModelProvider,
    LLMProviderService,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import {
    CrossFileContextPlannerPayload,
    CrossFileContextPlannerSchema,
    CrossFileContextPlannerSchemaType,
    prompt_cross_file_context_planner,
} from '../../libs/common/utils/langchainCommon/prompts/codeReviewCrossFileContextPlanner';

// ─── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith('--env='));
const maxConcurrencyArg = args.find((a) =>
    a.startsWith('--max-concurrency='),
);
const experimentPrefixArg = args.find((a) =>
    a.startsWith('--experiment-prefix='),
);
const datasetIdArg = args.find((a) => a.startsWith('--dataset='));
const inspectOnly = args.includes('--inspect');
const inspectFull = args.includes('--inspect-full');

const envPath =
    envArg ? envArg.split('=')[1] : process.env.DOTENV_CONFIG_PATH;
if (envPath) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LANGUAGE = 'en-US';
const RUN_NAME = 'crossFileContextPlanner';

/**
 * Default dataset ID — replace with your LangSmith dataset UUID once created.
 * Create the dataset with examples following the schema described in the header.
 */
const DEFAULT_DATASET_ID =
    process.env.EVAL_PLANNER_DATASET_ID ?? 'REPLACE_WITH_DATASET_UUID';

const datasetId = datasetIdArg
    ? datasetIdArg.split('=')[1]
    : DEFAULT_DATASET_ID;

const parsedConcurrency = maxConcurrencyArg
    ? Number(maxConcurrencyArg.split('=')[1])
    : NaN;
const maxConcurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
        ? parsedConcurrency
        : 2;

const experimentPrefix = experimentPrefixArg
    ? experimentPrefixArg.split('=')[1]
    : 'planner-eval';

// ─── Validation ────────────────────────────────────────────────────────────────

const missingEnv: string[] = [];
if (!process.env.LANGCHAIN_API_KEY && !process.env.LANGSMITH_API_KEY) {
    missingEnv.push('LANGCHAIN_API_KEY (or LANGSMITH_API_KEY)');
}
if (!process.env.API_GOOGLE_AI_API_KEY) {
    missingEnv.push('API_GOOGLE_AI_API_KEY');
}
if (missingEnv.length > 0) {
    throw new Error(
        `Missing required environment variables: ${missingEnv.join(', ')}`,
    );
}

// ─── Services ──────────────────────────────────────────────────────────────────

const logger = new Logger('LangSmithPlannerEval');
const byokProviderService = new BYOKProviderService();
const llmProviderService = new LLMProviderService(
    logger,
    byokProviderService,
);
const promptRunnerService = new PromptRunnerService(
    logger,
    llmProviderService,
);
const client = new Client();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildDiffSummary(
    rawInputs: Record<string, unknown>,
): { diffSummary: string; changedFilenames: string[] } {
    const changedFiles = (rawInputs.changedFiles ??
        rawInputs.files ??
        []) as Array<Record<string, unknown>>;
    const changedFilenames = (rawInputs.changedFilenames ??
        changedFiles.map(
            (f) => f.filename ?? f.fileName ?? 'unknown',
        )) as string[];

    const diffItems = changedFiles.map((f) => {
        const filename =
            f.filename ?? f.fileName ?? f.path ?? 'unknown';
        const diff =
            f.patchWithLinesStr ??
            f.patch ??
            f.diff ??
            f.codeDiff ??
            '';
        const truncated =
            String(diff).length > 2000
                ? String(diff).substring(0, 2000) + '\n... (truncated)'
                : String(diff);
        return `### ${filename}\n${truncated}`;
    });

    return {
        diffSummary: diffItems.join('\n\n'),
        changedFilenames: changedFilenames.map(String),
    };
}

type PlannerQuery = CrossFileContextPlannerSchemaType['queries'][number];

// ─── Evaluators ────────────────────────────────────────────────────────────────

/**
 * Symbol Coverage: % of expectedSymbols found in generated queries.
 * Target: >= 70%
 */
function symbolCoverageEvaluator(args: {
    outputs?: Record<string, unknown>;
    referenceOutputs?: Record<string, unknown>;
}): EvaluationResult {
    const queries = ((args.outputs?.queries ?? []) as PlannerQuery[]);
    const expected = ((args.referenceOutputs?.expectedSymbols ?? []) as string[]);

    if (expected.length === 0) {
        return { key: 'symbol_coverage', score: 1.0, comment: 'No expected symbols defined.' };
    }

    const queriedSymbols = new Set(
        queries
            .map((q) => q.symbolName?.toLowerCase())
            .filter(Boolean),
    );
    const queryPatterns = queries.map((q) => q.pattern.toLowerCase());

    let matched = 0;
    for (const sym of expected) {
        const lower = sym.toLowerCase();
        if (
            queriedSymbols.has(lower) ||
            queryPatterns.some((p) => p.includes(lower))
        ) {
            matched++;
        }
    }

    const score = matched / expected.length;
    return {
        key: 'symbol_coverage',
        score,
        comment: `${matched}/${expected.length} expected symbols covered (${(score * 100).toFixed(1)}%).`,
    };
}

/**
 * Risk Accuracy: riskLevel matches expected for matched symbols.
 * Target: >= 60%
 */
function riskAccuracyEvaluator(args: {
    outputs?: Record<string, unknown>;
    referenceOutputs?: Record<string, unknown>;
}): EvaluationResult {
    const queries = ((args.outputs?.queries ?? []) as PlannerQuery[]);
    const expectedRiskLevels = ((args.referenceOutputs?.expectedRiskLevels ?? {}) as Record<string, string>);

    const symbols = Object.keys(expectedRiskLevels);
    if (symbols.length === 0) {
        return { key: 'risk_accuracy', score: 1.0, comment: 'No expected risk levels defined.' };
    }

    let matched = 0;
    let correct = 0;

    for (const sym of symbols) {
        const query = queries.find(
            (q) =>
                q.symbolName?.toLowerCase() === sym.toLowerCase() ||
                q.pattern.toLowerCase().includes(sym.toLowerCase()),
        );
        if (query) {
            matched++;
            if (query.riskLevel === expectedRiskLevels[sym]) {
                correct++;
            }
        }
    }

    const score = matched > 0 ? correct / matched : 0;
    return {
        key: 'risk_accuracy',
        score,
        comment: `${correct}/${matched} matched symbols have correct riskLevel (${(score * 100).toFixed(1)}%).`,
    };
}

/**
 * Query Validity: all patterns must be valid ripgrep regex.
 * Target: 100%
 */
function queryValidityEvaluator(args: {
    outputs?: Record<string, unknown>;
}): EvaluationResult {
    const queries = ((args.outputs?.queries ?? []) as PlannerQuery[]);
    if (queries.length === 0) {
        return { key: 'query_validity', score: 1.0, comment: 'No queries to validate.' };
    }

    let valid = 0;
    const invalid: string[] = [];

    for (const q of queries) {
        try {
            new RegExp(q.pattern);
            valid++;
        } catch {
            invalid.push(q.pattern);
        }
    }

    const score = valid / queries.length;
    const comment = invalid.length > 0
        ? `Invalid patterns: ${invalid.join(', ')}`
        : 'All patterns are valid regex.';

    return { key: 'query_validity', score, comment };
}

/**
 * False Positive Rate: queries without match in expectedSymbols or expectedUpstreamSymbols.
 * Target: <= 30% (score = 1 - falsePositiveRate)
 */
function falsePositiveRateEvaluator(args: {
    outputs?: Record<string, unknown>;
    referenceOutputs?: Record<string, unknown>;
}): EvaluationResult {
    const queries = ((args.outputs?.queries ?? []) as PlannerQuery[]);
    const expected = ((args.referenceOutputs?.expectedSymbols ?? []) as string[]);
    const expectedUpstream = ((args.referenceOutputs?.expectedUpstreamSymbols ?? []) as string[]);
    const allExpected = [...expected, ...expectedUpstream];

    if (queries.length === 0) {
        return { key: 'false_positive_rate', score: 1.0, comment: 'No queries generated.' };
    }

    const allExpectedLower = new Set(allExpected.map((s) => s.toLowerCase()));
    let falsePositives = 0;

    for (const q of queries) {
        const sym = q.symbolName?.toLowerCase();
        const patternMatchesExpected = allExpected.some((s) =>
            q.pattern.toLowerCase().includes(s.toLowerCase()),
        );
        if (!sym || (!allExpectedLower.has(sym) && !patternMatchesExpected)) {
            falsePositives++;
        }
    }

    const falsePositiveRate = falsePositives / queries.length;
    // Score is inverted: higher is better (lower false positive rate)
    const score = 1 - falsePositiveRate;

    return {
        key: 'false_positive_rate',
        score,
        comment: `${falsePositives}/${queries.length} queries are false positives (rate: ${(falsePositiveRate * 100).toFixed(1)}%).`,
    };
}

/**
 * Upstream Coverage: % of expectedUpstreamSymbols found in generated queries.
 * Target: >= 50%
 */
function upstreamCoverageEvaluator(args: {
    outputs?: Record<string, unknown>;
    referenceOutputs?: Record<string, unknown>;
}): EvaluationResult {
    const queries = ((args.outputs?.queries ?? []) as PlannerQuery[]);
    const expectedUpstream = ((args.referenceOutputs?.expectedUpstreamSymbols ?? []) as string[]);

    if (expectedUpstream.length === 0) {
        return { key: 'upstream_coverage', score: 1.0, comment: 'No expected upstream symbols defined.' };
    }

    const queriedSymbols = new Set(
        queries
            .map((q) => q.symbolName?.toLowerCase())
            .filter(Boolean),
    );
    const queryPatterns = queries.map((q) => q.pattern.toLowerCase());

    let matched = 0;
    for (const sym of expectedUpstream) {
        const lower = sym.toLowerCase();
        if (
            queriedSymbols.has(lower) ||
            queryPatterns.some((p) => p.includes(lower))
        ) {
            matched++;
        }
    }

    const score = matched / expectedUpstream.length;
    return {
        key: 'upstream_coverage',
        score,
        comment: `${matched}/${expectedUpstream.length} expected upstream symbols covered (${(score * 100).toFixed(1)}%).`,
    };
}

/**
 * Category Coverage: checks if queries cover multiple search categories via
 * heuristic keywords in query rationale text.
 * Categories: consumer/caller, symmetric/counterpart, test/spec, config/limit, upstream/dependency
 * Score = categoriesFound / 4 (excluding the triggering category itself).
 * Target: >= 50%
 */
function categoryCoverageEvaluator(args: {
    outputs?: Record<string, unknown>;
}): EvaluationResult {
    const queries = ((args.outputs?.queries ?? []) as PlannerQuery[]);

    if (queries.length === 0) {
        return { key: 'category_coverage', score: 0, comment: 'No queries generated.' };
    }

    const allRationales = queries
        .map((q) => (q.rationale ?? '').toLowerCase())
        .join(' ');
    const allSymbols = queries
        .map((q) => `${q.symbolName ?? ''} ${q.pattern ?? ''}`.toLowerCase())
        .join(' ');
    const combined = `${allRationales} ${allSymbols}`;

    const categoryKeywords: [string, string[]][] = [
        ['consumer', ['consumer', 'caller', 'call site', 'usage', 'invocation', 'import']],
        ['symmetric', ['symmetric', 'counterpart', 'sibling', 'related', 'mirror', 'write', 'read', 'get', 'set']],
        ['test', ['test', 'spec', 'assert', 'expect', 'mock', 'fixture', 'describe', 'it(']],
        ['config', ['config', 'limit', 'threshold', 'constant', 'env', 'setting', 'max_', 'min_']],
        ['upstream', ['upstream', 'dependency', 'depend', 'import', 'require', 'from', 'provider', 'inject']],
    ];

    const found = new Set<string>();
    for (const [category, keywords] of categoryKeywords) {
        if (keywords.some((kw) => combined.includes(kw))) {
            found.add(category);
        }
    }

    // Score out of 4 (we expect at least some category diversity)
    const score = Math.min(found.size / 4, 1.0);
    return {
        key: 'category_coverage',
        score,
        comment: `${found.size}/5 categories detected: ${Array.from(found).join(', ')} (score=${(score * 100).toFixed(1)}%).`,
    };
}

// ─── Target Function ───────────────────────────────────────────────────────────

async function plannerTarget(
    inputs: Record<string, unknown>,
): Promise<CrossFileContextPlannerSchemaType> {
    const { diffSummary, changedFilenames } = buildDiffSummary(inputs);
    const language =
        (inputs.language as string | undefined) ?? DEFAULT_LANGUAGE;

    const payload: CrossFileContextPlannerPayload = {
        diffSummary,
        changedFilenames,
        language,
    };

    const result = await promptRunnerService
        .builder()
        .setProviders({
            main: LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
            fallback: LLMModelProvider.GEMINI_2_5_FLASH,
        })
        .setParser(ParserType.ZOD, CrossFileContextPlannerSchema)
        .setLLMJsonMode(true)
        .setPayload(payload)
        .addPrompt({
            prompt: prompt_cross_file_context_planner,
            role: PromptRole.SYSTEM,
        })
        .addPrompt({
            prompt: 'Analyze the diff and generate search queries. Return the response in the specified JSON format.',
            role: PromptRole.USER,
        })
        .setTemperature(0)
        .setRunName(RUN_NAME)
        .addTags(['crossFileContextPlanner', 'eval'])
        .addMetadata({ datasetId, runName: RUN_NAME })
        .execute();

    if (!result) {
        throw new Error('Planner LLM returned empty response for eval run.');
    }

    return result;
}

// ─── Inspect ───────────────────────────────────────────────────────────────────

async function inspectDataset() {
    let firstExample: any | null = null;

    for await (const example of client.listExamples({
        datasetId,
        limit: 1,
        asOf: 'latest',
    })) {
        firstExample = example;
        break;
    }

    if (!firstExample) {
        logger.warn(`No examples found for dataset ${datasetId}.`);
        return;
    }

    logger.log(`Inspecting planner dataset (${datasetId})`);
    logger.log(`- exampleId: ${firstExample.id}`);
    logger.log(
        `- input keys: ${Object.keys(firstExample.inputs ?? {}).join(', ')}`,
    );
    logger.log(
        `- output keys: ${Object.keys(firstExample.outputs ?? {}).join(', ')}`,
    );
    logger.log(
        `- inputs preview: ${JSON.stringify(firstExample.inputs ?? {}).slice(0, 300)}`,
    );
    logger.log(
        `- outputs preview: ${JSON.stringify(firstExample.outputs ?? {}).slice(0, 300)}`,
    );

    if (inspectFull) {
        logger.log(
            `- inputs full: ${JSON.stringify(firstExample.inputs, null, 2)}`,
        );
        logger.log(
            `- outputs full: ${JSON.stringify(firstExample.outputs, null, 2)}`,
        );
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const THRESHOLDS = {
    symbol_coverage: 0.7,
    risk_accuracy: 0.6,
    query_validity: 1.0,
    false_positive_rate: 0.7, // score >= 0.7 means FP rate <= 30%
    upstream_coverage: 0.5,
    category_coverage: 0.5,
};

async function main() {
    if (inspectOnly || inspectFull) {
        await inspectDataset();
        return;
    }

    if (datasetId === 'REPLACE_WITH_DATASET_UUID') {
        logger.error(
            'No dataset ID configured. Set EVAL_PLANNER_DATASET_ID or pass --dataset=<uuid>.',
        );
        process.exitCode = 1;
        return;
    }

    logger.log(
        `Starting planner eval with dataset ${datasetId}, concurrency=${maxConcurrency}`,
    );

    const evaluators: EvaluatorT[] = [
        symbolCoverageEvaluator as unknown as EvaluatorT,
        riskAccuracyEvaluator as unknown as EvaluatorT,
        queryValidityEvaluator as unknown as EvaluatorT,
        falsePositiveRateEvaluator as unknown as EvaluatorT,
        upstreamCoverageEvaluator as unknown as EvaluatorT,
        categoryCoverageEvaluator as unknown as EvaluatorT,
    ];

    const results = await evaluate(plannerTarget, {
        data: datasetId,
        experimentPrefix,
        maxConcurrency,
        description: `Cross-file context planner eval using ${LLMModelProvider.GEMINI_3_FLASH_PREVIEW}`,
        metadata: {
            datasetId,
            provider: LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
        },
        evaluators,
        client,
    });

    logger.log(`Completed planner eval: ${results.experimentName}`);

    // ── Collect and summarize feedback ────────────────────────────────────
    const runIds: string[] = [];
    for await (const run of client.listRuns({
        projectName: results.experimentName,
        isRoot: true,
        select: ['id'],
    })) {
        if (run?.id) runIds.push(run.id);
    }

    if (runIds.length === 0) {
        logger.warn('No runs found. Cannot summarize feedback.');
        return;
    }

    // Wait briefly for evaluators to finish persisting feedback
    await new Promise((r) => setTimeout(r, 3000));

    const feedbackByKey = new Map<
        string,
        { count: number; sum: number }
    >();

    for await (const feedback of client.listFeedback({ runIds })) {
        const key = feedback.key ?? 'unknown';
        const entry = feedbackByKey.get(key) ?? { count: 0, sum: 0 };
        if (typeof feedback.score === 'number') {
            entry.count++;
            entry.sum += feedback.score;
        }
        feedbackByKey.set(key, entry);
    }

    logger.log('─── Planner Eval Results ───');
    const failures: string[] = [];

    for (const [key, { count, sum }] of feedbackByKey.entries()) {
        const avg = count > 0 ? sum / count : 0;
        const threshold =
            THRESHOLDS[key as keyof typeof THRESHOLDS] ?? 0.5;
        const status = avg >= threshold ? 'PASS' : 'FAIL';
        logger.log(
            `  ${key}: ${status} (avg=${avg.toFixed(3)}, threshold=${threshold.toFixed(2)}, n=${count})`,
        );
        if (status === 'FAIL') {
            failures.push(
                `${key}: ${avg.toFixed(3)} < ${threshold.toFixed(2)}`,
            );
        }
    }

    if (failures.length > 0) {
        logger.error('Threshold check failed:');
        failures.forEach((f) => logger.error(`  - ${f}`));
        process.exitCode = 1;
    } else {
        logger.log('All metrics passed.');
    }
}

main().catch((error) => {
    logger.error('Planner eval failed', error as Error);
    process.exitCode = 1;
});
