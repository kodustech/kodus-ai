#!/usr/bin/env npx ts-node

/**
 * PR Performance Report CLI
 *
 * Generates a comprehensive report of PR code review performance metrics.
 *
 * Usage:
 *   npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod
 *   npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod --days=14
 *   npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod --days=7 --format=markdown
 *
 * Options:
 *   --env=<path>       Path to .env file (required for prod)
 *   --days=<number>    Number of days to analyze (default: 7)
 *   --format=<type>    Output format: console, markdown, json (default: console)
 *   --output=<path>    Output file path (optional, prints to stdout if not specified)
 */

import * as dotenv from 'dotenv';
import { MongoClient, Db } from 'mongodb';
import * as path from 'path';
import * as fs from 'fs';

// Load .env
const envArg = process.argv.find(a => a.startsWith('--env='));
const envPath = envArg
    ? path.resolve(envArg.split('=')[1])
    : process.env.DOTENV_CONFIG_PATH
        ? path.resolve(process.env.DOTENV_CONFIG_PATH)
        : path.resolve(__dirname, '../.env');

dotenv.config({ path: envPath });

// Parse arguments
const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const formatArg = args.find(a => a.startsWith('--format='));
const outputArg = args.find(a => a.startsWith('--output='));

const orgArg = args.find(a => a.startsWith('--org='));

const DAYS_BACK = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
const FORMAT = formatArg ? formatArg.split('=')[1] : 'console';
const OUTPUT_PATH = outputArg ? outputArg.split('=')[1] : null;
const INCLUDE_LEGACY = args.includes('--legacy');
const ORG_FILTER = orgArg ? orgArg.split('=')[1] : null;

interface StageMetrics {
    stageName: string;
    count: number;
    avgMs: number;
    p75Ms: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
}

interface LLMMetrics {
    operationName: string;
    count: number;
    avgMs: number;
    p75Ms: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
}

interface ModelMetrics {
    model: string;
    count: number;
    avgMs: number;
    p75Ms: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    slowCallsCount: number; // calls > 60s
}

interface OrgMetrics {
    organizationId: string;
    prCount: number;
    avgMs: number;
    p75Ms: number;
    p95Ms: number;
    maxMs: number;
    slowPRsCount: number; // PRs with calls > 60s
}

interface PipelineMetrics {
    totalPipelines: number;
    avgDurationMs: number;
    p75DurationMs: number;
    p95DurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
}

interface ReportData {
    generatedAt: Date;
    periodStart: Date;
    periodEnd: Date;
    daysAnalyzed: number;
    pipeline: PipelineMetrics;
    stages: StageMetrics[];
    llmCalls: LLMMetrics[];
    modelMetrics: ModelMetrics[];
    orgMetrics: OrgMetrics[];
    slowestPRs: Array<{
        prNumber: number;
        repository: string;
        organizationId?: string;
        durationMs: number;
        maxSingleCallMs: number;
        timestamp: Date;
    }>;
}

function buildMongoUri(): string {
    if (process.env.MONGODB_URI) {
        return process.env.MONGODB_URI;
    }

    const host = process.env.API_MG_DB_HOST;
    const port = process.env.API_MG_DB_PORT;
    const username = process.env.API_MG_DB_USERNAME;
    const password = process.env.API_MG_DB_PASSWORD;
    const authSource = process.env.API_MG_DB_AUTH_SOURCE || 'admin';

    if (!host) {
        throw new Error('Missing MongoDB configuration. Set MONGODB_URI or API_MG_DB_* variables.');
    }

    if (username && password) {
        if (port) {
            return `mongodb://${username}:${password}@${host}:${port}/?authSource=${authSource}`;
        }
        return `mongodb+srv://${username}:${password}@${host}/?authSource=${authSource}`;
    }

    if (port) {
        return `mongodb://${host}:${port}`;
    }
    return `mongodb+srv://${host}`;
}

function calculatePercentile(sortedValues: number[], percentile: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.floor(sortedValues.length * percentile);
    return sortedValues[Math.min(index, sortedValues.length - 1)];
}

function formatDuration(ms: number): string {
    if (!ms || ms === 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
}

function padRight(str: string, len: number): string {
    return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
    return str.length >= len ? str.substring(0, len) : ' '.repeat(len - str.length) + str;
}

async function getStageMetrics(db: Db, startDate: Date, endDate: Date): Promise<StageMetrics[]> {
    const matchStage: any = {
        message: { $regex: /Stage.*completed in \d+ms/ },
        component: 'PipelineExecutor',
        timestamp: { $gte: startDate, $lte: endDate }
    };

    if (ORG_FILTER) {
        matchStage['$or'] = [
            { 'attributes.organizationId': ORG_FILTER },
            { 'attributes.organizationAndTeamData.organizationId': ORG_FILTER }
        ];
    }

    const pipeline: any[] = [
        { $match: matchStage }
    ];

    if (INCLUDE_LEGACY) {
        pipeline.push({
            $unionWith: {
                coll: 'observability_logs',
                pipeline: [{ $match: matchStage }]
            }
        });
    }

    pipeline.push(
        {
            $addFields: {
                stageName: '$attributes.stage',
                durationMs: {
                    $toInt: {
                        $arrayElemAt: [
                            { $split: [
                                { $arrayElemAt: [{ $split: ['$message', 'completed in '] }, 1] },
                                'ms'
                            ] },
                            0
                        ]
                    }
                }
            }
        },
        {
            $group: {
                _id: '$stageName',
                count: { $sum: 1 },
                avgMs: { $avg: '$durationMs' },
                minMs: { $min: '$durationMs' },
                maxMs: { $max: '$durationMs' },
                durations: { $push: '$durationMs' }
            }
        },
        {
            $project: {
                stageName: '$_id',
                count: 1,
                avgMs: { $round: ['$avgMs', 0] },
                minMs: 1,
                maxMs: 1,
                durations: 1
            }
        }
    );

    const stagesAgg = await db.collection('observability_logs_ts').aggregate(pipeline).toArray();

    // Calculate percentiles and sort by pipeline order
    const stageOrder = [
        'ValidateNewCommitsStage',
        'ResolveConfigStage',
        'ValidateConfigStage',
        'CreateGithubCheckStage',
        'FetchChangedFilesStage',
        'LoadExternalContextStage',
        'FileContextGateStage',
        'InitialCommentStage',
        'KodyFineTuningStage',
        'PRLevelReviewStage',
        'FileAnalysisStage',
        'CreatePrLevelCommentsStage',
        'ValidateSuggestionsStage',
        'CreateFileCommentsStage',
        'AggregateResultsStage',
        'UpdateCommentsAndGenerateSummaryStage',
        'RequestChangesOrApproveStage',
        'FinalizeGithubCheckStage'
    ];

    return stagesAgg
        .map((stage: any) => {
            const sortedDurations = (stage.durations || []).sort((a: number, b: number) => a - b);
            return {
                stageName: stage.stageName || 'Unknown',
                count: stage.count,
                avgMs: stage.avgMs,
                p75Ms: calculatePercentile(sortedDurations, 0.75),
                p95Ms: calculatePercentile(sortedDurations, 0.95),
                minMs: stage.minMs,
                maxMs: stage.maxMs
            };
        })
        .sort((a, b) => {
            const aIndex = stageOrder.indexOf(a.stageName);
            const bIndex = stageOrder.indexOf(b.stageName);
            if (aIndex === -1 && bIndex === -1) return a.stageName.localeCompare(b.stageName);
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            return aIndex - bIndex;
        });
}

async function getLLMMetrics(db: Db, startDate: Date, endDate: Date): Promise<LLMMetrics[]> {
    const llmMatch: any = {
        timestamp: { $gte: startDate, $lte: endDate },
        name: {
            $in: [
                'LLMAnalysisService::analyzeCodeWithAI',
                'LLMAnalysisService::analyzeCodeWithAI_v2',
                'LLMAnalysisService::selectReviewMode',
                'LLMAnalysisService::filterSuggestionsSafeGuard',
                'LLMAnalysisService::severityAnalysis',
                'KodyRulesAnalysisService::kodyRulesAnalyzeCodeWithAI',
                'KodyRulesPrLevelAnalysisService::prLevelKodyRulesAnalyzer',
                'CrossFileAnalysisService::crossFileAnalyzeCodeWithAI',
                'CommentManagerService::generateSummaryPR',
                'CommentManagerService::repeatedCodeReviewSuggestionClustering'
            ]
        },
        duration: { $gt: 0 }
    };

    if (ORG_FILTER) {
        llmMatch['attributes.organizationId'] = ORG_FILTER;
    }

    const llmAgg = await db.collection('observability_telemetry').aggregate([
        { $match: llmMatch },
        {
            $group: {
                _id: '$name',
                count: { $sum: 1 },
                avgMs: { $avg: '$duration' },
                minMs: { $min: '$duration' },
                maxMs: { $max: '$duration' },
                durations: { $push: '$duration' },
                avgInputTokens: { $avg: '$attributes.gen_ai.usage.input_tokens' },
                avgOutputTokens: { $avg: '$attributes.gen_ai.usage.output_tokens' }
            }
        },
        {
            $project: {
                operationName: '$_id',
                count: 1,
                avgMs: { $round: ['$avgMs', 0] },
                minMs: 1,
                maxMs: 1,
                durations: 1,
                avgInputTokens: { $round: [{ $ifNull: ['$avgInputTokens', 0] }, 0] },
                avgOutputTokens: { $round: [{ $ifNull: ['$avgOutputTokens', 0] }, 0] }
            }
        },
        { $sort: { avgMs: -1 } }
    ]).toArray();

    return llmAgg.map((llm: any) => {
        const sortedDurations = (llm.durations || []).sort((a: number, b: number) => a - b);
        return {
            operationName: llm.operationName || 'Unknown',
            count: llm.count,
            avgMs: llm.avgMs,
            p75Ms: calculatePercentile(sortedDurations, 0.75),
            p95Ms: calculatePercentile(sortedDurations, 0.95),
            minMs: llm.minMs,
            maxMs: llm.maxMs,
            avgInputTokens: llm.avgInputTokens || 0,
            avgOutputTokens: llm.avgOutputTokens || 0
        };
    });
}

async function getModelMetrics(db: Db, startDate: Date, endDate: Date): Promise<ModelMetrics[]> {
    const modelMatch: any = {
        timestamp: { $gte: startDate, $lte: endDate },
        name: {
            $in: [
                'LLMAnalysisService::analyzeCodeWithAI',
                'LLMAnalysisService::analyzeCodeWithAI_v2',
                'LLMAnalysisService::selectReviewMode',
                'LLMAnalysisService::filterSuggestionsSafeGuard',
                'LLMAnalysisService::severityAnalysis',
                'KodyRulesAnalysisService::kodyRulesAnalyzeCodeWithAI',
                'KodyRulesPrLevelAnalysisService::prLevelKodyRulesAnalyzer',
                'CrossFileAnalysisService::crossFileAnalyzeCodeWithAI',
                'CommentManagerService::generateSummaryPR',
                'CommentManagerService::repeatedCodeReviewSuggestionClustering'
            ]
        },
        duration: { $gt: 0 }
    };

    if (ORG_FILTER) {
        modelMatch['attributes.organizationId'] = ORG_FILTER;
    }

    const modelAgg = await db.collection('observability_telemetry').aggregate([
        { $match: modelMatch },
        {
            $addFields: {
                modelName: {
                    $ifNull: [
                        { $getField: { field: 'gen_ai.response.model', input: '$attributes' } },
                        'unknown'
                    ]
                },
                inputTokens: { $getField: { field: 'gen_ai.usage.input_tokens', input: '$attributes' } },
                outputTokens: { $getField: { field: 'gen_ai.usage.output_tokens', input: '$attributes' } }
            }
        },
        {
            $group: {
                _id: '$modelName',
                count: { $sum: 1 },
                avgMs: { $avg: '$duration' },
                minMs: { $min: '$duration' },
                maxMs: { $max: '$duration' },
                durations: { $push: '$duration' },
                avgInputTokens: { $avg: '$inputTokens' },
                avgOutputTokens: { $avg: '$outputTokens' },
                slowCallsCount: {
                    $sum: { $cond: [{ $gt: ['$duration', 60000] }, 1, 0] }
                }
            }
        },
        {
            $match: {
                _id: { $ne: 'unknown' }
            }
        },
        {
            $project: {
                model: '$_id',
                count: 1,
                avgMs: { $round: ['$avgMs', 0] },
                minMs: 1,
                maxMs: 1,
                durations: 1,
                avgInputTokens: { $round: [{ $ifNull: ['$avgInputTokens', 0] }, 0] },
                avgOutputTokens: { $round: [{ $ifNull: ['$avgOutputTokens', 0] }, 0] },
                slowCallsCount: 1
            }
        },
        { $sort: { count: -1 } }
    ]).toArray();

    return modelAgg.map((m: any) => {
        const sortedDurations = (m.durations || []).sort((a: number, b: number) => a - b);
        return {
            model: m.model || 'unknown',
            count: m.count,
            avgMs: m.avgMs,
            p75Ms: calculatePercentile(sortedDurations, 0.75),
            p95Ms: calculatePercentile(sortedDurations, 0.95),
            minMs: m.minMs,
            maxMs: m.maxMs,
            avgInputTokens: m.avgInputTokens || 0,
            avgOutputTokens: m.avgOutputTokens || 0,
            slowCallsCount: m.slowCallsCount || 0
        };
    });
}

async function getOrgMetrics(db: Db, startDate: Date, endDate: Date): Promise<OrgMetrics[]> {
    const orgMatch: any = {
        timestamp: { $gte: startDate, $lte: endDate },
        'attributes.prNumber': { $exists: true },
        'attributes.organizationId': { $exists: true },
        duration: { $gt: 0 }
    };

    if (ORG_FILTER) {
        orgMatch['attributes.organizationId'] = ORG_FILTER;
    }

    const orgAgg = await db.collection('observability_telemetry').aggregate([
        { $match: orgMatch },
        {
            $group: {
                _id: {
                    organizationId: '$attributes.organizationId',
                    prNumber: '$attributes.prNumber',
                    correlationId: '$correlationId'
                },
                maxCallDuration: { $max: '$duration' }
            }
        },
        {
            $group: {
                _id: '$_id.organizationId',
                prCount: { $sum: 1 },
                avgMs: { $avg: '$maxCallDuration' },
                maxMs: { $max: '$maxCallDuration' },
                durations: { $push: '$maxCallDuration' },
                slowPRsCount: {
                    $sum: { $cond: [{ $gt: ['$maxCallDuration', 60000] }, 1, 0] }
                }
            }
        },
        {
            $project: {
                organizationId: '$_id',
                prCount: 1,
                avgMs: { $round: ['$avgMs', 0] },
                maxMs: 1,
                durations: 1,
                slowPRsCount: 1
            }
        },
        { $sort: { maxMs: -1 } },
        { $limit: 15 }
    ]).toArray();

    return orgAgg.map((o: any) => {
        const sortedDurations = (o.durations || []).sort((a: number, b: number) => a - b);
        return {
            organizationId: o.organizationId || 'unknown',
            prCount: o.prCount,
            avgMs: o.avgMs,
            p75Ms: calculatePercentile(sortedDurations, 0.75),
            p95Ms: calculatePercentile(sortedDurations, 0.95),
            maxMs: o.maxMs,
            slowPRsCount: o.slowPRsCount || 0
        };
    });
}

async function getPipelineMetrics(db: Db, startDate: Date, endDate: Date): Promise<PipelineMetrics> {
    const matchStage: any = {
        $or: [
            { message: { $regex: /Starting pipeline: CodeReviewPipeline/ } },
            { message: { $regex: /Finished pipeline: CodeReviewPipeline/ } }
        ],
        timestamp: { $gte: startDate, $lte: endDate }
    };

    if (ORG_FILTER) {
        matchStage['attributes.organizationAndTeamData.organizationId'] = ORG_FILTER;
    }

    const pipeline: any[] = [
        { $match: matchStage }
    ];

    if (INCLUDE_LEGACY) {
        pipeline.push({
            $unionWith: {
                coll: 'observability_logs',
                pipeline: [{ $match: matchStage }]
            }
        });
    }

    pipeline.push(
        {
            $group: {
                _id: '$attributes.pipelineId',
                start: { $min: '$timestamp' },
                end: { $max: '$timestamp' }
            }
        },
        {
            $addFields: {
                durationMs: { $subtract: ['$end', '$start'] }
            }
        },
        {
            $match: { durationMs: { $gt: 0 } }
        },
        {
            $group: {
                _id: null,
                count: { $sum: 1 },
                avgMs: { $avg: '$durationMs' },
                minMs: { $min: '$durationMs' },
                maxMs: { $max: '$durationMs' },
                durations: { $push: '$durationMs' }
            }
        }
    );

    const pipelineAgg = await db.collection('observability_logs_ts').aggregate(pipeline).toArray();

    if (pipelineAgg.length === 0) {
        return {
            totalPipelines: 0,
            avgDurationMs: 0,
            p75DurationMs: 0,
            p95DurationMs: 0,
            minDurationMs: 0,
            maxDurationMs: 0
        };
    }

    const data = pipelineAgg[0];
    const sortedDurations = (data.durations || []).sort((a: number, b: number) => a - b);

    return {
        totalPipelines: data.count,
        avgDurationMs: Math.round(data.avgMs),
        p75DurationMs: calculatePercentile(sortedDurations, 0.75),
        p95DurationMs: calculatePercentile(sortedDurations, 0.95),
        minDurationMs: data.minMs,
        maxDurationMs: data.maxMs
    };
}

async function getSlowestPRs(db: Db, startDate: Date, endDate: Date, limit: number = 10): Promise<any[]> {
    const slowMatch: any = {
        timestamp: { $gte: startDate, $lte: endDate },
        'attributes.prNumber': { $exists: true },
        duration: { $gt: 60000 } // > 1 minute
    };

    if (ORG_FILTER) {
        slowMatch['attributes.organizationId'] = ORG_FILTER;
    }

    const slowPRs = await db.collection('observability_telemetry').aggregate([
        { $match: slowMatch },
        {
            $group: {
                _id: {
                    prNumber: '$attributes.prNumber',
                    correlationId: '$correlationId'
                },
                totalDuration: { $sum: '$duration' },
                maxSingleCall: { $max: '$duration' },
                timestamp: { $first: '$timestamp' },
                repository: { $first: '$attributes.organizationAndTeamData.repository.fullName' },
                repositoryAlt: { $first: '$attributes.repository.fullName' },
                organizationId: { $first: '$attributes.organizationId' }
            }
        },
        { $sort: { maxSingleCall: -1 } }, // Sort by slowest single call, not total
        { $limit: limit },
        {
            $project: {
                _id: 0,
                prNumber: '$_id.prNumber',
                correlationId: '$_id.correlationId',
                repository: { $ifNull: ['$repository', '$repositoryAlt'] },
                organizationId: 1,
                durationMs: '$totalDuration',
                maxSingleCallMs: '$maxSingleCall',
                timestamp: 1
            }
        }
    ]).toArray();

    return slowPRs;
}

function generateConsoleReport(data: ReportData): string {
    let output = '';
    const line = '='.repeat(90);
    const thinLine = '-'.repeat(90);

    output += `\n${line}\n`;
    output += `PR CODE REVIEW PERFORMANCE REPORT\n`;
    output += `${line}\n\n`;

    output += `Generated: ${data.generatedAt.toISOString()}\n`;
    output += `Period: ${data.periodStart.toISOString().split('T')[0]} to ${data.periodEnd.toISOString().split('T')[0]} (${data.daysAnalyzed} days)\n`;
    if (ORG_FILTER) output += `Organization: ${ORG_FILTER}\n`;
    output += '\n';

    // Pipeline Summary
    output += `${thinLine}\n`;
    output += `PIPELINE SUMMARY\n`;
    output += `${thinLine}\n`;
    output += `Total Pipelines Executed: ${data.pipeline.totalPipelines}\n`;
    output += `Average Duration: ${formatDuration(data.pipeline.avgDurationMs)}\n`;
    output += `P75 Duration: ${formatDuration(data.pipeline.p75DurationMs)}\n`;
    output += `P95 Duration: ${formatDuration(data.pipeline.p95DurationMs)}\n`;
    output += `Min Duration: ${formatDuration(data.pipeline.minDurationMs)}\n`;
    output += `Max Duration: ${formatDuration(data.pipeline.maxDurationMs)}\n\n`;

    // Stage Metrics
    output += `${thinLine}\n`;
    output += `STAGE METRICS\n`;
    output += `${thinLine}\n`;
    output += padRight('Stage', 45) + padLeft('Count', 8) + padLeft('Avg', 10) + padLeft('P75', 10) + padLeft('P95', 10) + padLeft('Max', 10) + '\n';
    output += thinLine + '\n';

    for (const stage of data.stages) {
        const highlight = stage.p95Ms > 60000 ? ' ⚠️' : '';
        output += padRight(stage.stageName, 45) +
            padLeft(String(stage.count), 8) +
            padLeft(formatDuration(stage.avgMs), 10) +
            padLeft(formatDuration(stage.p75Ms), 10) +
            padLeft(formatDuration(stage.p95Ms), 10) +
            padLeft(formatDuration(stage.maxMs), 10) +
            highlight + '\n';
    }

    // LLM Metrics
    output += `\n${thinLine}\n`;
    output += `LLM CALL METRICS\n`;
    output += `${thinLine}\n`;
    output += padRight('Operation', 50) + padLeft('Count', 8) + padLeft('Avg', 10) + padLeft('P75', 10) + padLeft('P95', 10) + padLeft('Max', 10) + '\n';
    output += thinLine + '\n';

    for (const llm of data.llmCalls) {
        const highlight = llm.p95Ms > 120000 ? ' ⚠️' : '';
        const shortName = llm.operationName.replace('Service::', '::');
        output += padRight(shortName, 50) +
            padLeft(String(llm.count), 8) +
            padLeft(formatDuration(llm.avgMs), 10) +
            padLeft(formatDuration(llm.p75Ms), 10) +
            padLeft(formatDuration(llm.p95Ms), 10) +
            padLeft(formatDuration(llm.maxMs), 10) +
            highlight + '\n';
    }

    // Model Metrics
    if (data.modelMetrics.length > 0) {
        output += `\n${thinLine}\n`;
        output += `MODEL METRICS\n`;
        output += `${thinLine}\n`;
        output += padRight('Model', 40) + padLeft('Count', 8) + padLeft('Avg', 10) + padLeft('P75', 10) + padLeft('P95', 10) + padLeft('Slow', 8) + '\n';
        output += thinLine + '\n';

        for (const model of data.modelMetrics) {
            const highlight = model.p95Ms > 120000 ? ' ⚠️' : '';
            const slowPct = model.count > 0 ? ((model.slowCallsCount / model.count) * 100).toFixed(1) : '0';
            output += padRight(model.model.substring(0, 39), 40) +
                padLeft(String(model.count), 8) +
                padLeft(formatDuration(model.avgMs), 10) +
                padLeft(formatDuration(model.p75Ms), 10) +
                padLeft(formatDuration(model.p95Ms), 10) +
                padLeft(`${slowPct}%`, 8) +
                highlight + '\n';
        }
    }

    // Org Metrics
    if (data.orgMetrics.length > 0) {
        output += `\n${thinLine}\n`;
        output += `SLOWEST ORGANIZATIONS (by max single LLM call)\n`;
        output += `${thinLine}\n`;
        output += padRight('OrgId', 40) + padLeft('PRs', 6) + padLeft('Avg', 10) + padLeft('P95', 10) + padLeft('Max', 10) + padLeft('Slow', 8) + '\n';
        output += thinLine + '\n';

        for (const org of data.orgMetrics) {
            const highlight = org.maxMs > 600000 ? ' ⚠️' : ''; // > 10min
            output += padRight(org.organizationId.substring(0, 39), 40) +
                padLeft(String(org.prCount), 6) +
                padLeft(formatDuration(org.avgMs), 10) +
                padLeft(formatDuration(org.p95Ms), 10) +
                padLeft(formatDuration(org.maxMs), 10) +
                padLeft(String(org.slowPRsCount), 8) +
                highlight + '\n';
        }
    }

    // Slowest PRs
    if (data.slowestPRs.length > 0) {
        output += `\n${thinLine}\n`;
        output += `SLOWEST PRs (by slowest single LLM call)\n`;
        output += `${thinLine}\n`;
        output += padRight('PR', 10) + padRight('OrgId', 30) + padLeft('Slowest Call', 14) + padLeft('Total Time', 14) + padLeft('Date', 12) + '\n';
        output += thinLine + '\n';

        for (const pr of data.slowestPRs) {
            output += padRight(`#${pr.prNumber}`, 10) +
                padRight((pr.organizationId || pr.repository || 'unknown').substring(0, 29), 30) +
                padLeft(formatDuration(pr.maxSingleCallMs), 14) +
                padLeft(formatDuration(pr.durationMs), 14) +
                padLeft(pr.timestamp?.toISOString().split('T')[0] || '', 12) + '\n';
        }
    }

    output += `\n${line}\n`;
    output += `⚠️ = P95 exceeds threshold (stages > 1min, LLM calls > 2min)\n`;
    output += `${line}\n`;

    return output;
}

function generateMarkdownReport(data: ReportData): string {
    let output = '';

    output += `# PR Code Review Performance Report\n\n`;
    output += `**Generated:** ${data.generatedAt.toISOString()}\n`;
    output += `**Period:** ${data.periodStart.toISOString().split('T')[0]} to ${data.periodEnd.toISOString().split('T')[0]} (${data.daysAnalyzed} days)\n\n`;

    output += `---\n\n`;

    // Pipeline Summary
    output += `## Pipeline Summary\n\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Total Pipelines | ${data.pipeline.totalPipelines} |\n`;
    output += `| Average Duration | ${formatDuration(data.pipeline.avgDurationMs)} |\n`;
    output += `| P75 Duration | ${formatDuration(data.pipeline.p75DurationMs)} |\n`;
    output += `| P95 Duration | ${formatDuration(data.pipeline.p95DurationMs)} |\n`;
    output += `| Min Duration | ${formatDuration(data.pipeline.minDurationMs)} |\n`;
    output += `| Max Duration | ${formatDuration(data.pipeline.maxDurationMs)} |\n\n`;

    // Stage Metrics
    output += `## Stage Metrics\n\n`;
    output += `| Stage | Count | Avg | P75 | P95 | Max |\n`;
    output += `|-------|-------|-----|-----|-----|-----|\n`;

    for (const stage of data.stages) {
        const highlight = stage.p95Ms > 60000 ? ' ⚠️' : '';
        output += `| ${stage.stageName} | ${stage.count} | ${formatDuration(stage.avgMs)} | ${formatDuration(stage.p75Ms)} | ${formatDuration(stage.p95Ms)} | ${formatDuration(stage.maxMs)}${highlight} |\n`;
    }

    // LLM Metrics
    output += `\n## LLM Call Metrics\n\n`;
    output += `| Operation | Count | Avg | P75 | P95 | Max | Avg Tokens (in/out) |\n`;
    output += `|-----------|-------|-----|-----|-----|-----|---------------------|\n`;

    for (const llm of data.llmCalls) {
        const highlight = llm.p95Ms > 120000 ? ' ⚠️' : '';
        output += `| ${llm.operationName} | ${llm.count} | ${formatDuration(llm.avgMs)} | ${formatDuration(llm.p75Ms)} | ${formatDuration(llm.p95Ms)} | ${formatDuration(llm.maxMs)}${highlight} | ${llm.avgInputTokens}/${llm.avgOutputTokens} |\n`;
    }

    // Model Metrics
    if (data.modelMetrics.length > 0) {
        output += `\n## Model Metrics\n\n`;
        output += `| Model | Count | Avg | P75 | P95 | Slow (>60s) |\n`;
        output += `|-------|-------|-----|-----|-----|-------------|\n`;

        for (const model of data.modelMetrics) {
            const highlight = model.p95Ms > 120000 ? ' ⚠️' : '';
            const slowPct = model.count > 0 ? ((model.slowCallsCount / model.count) * 100).toFixed(1) : '0';
            output += `| ${model.model} | ${model.count} | ${formatDuration(model.avgMs)} | ${formatDuration(model.p75Ms)} | ${formatDuration(model.p95Ms)}${highlight} | ${model.slowCallsCount} (${slowPct}%) |\n`;
        }
    }

    // Org Metrics
    if (data.orgMetrics.length > 0) {
        output += `\n## Slowest Organizations\n\n`;
        output += `| OrgId | PRs | Avg | P95 | Max | Slow PRs |\n`;
        output += `|-------|-----|-----|-----|-----|----------|\n`;

        for (const org of data.orgMetrics) {
            const highlight = org.maxMs > 600000 ? ' ⚠️' : '';
            output += `| ${org.organizationId} | ${org.prCount} | ${formatDuration(org.avgMs)} | ${formatDuration(org.p95Ms)} | ${formatDuration(org.maxMs)}${highlight} | ${org.slowPRsCount} |\n`;
        }
    }

    // Slowest PRs
    if (data.slowestPRs.length > 0) {
        output += `\n## Slowest PRs\n\n`;
        output += `| PR | OrgId | Slowest Call | Total Time | Date |\n`;
        output += `|----|-------|--------------|------------|------|\n`;

        for (const pr of data.slowestPRs) {
            output += `| #${pr.prNumber} | ${pr.organizationId || pr.repository || 'unknown'} | ${formatDuration(pr.maxSingleCallMs)} | ${formatDuration(pr.durationMs)} | ${pr.timestamp?.toISOString().split('T')[0] || ''} |\n`;
        }
    }

    output += `\n---\n\n`;
    output += `⚠️ = P95 exceeds threshold (stages > 1min, LLM calls > 2min)\n`;

    return output;
}

async function generateReport(db: Db): Promise<ReportData> {
    const endDate = new Date();
    const startDate = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

    console.error(`Fetching data from ${startDate.toISOString()} to ${endDate.toISOString()}...`);

    const [pipeline, stages, llmCalls, modelMetrics, orgMetrics, slowestPRs] = await Promise.all([
        getPipelineMetrics(db, startDate, endDate),
        getStageMetrics(db, startDate, endDate),
        getLLMMetrics(db, startDate, endDate),
        getModelMetrics(db, startDate, endDate),
        getOrgMetrics(db, startDate, endDate),
        getSlowestPRs(db, startDate, endDate, 15)
    ]);

    return {
        generatedAt: new Date(),
        periodStart: startDate,
        periodEnd: endDate,
        daysAnalyzed: DAYS_BACK,
        pipeline,
        stages,
        llmCalls,
        modelMetrics,
        orgMetrics,
        slowestPRs
    };
}

async function main() {
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
PR Performance Report CLI

Usage:
  npx ts-node scripts/pr-performance-report.cli.ts [options]

Options:
  --env=<path>       Path to .env file (required for prod)
  --days=<number>    Number of days to analyze (default: 7)
  --org=<orgId>      Filter by organization ID
  --format=<type>    Output format: console, markdown, json (default: console)
  --output=<path>    Output file path (optional)
  --legacy           Also search in legacy collection (observability_logs)
  --help             Show this help message

Examples:
  npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod
  npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod --days=14 --format=markdown
  npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod --org=97442318-9d2a-496b-a0d2-b45fb1b701f8
  npx ts-node scripts/pr-performance-report.cli.ts --env=.env.prod --legacy
`);
        process.exit(0);
    }

    let client: MongoClient | null = null;

    try {
        const uri = buildMongoUri();
        const dbName = process.env.API_MG_DB_DATABASE || 'kodus_db';

        console.error(`Using env file: ${envPath}`);
        console.error(`Connecting to MongoDB (database: ${dbName})...`);

        client = new MongoClient(uri);
        await client.connect();

        const db = client.db(dbName);

        const reportData = await generateReport(db);

        let output: string;
        switch (FORMAT) {
            case 'json':
                output = JSON.stringify(reportData, null, 2);
                break;
            case 'markdown':
                output = generateMarkdownReport(reportData);
                break;
            default:
                output = generateConsoleReport(reportData);
        }

        if (OUTPUT_PATH) {
            fs.writeFileSync(OUTPUT_PATH, output);
            console.error(`Report saved to: ${OUTPUT_PATH}`);
        } else {
            console.log(output);
        }

    } catch (error) {
        console.error('ERROR:', error);
        process.exit(1);
    } finally {
        if (client) {
            await client.close();
        }
    }
}

main();
