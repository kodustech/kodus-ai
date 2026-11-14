import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import {
    EVIDENCE_MAX_TTL_SECONDS,
    evidenceKey,
    InvalidEvidenceKeyError,
    signEvidenceUrl,
    type SignedEvidenceUrl,
} from '../../domain/evidence';
import { presignEvidenceRead } from '@libs/runtime/contracts/evidence-s3';
import { RUNTIME_API_CONFIG, RUNTIME_CLOCK, type Clock, type RuntimeApiConfig } from '../../domain/ports';
import { RuntimeRunAccessService } from '../run-access.service';

/**
 * GET /runtime/runs/:id/evidence/:stepId — a URL of at most 5 minutes for the
 * exact key {orgId}/{runId}/{side}/{stepId}/{type}, built here from the Run the
 * caller was authorized for, served as an attachment on the isolated origin.
 */
@Injectable()
export class GetRuntimeRunEvidenceUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: {
        user: Partial<IUser>;
        runId: string;
        stepId: string;
        side?: string;
        type?: string;
    }): Promise<SignedEvidenceUrl & { key: string }> {
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId);
        let key: string;
        try {
            key = evidenceKey({
                organizationId: run.organizationId,
                runId: run.runId,
                side: input.side ?? 'pr',
                stepId: input.stepId,
                type: input.type ?? 'output',
            });
        } catch (e) {
            if (e instanceof InvalidEvidenceKeyError) throw new BadRequestException(e.message);
            throw e;
        }
        const ttlSeconds = Math.min(this.config.evidenceTtlSeconds, EVIDENCE_MAX_TTL_SECONDS);
        if (this.config.evidenceStore === 's3') {
            if (!this.config.evidenceS3) throw new ServiceUnavailableException('Runtime evidence bucket is not configured');
            // A presigned GET of the bucket: always an attachment of the type's content type (evidence-s3.ts).
            return { ...presignEvidenceRead(this.config.evidenceS3, { key, ttlSeconds, now: this.now() }), key };
        }
        if (!this.config.evidenceBaseUrl || !this.config.evidenceSigningSecret) {
            throw new ServiceUnavailableException('Runtime evidence server is not configured');
        }
        const signed = signEvidenceUrl({
            baseUrl: this.config.evidenceBaseUrl,
            key,
            secret: this.config.evidenceSigningSecret,
            ttlSeconds,
            now: this.now(),
        });
        return { ...signed, key };
    }
}
