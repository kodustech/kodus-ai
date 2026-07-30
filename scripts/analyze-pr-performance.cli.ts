#!/usr/bin/env npx ts-node

/**
 * PR Performance Analysis CLI
 *
 * Usage:
 *   npx ts-node scripts/analyze-pr-performance.cli.ts <prNumber> <orgId> [options]
 *
 * Examples:
 *   npx ts-node scripts/analyze-pr-performance.cli.ts 558 04bd288b-595a-4ee1-87cd-8bbbdc312b3c --env=.env.prod
 *   npx ts-node scripts/analyze-pr-performance.cli.ts 723 97442318-9d2a-496b-a0d2-b45fb --days=1 --env=.env.prod
 *
 * Or with pnpm run script:
 *   pnpm run analyze-pr 558 04bd288b-595a-4ee1-87cd-8bbbdc312b3c --env=.env.prod
 *
 * Environment variables (uses .env):
 *   API_MG_DB_HOST, API_MG_DB_PORT, API_MG_DB_USERNAME, API_MG_DB_PASSWORD, API_MG_DB_DATABASE
 *   Or: MONGODB_URI
 */

import * as dotenv from 'dotenv';
import { MongoClient, Db } from 'mongodb';
import * as path from 'path';

// Load .env - check for --env flag or DOTENV_CONFIG_PATH, otherwise use .env
const envArg = process.argv.find(a => a.startsWith('--env='));
const envPath = envArg
    ? path.resolve(envArg.split('=')[1])
    : process.env.DOTENV_CONFIG_PATH
        ? path.resolve(process.env.DOTENV_CONFIG_PATH)
        : path.resolve(__dirname, '../.env');

dotenv.config({ path: envPath });
console.log(`Using env file: ${envPath}`);

interface SpanData {
    name: string;
    duration: number;
    createdAt: Date;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    filePath?: string;
}

interface ExecutionData {
    correlationId: string;
    spans: SpanData[];
    startTime: Date;
    endTime: Date;
    wallClockDuration: number;
    totalInput: number;
    totalOutput: number;
    totalReasoning: number;
    modelsUsed: string[];
    slowCallsCount: number;
    maxSingleCall: number;
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

function formatDuration(ms: number): string {
    if (!ms && ms !== 0) return '-';
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

function truncate(str: string, len: number): string {
    return str.length <= len ? str : str.substring(0, len - 3) + '...';
}

async function findAllExecutions(
    db: Db,
    prNumber: number,
    orgId: string,
    startDate: Date,
    endDate: Date,
): Promise<ExecutionData[]> {
    const telemetry = db.collection('observability_telemetry');

    // Find all correlationIds for this PR+org from telemetry directly
    const correlations = await telemetry.aggregate([
        {
            $match: {
                'attributes.organizationId': orgId,
                'attributes.prNumber': prNumber,
                createdAt: { $gte: startDate, $lte: endDate },
            },
        },
        {
            $group: {
                _id: '$correlationId',
                minDate: { $min: '$createdAt' },
                maxDate: { $max: '$createdAt' },
                count: { $sum: 1 },
            },
        },
        { $sort: { minDate: 1 } },
    ]).toArray();

    if (correlations.length === 0) {
        return [];
    }

    const executions: ExecutionData[] = [];

    for (const corr of correlations) {
        const corrId = corr._id as string;

        // Fetch all spans for this correlation
        const spans = await telemetry
            .find({ correlationId: corrId })
            .sort({ createdAt: 1 })
            .toArray();

        const spanData: SpanData[] = spans.map((s: any) => {
            const a = s.attributes || {};
            return {
                name: s.name,
                duration: s.duration || 0,
                createdAt: new Date(s.createdAt),
                model: a['gen_ai.response.model'] || undefined,
                inputTokens: a['gen_ai.usage.input_tokens'] || 0,
                outputTokens: a['gen_ai.usage.output_tokens'] || 0,
                reasoningTokens: a['gen_ai.usage.reasoning_tokens'] || 0,
                filePath: a['gen_ai.run.file'] || a.file?.filePath || a.filePath || undefined,
            };
        });

        const startTime = new Date(corr.minDate);
        const endTime = new Date(corr.maxDate);
        const wallClock = endTime.getTime() - startTime.getTime();

        const totalInput = spanData.reduce((s, sp) => s + (sp.inputTokens || 0), 0);
        const totalOutput = spanData.reduce((s, sp) => s + (sp.outputTokens || 0), 0);
        const totalReasoning = spanData.reduce((s, sp) => s + (sp.reasoningTokens || 0), 0);
        const modelsUsed = [...new Set(spanData.map(sp => sp.model).filter(Boolean))] as string[];
        const slowCallsCount = spanData.filter(sp => sp.duration > 60000).length;
        const maxSingleCall = Math.max(...spanData.map(sp => sp.duration), 0);

        executions.push({
            correlationId: corrId,
            spans: spanData,
            startTime,
            endTime,
            wallClockDuration: wallClock,
            totalInput,
            totalOutput,
            totalReasoning,
            modelsUsed,
            slowCallsCount,
            maxSingleCall,
        });
    }

    return executions;
}

function printExecutionSummaryTable(executions: ExecutionData[]): void {
    console.log(`\nFound ${executions.length} pipeline execution(s)\n`);
    console.log('-'.repeat(120));
    console.log(
        padRight('#', 4) +
        padRight('CorrelationId', 40) +
        padLeft('Spans', 7) +
        padLeft('Wall Clock', 12) +
        padLeft('Max Call', 10) +
        padLeft('Slow', 6) +
        padLeft('Input Tk', 10) +
        padLeft('Output Tk', 10) +
        padLeft('Start', 20),
    );
    console.log('-'.repeat(120));

    executions.forEach((exec, i) => {
        const flag = exec.slowCallsCount > 0 ? ' ⚠️' : '';
        console.log(
            padRight(String(i + 1), 4) +
            padRight(truncate(exec.correlationId, 38), 40) +
            padLeft(String(exec.spans.length), 7) +
            padLeft(formatDuration(exec.wallClockDuration), 12) +
            padLeft(formatDuration(exec.maxSingleCall), 10) +
            padLeft(String(exec.slowCallsCount), 6) + flag +
            padLeft(exec.totalInput.toLocaleString(), 10) +
            padLeft(exec.totalOutput.toLocaleString(), 10) +
            '  ' + exec.startTime.toISOString().slice(0, 19),
        );
    });
    console.log('-'.repeat(120));
}

function printExecutionDetail(exec: ExecutionData, index: number): void {
    console.log(`\n${'='.repeat(100)}`);
    console.log(`EXECUTION #${index + 1}: ${exec.correlationId}`);
    console.log(`Start: ${exec.startTime.toISOString()}  |  End: ${exec.endTime.toISOString()}  |  Wall clock: ${formatDuration(exec.wallClockDuration)}`);
    console.log(`Models: ${exec.modelsUsed.join(', ') || 'none'}`);
    console.log(`${'='.repeat(100)}\n`);

    // Print timeline
    console.log('SPAN TIMELINE:');
    console.log('-'.repeat(130));
    console.log(
        padLeft('Duration', 10) + '  ' +
        padRight('Operation', 60) +
        padLeft('Input', 8) +
        padLeft('Output', 8) +
        padLeft('Reason', 8) + '  ' +
        padRight('Model', 30),
    );
    console.log('-'.repeat(130));

    for (const span of exec.spans) {
        const dur = formatDuration(span.duration);
        const flag = span.duration > 60000 ? ' ⚠️' : '';
        const hasTokens = (span.inputTokens || 0) > 0 || (span.outputTokens || 0) > 0;

        console.log(
            padLeft(dur, 10) + flag +
            (flag ? '' : ' ') + ' ' +
            padRight(truncate(span.name, 58), 60) +
            (hasTokens ? padLeft(String(span.inputTokens || 0), 8) : padLeft('-', 8)) +
            (hasTokens ? padLeft(String(span.outputTokens || 0), 8) : padLeft('-', 8)) +
            (hasTokens ? padLeft(String(span.reasoningTokens || 0), 8) : padLeft('-', 8)) + '  ' +
            padRight(truncate(span.model || '', 28), 30) +
            (span.filePath ? `  file:${span.filePath}` : ''),
        );
    }

    console.log('-'.repeat(130));
    console.log(
        padLeft('TOTAL', 10) + '   ' +
        padRight('', 60) +
        padLeft(exec.totalInput.toLocaleString(), 8) +
        padLeft(exec.totalOutput.toLocaleString(), 8) +
        padLeft(exec.totalReasoning.toLocaleString(), 8),
    );

    // Bottlenecks
    const slowSpans = exec.spans.filter(s => s.duration > 60000).sort((a, b) => b.duration - a.duration);
    if (slowSpans.length > 0) {
        console.log(`\nBOTTLENECKS (> 60s): ${slowSpans.length} call(s)`);
        console.log('-'.repeat(100));
        for (const span of slowSpans) {
            const fileInfo = span.filePath ? ` [${span.filePath}]` : '';
            console.log(`  ${formatDuration(span.duration).padStart(8)}  ${span.name}  (${span.model || 'no model'})${fileInfo}`);
        }
    }
}

function printGlobalSummary(executions: ExecutionData[]): void {
    const totalSpans = executions.reduce((s, e) => s + e.spans.length, 0);
    const totalInput = executions.reduce((s, e) => s + e.totalInput, 0);
    const totalOutput = executions.reduce((s, e) => s + e.totalOutput, 0);
    const totalReasoning = executions.reduce((s, e) => s + e.totalReasoning, 0);
    const totalSlowCalls = executions.reduce((s, e) => s + e.slowCallsCount, 0);
    const allModels = [...new Set(executions.flatMap(e => e.modelsUsed))];

    const firstStart = executions[0].startTime;
    const lastEnd = executions[executions.length - 1].endTime;
    const totalWallClock = lastEnd.getTime() - firstStart.getTime();

    // Find the heaviest execution
    const heaviest = executions.reduce((max, e) => e.maxSingleCall > max.maxSingleCall ? e : max, executions[0]);
    const heaviestIdx = executions.indexOf(heaviest) + 1;

    console.log(`\n${'='.repeat(100)}`);
    console.log('GLOBAL SUMMARY');
    console.log(`${'='.repeat(100)}`);
    console.log(`Total Executions:      ${executions.length}`);
    console.log(`Total Spans:           ${totalSpans}`);
    console.log(`Total Wall Clock:      ${formatDuration(totalWallClock)} (first start to last end)`);
    console.log(`Total Tokens:          ${totalInput.toLocaleString()} input / ${totalOutput.toLocaleString()} output / ${totalReasoning.toLocaleString()} reasoning`);
    console.log(`Total Slow Calls:      ${totalSlowCalls} (>60s)`);
    console.log(`Models Used:           ${allModels.join(', ') || 'none'}`);
    console.log(`Heaviest Execution:    #${heaviestIdx} (max call: ${formatDuration(heaviest.maxSingleCall)}, ${heaviest.spans.length} spans)`);
    console.log(`${'='.repeat(100)}\n`);
}

async function analyzePR(
    db: Db,
    prNumber: number,
    orgId: string,
    daysBack: number = 7,
    detailExecution?: number,
): Promise<void> {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const end = new Date();

    console.log(`\n${'='.repeat(100)}`);
    console.log(`PR PERFORMANCE ANALYSIS - PR #${prNumber}`);
    console.log(`Organization: ${orgId}`);
    console.log(`Date range: ${start.toISOString()} - ${end.toISOString()}`);
    console.log(`${'='.repeat(100)}`);

    // Step 1: Find all executions from telemetry
    console.log('\nStep 1: Finding all pipeline executions from telemetry...');

    const executions = await findAllExecutions(db, prNumber, orgId, start, end);

    if (executions.length === 0) {
        console.log(`\nERROR: No telemetry data found for PR #${prNumber} with orgId ${orgId}`);
        console.log('Try increasing --days or check that the orgId is correct.');
        return;
    }

    // Step 2: Print execution summary table
    console.log('\nStep 2: Execution overview\n');
    printExecutionSummaryTable(executions);

    // Step 3: Print details
    if (detailExecution !== undefined) {
        // Show specific execution
        if (detailExecution < 1 || detailExecution > executions.length) {
            console.log(`\nERROR: Execution #${detailExecution} not found. Valid range: 1-${executions.length}`);
            return;
        }
        printExecutionDetail(executions[detailExecution - 1], detailExecution - 1);
    } else {
        // Show detail for the heaviest execution (by max single call)
        const heaviestIdx = executions.reduce(
            (maxIdx, e, i, arr) => e.maxSingleCall > arr[maxIdx].maxSingleCall ? i : maxIdx,
            0,
        );
        console.log(`\nStep 3: Detailed view of heaviest execution (#${heaviestIdx + 1})\n`);
        printExecutionDetail(executions[heaviestIdx], heaviestIdx);

        // If there are other executions with slow calls, mention them
        const otherSlow = executions
            .map((e, i) => ({ idx: i, exec: e }))
            .filter(({ idx, exec }) => idx !== heaviestIdx && exec.slowCallsCount > 0);

        if (otherSlow.length > 0) {
            console.log(`\nOther executions with slow calls: ${otherSlow.map(o => `#${o.idx + 1}`).join(', ')}`);
            console.log('Use --exec=N to see details for a specific execution.');
        }
    }

    // Step 4: Global summary
    printGlobalSummary(executions);

    // Step 5: Try to get stage data from logs if available
    await printStageDataIfAvailable(db, executions, prNumber, orgId);
}

async function printStageDataIfAvailable(
    db: Db,
    executions: ExecutionData[],
    prNumber: number,
    orgId: string,
): Promise<void> {
    // Try to find pipeline stage logs via any correlationId
    for (const exec of executions) {
        const pipelineLog = await db.collection('observability_logs_ts').findOne({
            correlationId: exec.correlationId,
            'attributes.pipelineId': { $exists: true },
        }, {
            projection: { 'attributes.pipelineId': 1 },
        });

        if (!pipelineLog) continue;

        const pipelineId = (pipelineLog as any).attributes?.pipelineId;
        if (!pipelineId) continue;

        const stagesAgg = await db.collection('observability_logs_ts').aggregate([
            {
                $match: {
                    'attributes.pipelineId': pipelineId,
                    message: { $regex: 'Stage.*completed' },
                },
            },
            {
                $addFields: {
                    stageName: '$attributes.stage',
                    durationMs: {
                        $toInt: {
                            $arrayElemAt: [
                                {
                                    $split: [
                                        { $arrayElemAt: [{ $split: ['$message', 'completed in '] }, 1] },
                                        'ms',
                                    ],
                                },
                                0,
                            ],
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    stage: '$stageName',
                    durationMs: 1,
                    timestamp: 1,
                },
            },
            { $sort: { timestamp: 1 } },
        ]).toArray();

        if (stagesAgg.length === 0) continue;

        const totalDuration = stagesAgg.reduce((sum: number, s: any) => sum + (s.durationMs || 0), 0);

        console.log(`\nSTAGE TIMES (from pipeline ${truncate(pipelineId, 36)}, execution corr: ${truncate(exec.correlationId, 30)}):`);
        console.log('-'.repeat(80));
        console.log(padRight('Stage', 50) + padLeft('Duration', 15) + padLeft('% Total', 10));
        console.log('-'.repeat(80));

        stagesAgg.forEach((s: any, i: number) => {
            const pct = totalDuration > 0 ? ((s.durationMs / totalDuration) * 100).toFixed(1) : '0';
            const duration = formatDuration(s.durationMs);
            const highlight = s.durationMs > 60000 ? ' ⚠️' : '';
            console.log(padRight(`${i + 1}. ${s.stage}`, 50) + padLeft(duration, 15) + padLeft(`${pct}%`, 10) + highlight);
        });

        console.log('-'.repeat(80));
        console.log(padRight('TOTAL', 50) + padLeft(formatDuration(totalDuration), 15));

        // Only print stage data for the first execution that has it
        return;
    }
}

async function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--env='));

    if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
        console.log(`
PR Performance Analysis CLI

Usage:
  npx ts-node scripts/analyze-pr-performance.cli.ts <prNumber> <orgId> [options]

Arguments:
  prNumber    PR number to analyze (required)
  orgId       Organization ID (required, can be partial)

Options:
  --days=N      Number of days to search back (default: 7)
  --exec=N      Show detail for a specific execution number (default: heaviest)
  --env=PATH    Path to .env file (e.g., --env=.env.prod)

Examples:
  pnpm run analyze-pr 558 04bd288b-595a-4ee1-87cd-8bbbdc312b3c --env=.env.prod
  pnpm run analyze-pr 8 97442318-9d2a-496b-a0d2-b45fb --days=14 --env=.env.prod
  pnpm run analyze-pr 8 97442318-9d2a-496b-a0d2-b45fb --exec=3 --env=.env.prod
`);
        process.exit(0);
    }

    const prNumber = parseInt(args[0], 10);
    if (isNaN(prNumber)) {
        console.error('ERROR: Invalid PR number');
        process.exit(1);
    }

    const orgId = args[1];
    if (!orgId || orgId.startsWith('--')) {
        console.error('ERROR: Organization ID is required');
        process.exit(1);
    }

    const daysArg = args.find(a => a.startsWith('--days='));
    const daysBack = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

    const execArg = args.find(a => a.startsWith('--exec='));
    const detailExecution = execArg ? parseInt(execArg.split('=')[1], 10) : undefined;

    let client: MongoClient | null = null;

    try {
        const uri = buildMongoUri();
        const dbName = process.env.API_MG_DB_DATABASE || 'kodus_db';

        console.log(`Connecting to MongoDB (database: ${dbName})...`);

        client = new MongoClient(uri);
        await client.connect();

        const db = client.db(dbName);

        await analyzePR(db, prNumber, orgId, daysBack, detailExecution);
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
