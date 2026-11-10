import { loadS3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';

import { S3ObjectClient } from '../shared/s3-object-client';

// Creates the evidence bucket (when missing) and sets its lifecycle rule: the
// evidence prefix expires after 30 days, its staging prefix after one. Reads
// RUNTIME_EVIDENCE_S3_* like the worker; prints no credential. For AWS, a
// Terraform or console rule with the same two prefixes does the same.
//   node -r ts-node/register/transpile-only -r tsconfig-paths/register apps/runtime/src/e2e/evidence-bucket.ts

async function main() {
    const cfg = loadS3EvidenceConfig(process.env);
    const s3 = new S3ObjectClient(cfg);
    const created = await s3.createBucket();
    await s3.putEvidenceLifecycle(Number(process.env.RUNTIME_EVIDENCE_RETENTION_DAYS || 30));
    console.log(`evidence bucket ${cfg.bucket} ${created ? 'created' : 'already there'}; lifecycle: ${cfg.prefix || '(whole bucket)'} 30 days, ${cfg.prefix}.uploads/ 1 day`);
}

main().catch((e) => {
    console.error(`evidence bucket setup failed: ${(e as Error).message}`);
    process.exit(1);
});
