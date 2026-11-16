// Read-only evidence from the same databases the Runo worker writes.
const { createHash } = require('node:crypto');
const hash = (value) =>
    typeof value === 'string'
        ? createHash('sha256').update(value).digest('hex')
        : undefined;
const oneOf = (value, allowed) => (allowed.includes(value) ? value : undefined);
const id = (value) =>
    typeof value === 'string' && /^[a-f0-9-]{8,64}$/i.test(value)
        ? value
        : undefined;

// Evidence exports machine decisions and opaque identities, never model prose,
// prompts, tool outputs, credential material or free-form error messages.
function executionEvidence(row) {
    if (!row) return null;
    return {
        uuid: id(row.uuid),
        status: oneOf(row.status, [
            'pending',
            'in_progress',
            'queued',
            'success',
            'error',
            'partial_error',
            'skipped',
        ]),
        createdAt: row.createdAt,
        heavy: row.heavy === true,
        risk: row.risk
            ? {
                  status: oneOf(row.risk.status, [
                      'assessed',
                      'unavailable',
                      'disabled',
                  ]),
                  ...(typeof row.risk.riskIdentified === 'boolean'
                      ? { riskIdentified: row.risk.riskIdentified }
                      : {}),
              }
            : undefined,
        decision: row.decision
            ? {
                  kind: oneOf(row.decision.kind, [
                      'approve',
                      'hold',
                      'out-of-scope',
                  ]),
                  reviewedHeadSha: id(row.decision.reviewedHeadSha),
                  reasonCode:
                      row.decision.reason ===
                      'Approval conditions could not be verified.'
                          ? 'conditions-unverified'
                          : undefined,
              }
            : undefined,
        eligibility: Object.fromEntries(
            Object.entries(row.eligibility ?? {}).map(([key, value]) => [
                hash(key),
                {
                    key: hash(value.key),
                    status: oneOf(value.status, [
                        'eligible',
                        'ineligible',
                        'unavailable',
                    ]),
                },
            ]),
        ),
        agentSkips: (row.agentSkips ?? []).map((skip) => ({
            id: skip.id === 'qa-risk-watch' ? skip.id : hash(skip.id),
            reason: 'Risk condition not met.',
        })),
    };
}

async function main() {
    require('dotenv/config');
    require('ts-node/register/transpile-only');
    require('tsconfig-paths/register');
    const { Client } = require('pg');
    const {
        mongoMigrationClient,
    } = require('../../libs/core/infrastructure/database/mongo/mongo-migration-client');

    if (process.env.PREVIEW_RISK_ROUTING_QA !== 'true')
        throw new Error('Preview QA opt-in required');
    const [organizationId, repositoryId, number, since] = process.argv.slice(2);
    if (
        !/^[a-f0-9-]{36}$/i.test(organizationId ?? '') ||
        !/^[a-z0-9_-]+$/i.test(repositoryId ?? '') ||
        !/^[1-9][0-9]*$/.test(number ?? '') ||
        !Number.isFinite(Date.parse(since))
    )
        throw new Error('Invalid evidence scope');
    const sql = new Client({
        host: process.env.API_PG_DB_HOST,
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
    });
    await sql.connect();
    let mongo;
    try {
        const { rows } = await sql.query(
            `
            SELECT uuid, status, "createdAt", "errorMessage", "dataExecution"->'riskAssessment' AS risk,
                "dataExecution"->'heavy' AS heavy,
                "dataExecution"->'approvalDecision' AS decision,
                "dataExecution"->'approvalPolicyEligibility' AS eligibility,
                "dataExecution"->'approvalReviewSummary' AS "reviewSummary",
                "dataExecution"->'customAgentRiskSkips' AS "agentSkips"
            FROM automation_execution
            WHERE "dataExecution"#>>'{organizationAndTeamData,organizationId}'=$1
                AND "repositoryId"=$2 AND "pullRequestNumber"=$3 AND "createdAt">=$4
            ORDER BY "createdAt" DESC LIMIT 1`,
            [organizationId, repositoryId, Number(number), since],
        );
        const execution = rows[0] ?? null;
        if (process.argv.includes('--approval-only')) {
            console.log(
                'RISK_E2E_JSON=' +
                    JSON.stringify({
                        execution: executionEvidence(execution),
                        stages: [],
                        agents: [],
                        models: [],
                    }),
            );
            return;
        }
        const relatedExecutions = (
            await sql.query(
                `
            SELECT uuid,status,"createdAt",
                "dataExecution"#>>'{organizationAndTeamData,organizationId}' AS "organizationId"
            FROM automation_execution WHERE "repositoryId"=$1 AND "pullRequestNumber"=$2
                AND "createdAt">=$3 ORDER BY "createdAt" LIMIT 10`,
                [repositoryId, Number(number), since],
            )
        ).rows;
        const stages = execution
            ? (
                  await sql.query(
                      `
                SELECT stage_name AS name,status,message,
                    metadata#>>'{agentTrace,error,name}' AS "errorName",
                    metadata#>>'{agentTrace,error,message}' AS "errorMessage"
                FROM code_review_execution
            WHERE automation_execution_id=$1 ORDER BY "createdAt"`,
                      [execution.uuid],
                  )
              ).rows
            : [];
        mongo = await mongoMigrationClient();
        const agents = await mongo.db
            .collection('customAgentRuns')
            .find(
                {
                    organizationId,
                    repositoryId,
                    prNumber: Number(number),
                    at: { $gte: new Date(since) },
                },
                { projection: { _id: 0, agentId: 1, status: 1, reason: 1 } },
            )
            .toArray();
        const models = await mongo.db
            .collection('observability_telemetry')
            .aggregate([
                {
                    $match: {
                        'attributes.organizationId': organizationId,
                        'attributes.prNumber': {
                            $in: [Number(number), number],
                        },
                        'attributes.tu.total': { $gt: 0 },
                    },
                },
                {
                    $group: {
                        _id: {
                            task: '$attributes.tu.route',
                            model: '$attributes.tu.model',
                            runName: {
                                $getField: {
                                    field: 'gen_ai.run.name',
                                    input: '$attributes',
                                },
                            },
                        },
                        calls: { $sum: 1 },
                        tokens: { $sum: '$attributes.tu.total' },
                    },
                },
                {
                    $project: {
                        _id: 0,
                        task: '$_id.task',
                        model: '$_id.model',
                        runName: '$_id.runName',
                        calls: 1,
                        tokens: 1,
                    },
                },
            ])
            .toArray();
        const logs = await mongo.db
            .collection('observability_logs_ts')
            .find(
                {
                    $or: [
                        {
                            tenantId: {
                                $in: [
                                    organizationId,
                                    ...relatedExecutions
                                        .map((row) => row.organizationId)
                                        .filter(Boolean),
                                ],
                            },
                        },
                        ...(execution
                            ? [
                                  { executionId: execution.uuid },
                                  { correlationId: execution.uuid },
                              ]
                            : []),
                    ],
                    timestamp: { $gte: new Date(since) },
                },
                {
                    projection: {
                        '_id': 0,
                        'timestamp': 1,
                        'tenantId': 1,
                        'level': 1,
                        'component': 1,
                        'message': 1,
                        'error.name': 1,
                        'error.message': 1,
                    },
                },
            )
            .sort({ timestamp: -1 })
            .limit(80)
            .toArray();
        console.log(
            'RISK_E2E_JSON=' +
                JSON.stringify({
                    execution: executionEvidence(execution),
                    relatedExecutions: relatedExecutions.map((row) => ({
                        uuid: id(row.uuid),
                        status: oneOf(row.status, [
                            'pending',
                            'in_progress',
                            'success',
                            'error',
                            'skipped',
                        ]),
                    })),
                    stages: stages.map((stage) => ({
                        name: /^[A-Za-z]+Stage$/.test(stage.name)
                            ? stage.name
                            : 'UnknownStage',
                        status: oneOf(stage.status, [
                            'success',
                            'error',
                            'skipped',
                            'in_progress',
                            'completed',
                            'pending',
                        ]),
                    })),
                    agents: agents.map((agent) => ({
                        agentId:
                            agent.agentId === 'qa-risk-watch'
                                ? agent.agentId
                                : hash(agent.agentId),
                        status: oneOf(agent.status, [
                            'ran',
                            'skipped',
                            'failed',
                        ]),
                    })),
                    models: models.map((model) => ({
                        task: oneOf(model.task, [
                            'riskAssessment',
                            'codeReview',
                            'codeReviewHeavy',
                            'customAgent',
                            'prSummary',
                            'businessValidation',
                            'kodyRulesReview',
                        ]),
                        model: hash(model.model),
                        runName: oneOf(model.runName, [
                            'pr-risk-assessment',
                            'approval-policy-eligibility',
                        ]),
                        calls: model.calls,
                        tokens: model.tokens,
                    })),
                    logs: logs.map((log) => ({
                        timestamp: log.timestamp,
                        level: oneOf(log.level, [
                            'info',
                            'warn',
                            'error',
                            'debug',
                        ]),
                    })),
                }),
        );
    } finally {
        await sql.end();
        if (mongo) await mongo.close();
    }
}
module.exports = { executionEvidence };
if (require.main === module)
    main().catch(() => {
        console.error('Could not read scoped preview execution evidence');
        process.exit(1);
    });
