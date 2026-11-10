import { Injectable, NotFoundException } from '@nestjs/common';

import { reproductionManifest, type ReproductionDownload } from '@libs/runtime/run/reproduction';

import { RuntimeRunAccessService, type RuntimePrincipal } from '../run-access.service';

/**
 * GET /runtime/runs/:id/findings/:probeId/reproduce — recorded data only,
 * never a host-executable replay. 404 when no valid external probe was kept.
 */
@Injectable()
export class GetRuntimeRunReproductionUseCase {
    constructor(private readonly access: RuntimeRunAccessService) {}

    async execute(input: { principal: RuntimePrincipal; runId: string; probeId: string }): Promise<ReproductionDownload> {
        const run = await this.access.load(input.principal, input.runId);
        const out = run.reproduction
            ? reproductionManifest({
                  runId: run.runId,
                  imageId: run.imageId,
                  repositoryName: run.repositoryName,
                  prNumber: run.prNumber,
                  baseSha: run.baseSha,
                  headSha: run.headSha,
                  reproduction: run.reproduction,
                  probeId: input.probeId,
              })
            : undefined;
        if (!out) throw new NotFoundException('no reproduction for this finding');
        return out;
    }
}
