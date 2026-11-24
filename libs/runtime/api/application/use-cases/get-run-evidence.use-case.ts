import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { evidenceKey, InvalidEvidenceKeyError, type SignedEvidenceUrl } from '@libs/runtime/contracts/evidence';
import { signedEvidenceUrlOf } from '../evidence-url';
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
        return signedEvidenceUrlOf(this.config, key, this.now());
    }
}
