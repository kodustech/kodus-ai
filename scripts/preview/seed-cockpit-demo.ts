/** Isolated, explicit Cockpit fixture for manual preview QA. */
import 'dotenv/config';

const { Client } = require('pg');

import { buildCodeAreaRiskMap } from '../../libs/platformData/domain/code-area-risk/build-area-risk-map';
import { mongoMigrationClient } from '../../libs/core/infrastructure/database/mongo/mongo-migration-client';

const repositoryId = 'preview-code-area-demo';
const FETCH_TIMEOUT_MS = 10_000;
let operation = 'initialize';
let organizationId = '';
let activeTeamId = '';
const api = (
    process.env.PREVIEW_SEED_API_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');

async function main(): Promise<void> {
    const password = process.env.PREVIEW_SEED_PASSWORD;
    if (!password) throw new Error('PREVIEW_SEED_PASSWORD is required');

    operation = 'preview login';
    const login = await fetch(`${api}/auth/login`, {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: process.env.PREVIEW_SEED_EMAIL ?? 'preview@kodus.io',
            password,
        }),
    });
    if (!login.ok) throw new Error(`preview login returned ${login.status}`);
    const loginBody = (await login.json()) as {
        data?: { accessToken?: string };
        accessToken?: string;
    };
    const token = loginBody.data?.accessToken ?? loginBody.accessToken;
    if (!token) throw new Error('preview login has no token');
    const claims = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as {
        organizationId?: string;
    };
    if (!claims.organizationId)
        throw new Error('preview token has no organization');
    organizationId = claims.organizationId;

    operation = 'read preview teams';
    const teamsResponse = await fetch(`${api}/team`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!teamsResponse.ok)
        throw new Error(`GET /team returned ${teamsResponse.status}`);
    const teamsBody = (await teamsResponse.json()) as any;
    const teams = teamsBody?.data ?? teamsBody;
    const teamId = Array.isArray(teams) ? teams[0]?.uuid : teams?.uuid;
    if (!teamId) throw new Error('preview has no team');
    activeTeamId = teamId;

    operation = 'update selected repositories';
    const postgres = new Client({
        host: process.env.API_PG_DB_HOST,
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: process.env.API_PG_DB_USERNAME,
        password: process.env.API_PG_DB_PASSWORD,
        database: process.env.API_PG_DB_DATABASE,
    });
    await postgres.connect();
    try {
        await postgres.query('BEGIN');
        const existing = await postgres.query(
            `SELECT c.uuid, c."configValue" FROM integration_configs c
             JOIN integrations i ON i.uuid = c.integration_id
             WHERE c.team_id = $1 AND i.organization_id = $2
               AND c."configKey" = 'repositories'
             ORDER BY i.status DESC, c."updatedAt" DESC LIMIT 1 FOR UPDATE OF c`,
            [teamId, claims.organizationId],
        );
        const demoRepository = {
            id: repositoryId,
            name: 'code-area-demo (sample data)',
            full_name: 'preview/code-area-demo (sample data)',
        };
        if (existing.rowCount) {
            const repositories = existing.rows[0].configValue;
            if (!Array.isArray(repositories)) {
                throw new Error('Selected repositories config is not an array');
            }
            if (!repositories.some((repo) => repo.id === repositoryId)) {
                await postgres.query(
                    `UPDATE integration_configs
                     SET "configValue" = $1::jsonb, "updatedAt" = NOW()
                     WHERE uuid = $2`,
                    [
                        JSON.stringify([...repositories, demoRepository]),
                        existing.rows[0].uuid,
                    ],
                );
            }
        } else {
            const integration = await postgres.query(
                `INSERT INTO integrations (status, platform, "integrationCategory", organization_id, team_id)
                 VALUES (false, 'INTERNAL', 'CODE_MANAGEMENT', $1, $2) RETURNING uuid`,
                [claims.organizationId, teamId],
            );
            await postgres.query(
                `INSERT INTO integration_configs ("configKey", "configValue", integration_id, team_id)
                 VALUES ('repositories', $1::jsonb, $2, $3)`,
                [
                    JSON.stringify([demoRepository]),
                    integration.rows[0].uuid,
                    teamId,
                ],
            );
        }
        await postgres.query('COMMIT');
    } catch (error) {
        await postgres.query('ROLLBACK');
        throw error;
    } finally {
        await postgres.end();
    }

    const now = Date.now();
    // Synthetic coverage across all four chart regions; never used by evals.
    const profiles: Array<[string, number, number]> = [
        ['src/auth/session', 28, 17],
        ['src/billing/checkout', 24, 14],
        ['src/payments/refunds', 20, 4],
        ['src/notifications/email', 18, 2],
        ['src/dashboard/charts', 16, 1],
        ['src/auth/sso', 13, 12],
        ['src/billing/invoice', 12, 10],
        ['src/api/webhooks', 10, 7],
        ['src/infra/queue', 9, 1],
        ['src/search/indexing', 8, 5],
        ['src/integrations/github', 7, 1],
        ['src/settings/preferences', 7, 0],
        ['src/reviews/summary', 6, 4],
        ['src/observability/tracing', 5, 0],
        ['src/permissions/roles', 4, 2],
        ['src/teams/members', 3, 1],
        ['src/editor/commands', 3, 0],
        ['src/docs/guides', 3, 1],
        ['src/theme/tokens', 2, 0],
        ['src/i18n/messages', 2, 0],
    ];
    let nextPrNumber = 101;
    const pullRequests = profiles.flatMap(
        ([directory, changedPrs, linkedBugFixPrs], profileIndex) =>
            Array.from({ length: changedPrs }, (_, index) => {
                const number = nextPrNumber++;
                const bugFix = index < linkedBugFixPrs;
                return {
                    number,
                    title: `${bugFix ? 'Fix' : 'Update'} ${directory}`,
                    files: [`${directory}/change-${index}.ts`],
                    linkedBugIssues: bugFix
                        ? [`https://example.invalid/issues/${number}`]
                        : [],
                    url: `https://example.invalid/pull/${number}`,
                    mergedAt: new Date(
                        now - (index + 1) * 86400000 - profileIndex * 3600000,
                    ).toISOString(),
                    filesComplete: true,
                };
            }),
    );
    const snapshot = buildCodeAreaRiskMap({
        source: 'preview-demo',
        windowStart: new Date(now - 30 * 86400000).toISOString(),
        windowEnd: new Date(now).toISOString(),
        refreshedAt: new Date(now).toISOString(),
        discoveredMergedPrs: pullRequests.length,
        scanComplete: true,
        pullRequests,
    });
    const structuralFindings: Record<string, number> = {
        'src/auth/session': 4,
        'src/billing/checkout': 3,
        'src/auth/sso': 2,
        'src/api/webhooks': 1,
        'src/permissions/roles': 1,
        'src/docs/guides': 1,
    };
    snapshot.directDirectories = snapshot.directDirectories.map((area) => ({
        ...area,
        structure: {
            eligibleFiles: 3,
            analyzedFiles: 3,
            functions: 18,
            functionsNeedingAttention: structuralFindings[area.path] ?? 0,
            files: Array.from({ length: 3 }, (_, index) => ({
                path: `${area.path}/sample-${index + 1}.ts`,
                functions: 6,
                functionsNeedingAttention:
                    index === 0 ? (structuralFindings[area.path] ?? 0) : 0,
            })),
        },
    }));
    snapshot.structureCoverage = {
        eligibleFiles: snapshot.directDirectories.length * 3,
        analyzedFiles: snapshot.directDirectories.length * 3,
        sampled: true,
    };
    operation = 'save demo map';
    const mongo = await mongoMigrationClient();
    try {
        await mongo.db
            .collection('codeAreaRiskMaps')
            .updateOne(
                { organizationId: claims.organizationId, repositoryId },
                { $set: { snapshot } },
                { upsert: true },
            );
    } finally {
        await mongo.close();
    }
    const headers = { Authorization: `Bearer ${token}` };
    operation = 'verify selected repositories';
    const selected = await fetch(
        `${api}/code-management/repositories/selected?teamId=${teamId}`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!selected.ok) {
        throw new Error(`selected repositories returned ${selected.status}`);
    }
    const selectedBody = (await selected.json()) as
        { data: Array<{ id: string }> } | Array<{ id: string }>;
    const repositories = Array.isArray(selectedBody)
        ? selectedBody
        : selectedBody.data;
    if (!repositories?.some((repo) => repo.id === repositoryId)) {
        throw new Error('Cockpit demo repository is not visible through API');
    }
    operation = 'verify area map';
    const map = await fetch(
        `${api}/code-management/area-risk-map?repositoryId=${repositoryId}`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!map.ok) throw new Error(`area map returned ${map.status}`);
    const mapBody = (await map.json()) as {
        data?: { topAreas?: Array<{ path: string }> };
        topAreas?: Array<{ path: string }>;
    };
    if (!(mapBody.data ?? mapBody).topAreas?.length) {
        throw new Error('Cockpit demo area map has no ranked areas');
    }
    console.log('seed:preview: Cockpit demo repository and area map available');
}

main().catch((error) => {
    console.error('seed:preview: Cockpit demo failed', {
        operation,
        repositoryId,
        organizationId,
        teamId: activeTeamId,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
