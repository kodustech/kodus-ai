/** Authenticated area-map read against the preview API and its own MongoDB. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { buildCodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import { mongoMigrationClient } from '@libs/core/infrastructure/database/mongo/mongo-migration-client';

const FETCH_TIMEOUT_MS = 10_000;
let operation = 'initialize';
let activeRepositoryId = '';
let activeOrganizationId = '';

const api = (
    process.env.PREVIEW_SEED_API_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');
const password = process.env.PREVIEW_SEED_PASSWORD;
if (!password)
    throw new Error('PREVIEW_SEED_PASSWORD is required for the smoke');

async function main() {
    const repositoryId = `preview-area-map-smoke-${randomUUID()}`;
    activeRepositoryId = repositoryId;
    let path = `/code-management/area-risk-map?repositoryId=${repositoryId}`;
    operation = 'unauthenticated area-map read';
    const unauthenticated = await fetch(`${api}${path}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (unauthenticated.status !== 401) {
        throw new Error(
            `Area-map route without auth returned ${unauthenticated.status}`,
        );
    }

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
    if (!login.ok) throw new Error(`Preview login returned ${login.status}`);
    const loginBody = (await login.json()) as {
        data?: { accessToken?: string };
        accessToken?: string;
    };
    const token = loginBody?.data?.accessToken ?? loginBody?.accessToken;
    if (typeof token !== 'string')
        throw new Error('Preview login has no token');
    const claim = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    const organizationId = claim.organizationId;
    if (typeof organizationId !== 'string') {
        throw new Error('Preview token has no organization');
    }
    activeOrganizationId = organizationId;

    operation = 'read preview teams';
    const teamsResponse = await fetch(`${api}/team`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!teamsResponse.ok) {
        throw new Error(`GET /team returned ${teamsResponse.status}`);
    }
    const teamsBody = (await teamsResponse.json()) as {
        data?: Array<{ uuid?: string }> | { uuid?: string };
        uuid?: string;
    };
    const teams = teamsBody?.data ?? teamsBody;
    const teamId = Array.isArray(teams) ? teams[0]?.uuid : teams?.uuid;
    if (!teamId) throw new Error('preview has no team');
    path += `&teamId=${encodeURIComponent(teamId)}`;

    const now = Date.now();
    const snapshot = buildCodeAreaRiskMap({
        source: 'preview-smoke',
        windowStart: new Date(now - 7 * 86400000).toISOString(),
        windowEnd: new Date(now + 1000).toISOString(),
        refreshedAt: new Date(now).toISOString(),
        discoveredMergedPrs: 1,
        scanComplete: true,
        pullRequests: [
            {
                number: 1,
                url: 'https://example.invalid/pull/1',
                title: 'Fix session regression',
                mergedAt: new Date(now - 86400000).toISOString(),
                linkedBugIssues: ['https://example.invalid/issues/1'],
                files: ['src/auth/session.ts'],
                filesComplete: true,
            },
        ],
    });
    operation = 'connect MongoDB';
    const mongo = await mongoMigrationClient();
    const collection = mongo.db.collection('codeAreaRiskMaps');
    const key = { organizationId, repositoryId };
    try {
        operation = 'insert map fixture';
        await collection.insertOne({ ...key, snapshot });
        operation = 'authenticated area-map read';
        const response = await fetch(`${api}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(
                `Authenticated area-map read returned ${response.status}`,
            );
        }
        const body = (await response.json()) as {
            data?: {
                map?: {
                    coverage?: { scannedPrs?: number };
                    directDirectories?: {
                        path: string;
                        linkedBugFixPrs: number;
                    }[];
                };
                topAreas?: { path: string }[];
            };
            map?: {
                coverage?: { scannedPrs?: number };
                directDirectories?: {
                    path: string;
                    linkedBugFixPrs: number;
                }[];
            };
            topAreas?: { path: string }[];
        };
        const result = body?.data ?? body;
        const directArea = result?.map?.directDirectories?.find(
            (area: { path: string }) => area.path === 'src/auth',
        );
        if (
            result?.map?.coverage?.scannedPrs !== 1 ||
            directArea?.linkedBugFixPrs !== 1 ||
            result?.topAreas?.[0]?.path !== 'src/auth'
        ) {
            throw new Error(
                'Area-map API lost coverage, linked bug, or ranking',
            );
        }
        console.log(
            'preview area-map: authenticated read and risk evidence passed',
        );
    } finally {
        operation = 'remove map fixture and close MongoDB';
        await collection.deleteOne(key);
        await mongo.close();
    }
}

main().catch((error) => {
    console.error('preview area-map smoke failed', {
        operation,
        repositoryId: activeRepositoryId,
        organizationId: activeOrganizationId,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
