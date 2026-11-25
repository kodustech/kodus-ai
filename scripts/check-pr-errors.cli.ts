#!/usr/bin/env npx ts-node

/**
 * PR Log Check CLI
 *
 * Checks logs for a specific PR and organization. By default shows errors and warnings.
 * Also performs pre-checks on PostgreSQL to verify automation status and webhook reception.
 *
 * Usage:
 *   npx ts-node scripts/check-pr-errors.cli.ts <prNumber> <orgId> [options]
 *
 * Examples:
 *   npx ts-node scripts/check-pr-errors.cli.ts 723 97442318-9d2a-496b-a0d2-b45fb --env=.env.prod
 *   npx ts-node scripts/check-pr-errors.cli.ts 701 97442318-9d2a-496b-a0d2-b45fb --all --env=.env.prod
 *   npx ts-node scripts/check-pr-errors.cli.ts 701 97442318-9d2a-496b-a0d2-b45fb --legacy --env=.env.prod
 *
 * Options:
 *   --days=N    Number of days to search back (default: 7)
 *   --all       Show all log levels (debug, info, warn, error). Default: error + warn
 *   --legacy    Also search in legacy collection (observability_logs)
 *   --env=PATH  Path to .env file
 *
 * Environment variables (uses .env):
 *   MONGODB_URI or API_MG_DB_* variables
 *   API_PG_DB_HOST, API_PG_DB_PORT, API_PG_DB_USERNAME, API_PG_DB_PASSWORD, API_PG_DB_DATABASE
 *
 * Pre-checks performed:
 *   1. Code Review automation is active for the organization
 *   2. Webhook received (workflow_jobs table)
 *   3. Automation execution exists (automation_execution table)
 *   4. MongoDB logs exist for the PR
 */

import * as dotenv from 'dotenv';
import { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import * as path from 'path';

// Load .env
const envArg = process.argv.find(a => a.startsWith('--env='));
const envPath = envArg
    ? path.resolve(envArg.split('=')[1])
    : process.env.DOTENV_CONFIG_PATH
        ? path.resolve(process.env.DOTENV_CONFIG_PATH)
        : path.resolve(__dirname, '../.env');

dotenv.config({ path: envPath });

// ==================== INTERFACES ====================

interface ErrorLog {
    timestamp: Date;
    level: string;
    component?: string;
    message: string;
    error?: string;
    stack?: string;
    correlationId?: string;
    pipelineId?: string;
}

interface PreCheckResult {
    check: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    details?: any;
}

interface CodeReviewAutomationInfo {
    teamId: string;
    teamName: string;
    automationStatus: boolean;
    teamAutomationId: string;
}

interface WorkflowJobInfo {
    jobId: string;
    status: string;
    workflowType: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    lastError?: string;
    correlationId: string;
}

interface AutomationExecutionInfo {
    executionId: string;
    status: string;
    errorMessage?: string;
    createdAt: Date;
    origin?: string;
    repositoryId?: string;
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

function formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').substring(0, 19);
}

function truncate(str: string, len: number): string {
    if (!str) return '';
    return str.length <= len ? str : str.substring(0, len - 3) + '...';
}

// ==================== POSTGRESQL FUNCTIONS ====================

function buildPostgresPool(): Pool {
    const host = process.env.API_PG_DB_HOST;
    const port = process.env.API_PG_DB_PORT ? parseInt(process.env.API_PG_DB_PORT, 10) : 5432;
    const user = process.env.API_PG_DB_USERNAME;
    const password = process.env.API_PG_DB_PASSWORD;
    const database = process.env.API_PG_DB_DATABASE;

    if (!host || !user || !password || !database) {
        throw new Error('Missing PostgreSQL configuration. Set API_PG_DB_* variables.');
    }

    return new Pool({
        host,
        port,
        user,
        password,
        database,
        ssl: process.env.API_PG_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
        max: 5,
        idleTimeoutMillis: 10000,
    });
}

async function checkCodeReviewAutomationActive(
    pool: Pool,
    orgId: string
): Promise<PreCheckResult> {
    const query = `
        SELECT
            t.uuid as team_id,
            t.name as team_name,
            ta.status as automation_status,
            ta.uuid as team_automation_id
        FROM team_automations ta
        JOIN teams t ON ta.team_id = t.uuid
        JOIN automation a ON ta.automation_id = a.uuid
        WHERE t.organization_id = $1
        AND a.automation_type = 'AutomationCodeReview'
    `;

    try {
        const result = await pool.query(query, [orgId]);

        if (result.rows.length === 0) {
            return {
                check: 'Code Review Automation',
                status: 'error',
                message: 'No Code Review automation configured for this organization',
                details: null,
            };
        }

        const automations: CodeReviewAutomationInfo[] = result.rows.map(row => ({
            teamId: row.team_id,
            teamName: row.team_name,
            automationStatus: row.automation_status,
            teamAutomationId: row.team_automation_id,
        }));

        const activeAutomations = automations.filter(a => a.automationStatus);

        if (activeAutomations.length === 0) {
            return {
                check: 'Code Review Automation',
                status: 'error',
                message: 'Code Review automation exists but is DISABLED for all teams',
                details: automations,
            };
        }

        return {
            check: 'Code Review Automation',
            status: 'ok',
            message: `Code Review automation is ACTIVE for ${activeAutomations.length} team(s)`,
            details: automations,
        };
    } catch (error: any) {
        return {
            check: 'Code Review Automation',
            status: 'error',
            message: `Failed to check: ${error.message}`,
            details: null,
        };
    }
}

async function checkWorkflowJobs(
    pool: Pool,
    orgId: string,
    prNumber: number,
    daysBack: number
): Promise<PreCheckResult> {
    const query = `
        SELECT
            uuid as job_id,
            status,
            workflow_type,
            created_at,
            started_at,
            completed_at,
            last_error,
            correlation_id
        FROM kodus_workflow.workflow_jobs
        WHERE organization_id = $1
        AND (
            payload->>'pullRequestNumber' = $2
            OR payload->'pullRequest'->>'number' = $2
        )
        AND created_at >= NOW() - INTERVAL '${daysBack} days'
        ORDER BY created_at DESC
        LIMIT 10
    `;

    try {
        const result = await pool.query(query, [orgId, prNumber.toString()]);

        if (result.rows.length === 0) {
            return {
                check: 'Webhook Received (workflow_jobs)',
                status: 'error',
                message: `No webhook job found for PR #${prNumber} in the last ${daysBack} days`,
                details: null,
            };
        }

        const jobs: WorkflowJobInfo[] = result.rows.map(row => ({
            jobId: row.job_id,
            status: row.status,
            workflowType: row.workflow_type,
            createdAt: row.created_at,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            lastError: row.last_error,
            correlationId: row.correlation_id,
        }));

        const failedJobs = jobs.filter(j => j.status === 'FAILED');
        const successJobs = jobs.filter(j => j.status === 'SUCCESS' || j.status === 'COMPLETED');

        if (failedJobs.length > 0 && successJobs.length === 0) {
            return {
                check: 'Webhook Received (workflow_jobs)',
                status: 'warning',
                message: `Found ${jobs.length} job(s), but ${failedJobs.length} FAILED`,
                details: jobs,
            };
        }

        return {
            check: 'Webhook Received (workflow_jobs)',
            status: 'ok',
            message: `Found ${jobs.length} workflow job(s) for PR #${prNumber}`,
            details: jobs,
        };
    } catch (error: any) {
        return {
            check: 'Webhook Received (workflow_jobs)',
            status: 'error',
            message: `Failed to check: ${error.message}`,
            details: null,
        };
    }
}

async function checkAutomationExecution(
    pool: Pool,
    orgId: string,
    prNumber: number,
    daysBack: number
): Promise<PreCheckResult> {
    const query = `
        SELECT
            ae.uuid as execution_id,
            ae.status,
            ae.error_message,
            ae.created_at,
            ae.origin,
            ae.repository_id
        FROM automation_execution ae
        JOIN team_automations ta ON ae.team_automation_id = ta.uuid
        JOIN teams t ON ta.team_id = t.uuid
        JOIN automation a ON ta.automation_id = a.uuid
        WHERE t.organization_id = $1
        AND ae.pull_request_number = $2
        AND a.automation_type = 'AutomationCodeReview'
        AND ae.created_at >= NOW() - INTERVAL '${daysBack} days'
        ORDER BY ae.created_at DESC
        LIMIT 10
    `;

    try {
        const result = await pool.query(query, [orgId, prNumber]);

        if (result.rows.length === 0) {
            return {
                check: 'Automation Execution',
                status: 'error',
                message: `No automation execution found for PR #${prNumber}`,
                details: null,
            };
        }

        const executions: AutomationExecutionInfo[] = result.rows.map(row => ({
            executionId: row.execution_id,
            status: row.status,
            errorMessage: row.error_message,
            createdAt: row.created_at,
            origin: row.origin,
            repositoryId: row.repository_id,
        }));

        const failedExecutions = executions.filter(e => e.status === 'ERROR' || e.status === 'FAILED');
        const successExecutions = executions.filter(e => e.status === 'SUCCESS');

        if (failedExecutions.length > 0 && successExecutions.length === 0) {
            return {
                check: 'Automation Execution',
                status: 'warning',
                message: `Found ${executions.length} execution(s), but ${failedExecutions.length} FAILED`,
                details: executions,
            };
        }

        return {
            check: 'Automation Execution',
            status: 'ok',
            message: `Found ${executions.length} automation execution(s) for PR #${prNumber}`,
            details: executions,
        };
    } catch (error: any) {
        return {
            check: 'Automation Execution',
            status: 'error',
            message: `Failed to check: ${error.message}`,
            details: null,
        };
    }
}

async function checkMongoLogsExist(
    db: Db,
    prNumber: number,
    orgId: string,
    daysBack: number
): Promise<PreCheckResult> {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const query = {
        timestamp: { $gte: start },
        $and: [
            {
                $or: [
                    { 'attributes.organizationId': orgId },
                    { 'attributes.organizationAndTeamData.organizationId': orgId }
                ]
            },
            {
                $or: [
                    { 'attributes.prNumber': prNumber },
                    { 'attributes.pullRequest.number': prNumber },
                    { message: { $regex: `PR#${prNumber}` } }
                ]
            }
        ]
    };

    try {
        const count = await db.collection('observability_logs_ts').countDocuments(query);

        if (count === 0) {
            return {
                check: 'MongoDB Logs',
                status: 'error',
                message: `No logs found for PR #${prNumber} in MongoDB`,
                details: { count: 0 },
            };
        }

        return {
            check: 'MongoDB Logs',
            status: 'ok',
            message: `Found ${count} log entries for PR #${prNumber}`,
            details: { count },
        };
    } catch (error: any) {
        return {
            check: 'MongoDB Logs',
            status: 'error',
            message: `Failed to check: ${error.message}`,
            details: null,
        };
    }
}

function printPreCheckResults(results: PreCheckResult[]): void {
    console.log('\n' + '='.repeat(80));
    console.log('PRE-CHECKS');
    console.log('='.repeat(80) + '\n');

    for (const result of results) {
        const icon = result.status === 'ok' ? '✓' : result.status === 'warning' ? '⚠' : '✗';
        const color = result.status === 'ok' ? '\x1b[32m' : result.status === 'warning' ? '\x1b[33m' : '\x1b[31m';
        const reset = '\x1b[0m';

        console.log(`${color}${icon}${reset} ${result.check}`);
        console.log(`  Status: ${color}${result.status.toUpperCase()}${reset}`);
        console.log(`  ${result.message}`);

        if (result.details && result.status !== 'ok') {
            if (Array.isArray(result.details)) {
                console.log('  Details:');
                result.details.slice(0, 3).forEach((d: any, i: number) => {
                    if (d.teamName) {
                        console.log(`    [${i + 1}] Team: ${d.teamName} | Status: ${d.automationStatus ? 'ACTIVE' : 'DISABLED'}`);
                    } else if (d.jobId) {
                        console.log(`    [${i + 1}] Job: ${d.jobId.slice(0, 8)}... | Status: ${d.status} | Type: ${d.workflowType}`);
                        if (d.lastError) {
                            console.log(`         Error: ${truncate(d.lastError, 60)}`);
                        }
                    } else if (d.executionId) {
                        console.log(`    [${i + 1}] Exec: ${d.executionId.slice(0, 8)}... | Status: ${d.status} | Origin: ${d.origin || 'N/A'}`);
                        if (d.errorMessage) {
                            console.log(`         Error: ${truncate(d.errorMessage, 60)}`);
                        }
                    }
                });
                if (result.details.length > 3) {
                    console.log(`    ... and ${result.details.length - 3} more`);
                }
            }
        }
        console.log('');
    }

    const hasErrors = results.some(r => r.status === 'error');
    const hasWarnings = results.some(r => r.status === 'warning');

    if (hasErrors) {
        console.log('\x1b[31mSome pre-checks failed. Review the issues above.\x1b[0m\n');
    } else if (hasWarnings) {
        console.log('\x1b[33mSome pre-checks have warnings. Review the details above.\x1b[0m\n');
    } else {
        console.log('\x1b[32mAll pre-checks passed!\x1b[0m\n');
    }
}

// ==================== MAIN CHECK FUNCTION ====================

async function checkPRErrors(
    db: Db,
    prNumber: number,
    orgId: string,
    daysBack: number = 7,
    includeLegacy: boolean = false,
    allLogs: boolean = false,
    limit: number = 300
): Promise<ErrorLog[]> {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const end = new Date();

    const logLevels = allLogs ? ['debug', 'info', 'warn', 'error'] : ['error', 'warn'];

    console.log(`\n${'='.repeat(80)}`);
    console.log(`PR LOG CHECK - PR #${prNumber}`);
    console.log(`Organization: ${orgId}`);
    console.log(`Log levels: ${logLevels.join(', ')}${allLogs ? ' (all)' : ' (errors/warnings)'}`);
    console.log(`Date range: ${start.toISOString()} - ${end.toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    // Build base query filters
    const baseFilters: any[] = [
        {
            $or: [
                { 'attributes.organizationId': orgId },
                { 'attributes.organizationAndTeamData.organizationId': orgId }
            ]
        },
        {
            $or: [
                { 'attributes.prNumber': prNumber },
                { 'attributes.pullRequest.number': prNumber },
                { message: { $regex: `PR#${prNumber}` } }
            ]
        }
    ];

    // If not all logs, filter by error-related criteria
    if (allLogs) {
        baseFilters.push({ level: { $in: logLevels } });
    } else {
        baseFilters.push({
            $or: [
                { level: { $in: logLevels } },
                { 'attributes.error': { $exists: true } },
                { message: { $regex: /error|exception|failed|failure/i } }
            ]
        });
    }

    const logQuery = {
        timestamp: { $gte: start, $lte: end },
        $and: baseFilters
    };

    console.log(`Searching for logs${includeLegacy ? ' (including legacy)' : ''}...\n`);

    const pipeline: any[] = [
        { $match: logQuery }
    ];

    if (includeLegacy) {
        pipeline.push({
            $unionWith: {
                coll: 'observability_logs',
                pipeline: [{ $match: logQuery }]
            }
        });
    }

    pipeline.push(
        {
            $project: {
                _id: 0,
                timestamp: 1,
                level: 1,
                component: 1,
                message: 1,
                'attributes.error': 1,
                'attributes.stack': 1,
                'attributes.errorMessage': 1,
                correlationId: 1,
                'attributes.pipelineId': 1
            }
        },
        { $sort: { timestamp: 1 } },
        { $limit: limit }
    );

    const errors = await db.collection('observability_logs_ts').aggregate(pipeline).toArray();

    const errorLogs: ErrorLog[] = errors.map((e: any) => ({
        timestamp: e.timestamp,
        level: e.level || 'unknown',
        component: e.component,
        message: e.message,
        error: e.attributes?.error || e.attributes?.errorMessage,
        stack: e.attributes?.stack,
        correlationId: e.correlationId,
        pipelineId: e.attributes?.pipelineId
    }));

    if (errorLogs.length === 0) {
        console.log('No errors found for this PR.\n');

        // Try a broader search without error filter to see if PR exists
        const prExistsQuery = {
            timestamp: { $gte: start, $lte: end },
            $and: [
                {
                    $or: [
                        { 'attributes.organizationId': orgId },
                        { 'attributes.organizationAndTeamData.organizationId': orgId }
                    ]
                },
                {
                    $or: [
                        { 'attributes.prNumber': prNumber },
                        { 'attributes.pullRequest.number': prNumber },
                        { message: { $regex: `PR#${prNumber}` } }
                    ]
                }
            ]
        };

        const prExists = await db.collection('observability_logs_ts').findOne(prExistsQuery) ||
                         await db.collection('observability_logs').findOne(prExistsQuery);

        if (!prExists) {
            console.log(`Note: No logs found at all for PR #${prNumber} with orgId ${orgId}`);
            console.log('Check if the PR number and orgId are correct.\n');
        } else {
            console.log(`PR #${prNumber} found in logs - no errors detected.\n`);
        }
    } else {
        console.log(`Found ${errorLogs.length} error(s):\n`);
        console.log('-'.repeat(80));

        errorLogs.forEach((err, i) => {
            console.log(`\n[${i + 1}] ${formatTimestamp(err.timestamp)} | ${err.level.toUpperCase()}`);
            if (err.component) {
                console.log(`    Component: ${err.component}`);
            }
            if (err.pipelineId) {
                console.log(`    PipelineId: ${err.pipelineId}`);
            }
            if (err.correlationId) {
                console.log(`    CorrelationId: ${err.correlationId}`);
            }
            console.log(`    Message: ${err.message}`);
            if (err.error) {
                console.log(`    Error: ${err.error}`);
            }
            if (err.stack) {
                console.log(`    Stack: ${truncate(err.stack, 200)}`);
            }
            console.log('-'.repeat(80));
        });
    }

    // Also check telemetry for failed operations
    console.log('\nChecking telemetry for failed operations...\n');

    const telemetryErrors = await db.collection('observability_telemetry').find({
        timestamp: { $gte: start, $lte: end },
        'attributes.prNumber': prNumber,
        'attributes.organizationId': orgId,
        $or: [
            { 'attributes.error': { $exists: true } },
            { 'attributes.status': 'error' },
            { 'attributes.success': false }
        ]
    }, {
        projection: {
            _id: 0,
            timestamp: 1,
            name: 1,
            duration: 1,
            'attributes.error': 1,
            'attributes.errorMessage': 1,
            'attributes.status': 1
        }
    }).sort({ timestamp: 1 }).limit(50).toArray();

    if (telemetryErrors.length > 0) {
        console.log(`Found ${telemetryErrors.length} failed operation(s) in telemetry:\n`);
        console.log('-'.repeat(80));

        telemetryErrors.forEach((t: any, i) => {
            console.log(`\n[${i + 1}] ${formatTimestamp(t.timestamp)}`);
            console.log(`    Operation: ${t.name}`);
            console.log(`    Duration: ${t.duration}ms`);
            if (t.attributes?.error) {
                console.log(`    Error: ${t.attributes.error}`);
            }
            if (t.attributes?.errorMessage) {
                console.log(`    Message: ${t.attributes.errorMessage}`);
            }
        });
        console.log('-'.repeat(80));
    } else {
        console.log('No failed operations found in telemetry.\n');
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('Error check complete');
    console.log(`${'='.repeat(80)}\n`);

    return errorLogs;
}

async function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--env='));

    if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
        console.log(`
PR Log Check CLI

Usage:
  npx ts-node scripts/check-pr-errors.cli.ts <prNumber> <orgId> [options]

Arguments:
  prNumber    PR number to check (required)
  orgId       Organization ID (required)

Options:
  --days=N         Number of days to search back (default: 7)
  --limit=N        Max number of logs to return (default: 100)
  --all            Show all logs (debug, info, warn, error). Default: only error + warn
  --legacy         Also search in legacy collection (observability_logs)
  --skip-prechecks Skip PostgreSQL pre-checks (only check MongoDB logs)
  --env=PATH       Path to .env file

Pre-checks performed (requires PostgreSQL):
  1. Code Review automation is active for the organization
  2. Webhook received (workflow_jobs table)
  3. Automation execution exists (automation_execution table)
  4. MongoDB logs exist for the PR

Examples:
  npx ts-node scripts/check-pr-errors.cli.ts 723 97442318-9d2a-496b-a0d2-b45fb --env=.env.prod
  npx ts-node scripts/check-pr-errors.cli.ts 701 97442318-9d2a-496b-a0d2-b45fb --all --env=.env.prod
  npx ts-node scripts/check-pr-errors.cli.ts 701 97442318-9d2a-496b-a0d2-b45fb --limit=500 --env=.env.prod
  npx ts-node scripts/check-pr-errors.cli.ts 701 97442318-9d2a-496b-a0d2-b45fb --skip-prechecks --env=.env.prod
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
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 100;
    const includeLegacy = args.includes('--legacy');
    const allLogs = args.includes('--all');
    const skipPrechecks = args.includes('--skip-prechecks');

    let mongoClient: MongoClient | null = null;
    let pgPool: Pool | null = null;

    try {
        const mongoUri = buildMongoUri();
        const dbName = process.env.API_MG_DB_DATABASE || 'kodus_db';

        console.log(`Using env file: ${envPath}`);
        console.log(`Connecting to MongoDB (database: ${dbName})...`);

        mongoClient = new MongoClient(mongoUri, { appName: 'kodus-script-check-pr-errors' });
        await mongoClient.connect();

        const db = mongoClient.db(dbName);

        // Run pre-checks if not skipped
        if (!skipPrechecks) {
            console.log('Connecting to PostgreSQL...');

            try {
                pgPool = buildPostgresPool();

                // Test connection
                await pgPool.query('SELECT 1');
                console.log('PostgreSQL connected!\n');

                // Run all pre-checks
                const preCheckResults: PreCheckResult[] = [];

                // 1. Check Code Review Automation is active
                preCheckResults.push(await checkCodeReviewAutomationActive(pgPool, orgId));

                // 2. Check workflow_jobs (webhook received)
                preCheckResults.push(await checkWorkflowJobs(pgPool, orgId, prNumber, daysBack));

                // 3. Check automation_execution
                preCheckResults.push(await checkAutomationExecution(pgPool, orgId, prNumber, daysBack));

                // 4. Check MongoDB logs exist
                preCheckResults.push(await checkMongoLogsExist(db, prNumber, orgId, daysBack));

                // Print pre-check results
                printPreCheckResults(preCheckResults);
            } catch (pgError: any) {
                console.log('\x1b[33mWarning: Could not connect to PostgreSQL. Skipping pre-checks.\x1b[0m');
                console.log(`  Reason: ${pgError.message}\n`);
            }
        } else {
            console.log('Skipping pre-checks (--skip-prechecks flag used)\n');
        }

        // Continue with MongoDB error checks
        await checkPRErrors(db, prNumber, orgId, daysBack, includeLegacy, allLogs, limit);
    } catch (error) {
        console.error('ERROR:', error);
        process.exit(1);
    } finally {
        if (mongoClient) {
            await mongoClient.close();
        }
        if (pgPool) {
            await pgPool.end();
        }
    }
}

main();
