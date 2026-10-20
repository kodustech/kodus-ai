/** Authenticated area-map read against the preview API and its own MongoDB. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { buildCodeAreaRiskMap } from '../../libs/platformData/domain/code-area-risk/build-area-risk-map';
import { mongoMigrationClient } from '../../libs/core/infrastructure/database/mongo/mongo-migration-client';

const api = (
    process.env.PREVIEW_SEED_API_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');
const password = process.env.PREVIEW_SEED_PASSWORD;
if (!password)
    throw new Error('PREVIEW_SEED_PASSWORD is required for the smoke');

async function main() {
    const repositoryId = `preview-area-map-smoke-${randomUUID()}`;
    const path = `/code-management/area-risk-map?repositoryId=${repositoryId}`;
    const unauthenticated = await fetch(`${api}${path}`);
    if (unauthenticated.status !== 401) {
        throw new Error(
            `Area-map route without auth returned ${unauthenticated.status}`,
        );
    }

    const login = await fetch(`${api}/auth/login`, {
        method: 'POST',
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
    const mongo = await mongoMigrationClient();
    const collection = mongo.db.collection('codeAreaRiskMaps');
    const key = { organizationId, repositoryId };
    try {
        await collection.insertOne({ ...key, snapshot });
        const response = await fetch(`${api}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
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
        await collection.deleteOne(key);
        await mongo.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
