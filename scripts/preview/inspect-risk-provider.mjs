// Read-only provider metadata for the QA PR selected by the workflow.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { approvalPrMetadataKey } from '../../libs/code-review/domain/approval/approval-pr-metadata.ts';

const [, repositoryId, prNumber] = process.env.RISK_INSPECT.split(',');
if (!/^\d+$/.test(repositoryId) || !/^[1-9]\d*$/.test(prNumber))
    throw new Error('A numeric QA repository and PR are required');
const headers = { Authorization: `Bearer ${process.env.GH_INTEGRATION_TOKEN}` };
const get = async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
        throw new Error(`QA provider read returned HTTP ${response.status}`);
    return response.json();
};
const repo = await get(`/repositories/${repositoryId}`);
const root = `/repos/${repo.full_name}`;
const pr = await get(`${root}/pulls/${prNumber}`);
const comments = await get(`${root}/issues/${prNumber}/comments?per_page=100`);
const lines = readFileSync(
    'tests/e2e/evidence/qa-execution-inspection.txt',
    'utf8',
).split('\n');
const evidence = JSON.parse(
    lines.find((line) => line.startsWith('RISK_E2E_JSON=')).slice(14),
);
const normalized = { ...pr, labels: pr.labels.map((label) => label.name) };
const decision = evidence.execution?.decision;
const originalBody =
    'Isolated risk-routing QA fixture. No customer code or data.';
console.log(
    JSON.stringify(
        {
            state: pr.state,
            headSha: pr.head.sha,
            baseSha: pr.base.sha,
            metadataKey: approvalPrMetadataKey(normalized),
            matchesReviewedHead: pr.head.sha === decision?.reviewedHeadSha,
            matchesReviewedBase: pr.base.sha === decision?.reviewedBaseSha,
            matchesReviewedMetadata:
                approvalPrMetadataKey(normalized) ===
                decision?.reviewedMetadataKey,
            matchesOriginalFixtureBody:
                approvalPrMetadataKey({ ...normalized, body: originalBody }) ===
                decision?.reviewedMetadataKey,
            bodyChangedFromFixture: pr.body !== originalBody,
            bodyHash: createHash('sha256')
                .update(pr.body ?? '')
                .digest('hex'),
            comments: comments.map((comment) => ({
                id: comment.id,
                author: comment.user.login,
                createdAt: comment.created_at,
                updatedAt: comment.updated_at,
                decision: comment.body.includes(
                    '<!-- kodus-conditional-approval -->',
                ),
            })),
        },
        null,
        2,
    ),
);
