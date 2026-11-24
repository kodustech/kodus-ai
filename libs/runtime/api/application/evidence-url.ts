import { ServiceUnavailableException } from '@nestjs/common';

import { EVIDENCE_MAX_TTL_SECONDS, signEvidenceUrl, type SignedEvidenceUrl } from '@libs/runtime/contracts/evidence';
import { presignEvidenceRead } from '@libs/runtime/contracts/evidence-s3';

import type { RuntimeApiConfig } from '../domain/ports';

/**
 * A URL of at most 5 minutes for the exact evidence key, as the deployment serves evidence: a presigned GET of the bucket, or a signed
 * URL of the evidence server. The caller has already decided the key is one the user may read; this only signs it.
 */
export function signedEvidenceUrlOf(config: Pick<RuntimeApiConfig, 'evidenceStore' | 'evidenceS3' | 'evidenceBaseUrl' | 'evidenceSigningSecret' | 'evidenceTtlSeconds'>, key: string, now: Date): SignedEvidenceUrl & { key: string } {
    const ttlSeconds = Math.min(config.evidenceTtlSeconds, EVIDENCE_MAX_TTL_SECONDS);
    if (config.evidenceStore === 's3') {
        if (!config.evidenceS3) throw new ServiceUnavailableException('Runtime evidence bucket is not configured');
        // A presigned GET of the bucket: always an attachment of the type's content type (evidence-s3.ts).
        return { ...presignEvidenceRead(config.evidenceS3, { key, ttlSeconds, now }), key };
    }
    if (!config.evidenceBaseUrl || !config.evidenceSigningSecret) throw new ServiceUnavailableException('Runtime evidence server is not configured');
    return { ...signEvidenceUrl({ baseUrl: config.evidenceBaseUrl, key, secret: config.evidenceSigningSecret, ttlSeconds, now }), key };
}
