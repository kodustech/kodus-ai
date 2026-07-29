import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { isV2Config } from '@libs/llm/byok-config';
import { findModelReferences } from '@libs/llm/validate-byok-config-refs';
import { BadRequestException, Injectable, Inject } from '@nestjs/common';

/**
 * Delete target: the retained legacy slot delete (`'main'` | `'fallback'`) OR a
 * v2 delete-by-model-id (`{ modelId }`). The legacy path is unchanged; the v2
 * path runs the referential-integrity guard (REQ-DELETE-01).
 */
export type DeleteByokTarget = 'main' | 'fallback' | { modelId: string };

/**
 * Scan a single scope's `configs` for a reference to the model being deleted.
 * A repo/folder override can point at a v2 model by its stable id (`byokModelId`,
 * RFC §4.2) or, in the legacy read window, by the model NAME (`byokModel`). An
 * empty-string value means "inherit" and is NOT a reference.
 * Returns the field name that matched (`byokModelId` | `byokModel`) or null.
 */
function scopeReference(
    configs: unknown,
    modelId: string,
    modelName?: string,
): 'byokModelId' | 'byokModel' | null {
    const c = configs as
        | { byokModel?: unknown; byokModelId?: unknown }
        | undefined;

    const overrideId =
        typeof c?.byokModelId === 'string' ? c.byokModelId.trim() : '';
    if (overrideId && overrideId === modelId) {
        return 'byokModelId';
    }

    const overrideName =
        typeof c?.byokModel === 'string' ? c.byokModel.trim() : '';
    if (modelName && overrideName && overrideName === modelName) {
        return 'byokModel';
    }

    return null;
}

/**
 * Enumerate every per-repo/dir override that references the model being deleted
 * (by `byokModelId` or, in the legacy window, by `byokModel` name). Returns
 * human-readable scope labels (ids/names only — never key material) so the delete
 * rejection can name WHERE the model is used. Mirrors the traversal shape of
 * `model-overrides.util`'s `collectModelOverrides` (global → repository → dir).
 */
export function findRepoFolderModelReferences(
    codeReviewConfig: unknown,
    modelId: string,
    modelName?: string,
): string[] {
    const config = codeReviewConfig as
        | {
              configs?: unknown;
              repositories?: Array<{
                  id?: string;
                  name?: string;
                  configs?: unknown;
                  directories?: Array<{
                      id?: string;
                      name?: string;
                      configs?: unknown;
                  }>;
              }>;
          }
        | undefined;

    if (!config || !modelId) {
        return [];
    }

    const refs: string[] = [];

    const globalRef = scopeReference(config.configs, modelId, modelName);
    if (globalRef) {
        refs.push(`global override (${globalRef})`);
    }

    for (const repo of config.repositories ?? []) {
        const repoLabel = repo?.name ?? repo?.id ?? '(unknown repository)';
        const repoRef = scopeReference(repo?.configs, modelId, modelName);
        if (repoRef) {
            refs.push(`repository "${repoLabel}" (${repoRef})`);
        }
        for (const dir of repo?.directories ?? []) {
            const dirLabel = dir?.name ?? dir?.id ?? '(unknown directory)';
            const dirRef = scopeReference(dir?.configs, modelId, modelName);
            if (dirRef) {
                refs.push(
                    `directory "${dirLabel}" in repository "${repoLabel}" (${dirRef})`,
                );
            }
        }
    }

    return refs;
}

@Injectable()
export class DeleteByokConfigUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
    ) {}

    async execute(
        organizationId: string,
        target: DeleteByokTarget,
    ): Promise<boolean> {
        // ── Legacy path (configType slot delete) — unchanged. ──────────────
        if (target === 'main' || target === 'fallback') {
            return await this.organizationParametersService.deleteByokConfig(
                organizationId,
                target,
            );
        }

        // ── v2 delete-by-model-id path (REQ-DELETE-01). ────────────────────
        const modelId = target?.modelId;
        if (!modelId) {
            throw new BadRequestException(
                'modelId is required to delete a v2 BYOK model',
            );
        }

        const organizationAndTeamData = { organizationId };

        const byokEntity = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            organizationAndTeamData,
        );
        const config = byokEntity?.configValue;
        if (!config) {
            throw new BadRequestException('BYOK configuration not found');
        }
        if (!isV2Config(config)) {
            throw new BadRequestException(
                'Model-level delete requires a v2 BYOK configuration',
            );
        }

        // Referential-integrity guard: reject if any routing ref
        // (defaultModelId / fallbackModelId / taskOverrides[*]) OR any
        // repo/folder override points at this model — deleting it would orphan
        // that reference (RESEARCH Security "Orphaned routing ref via delete").
        const routingRefs = findModelReferences(config, modelId);

        const model = (config.models ?? []).find((m) => m?.id === modelId);

        const codeReviewConfig = await this.parametersService
            .findByKey(ParametersKey.CODE_REVIEW_CONFIG, organizationAndTeamData)
            .then((p) => p?.configValue ?? null)
            .catch(() => null);
        const overrideRefs = findRepoFolderModelReferences(
            codeReviewConfig,
            modelId,
            model?.model,
        );

        const usages = [...routingRefs, ...overrideRefs];
        if (usages.length > 0) {
            throw new BadRequestException(
                `Model "${modelId}" is in use and cannot be deleted. ` +
                    `Remove these references first: ${usages.join('; ')}.`,
            );
        }

        // Clear: hand the validated model id to the service, which performs the
        // removal (drop the models[] entry + any now-orphan non-managed
        // credential) and the last-model disconnect (removes the whole config).
        return await this.organizationParametersService.deleteByokModel(
            organizationId,
            modelId,
        );
    }
}
