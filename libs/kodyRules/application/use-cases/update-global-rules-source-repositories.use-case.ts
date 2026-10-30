import { createLogger } from '@libs/core/log/logger';
import { ForbiddenException, Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    GlobalRulesSourceConfig,
    GlobalRulesSourceRepository,
} from '../../domain/interfaces/global-rules-source.interface';

@Injectable()
export class UpdateGlobalRulesSourceRepositoriesUseCase {
    private readonly logger = createLogger(
        UpdateGlobalRulesSourceRepositoriesUseCase.name,
    );

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        private readonly permissionValidationService: PermissionValidationService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    /**
     * Persists the new set of global-rules source repositories and reconciles
     * the imported rules against it:
     *   - repos ADDED since the last save  → scan and import (background).
     *   - repos REMOVED since the last save → soft-delete their global rules.
     *   - repos left unchanged              → left alone (already imported).
     *
     * The source list is restricted to repositories the user has already
     * selected for the org (git settings), matching the picker on the frontend.
     */
    async execute(params: {
        teamId: string;
        repositories: GlobalRulesSourceRepository[];
        organizationId?: string;
    }): Promise<GlobalRulesSourceRepository[]> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId:
                params.organizationId ?? this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        // Plan gate. Free orgs cannot use the feature at all — block the mutation
        // outright (the UI also grays the control out, but never trust the
        // client). Trial/paid proceed; the per-rule trial cap is enforced during
        // the actual import in KodyRulesSyncService.syncRepositoryGlobal.
        const tier =
            await this.permissionValidationService.resolveGlobalRulesImportTier(
                organizationAndTeamData,
                UpdateGlobalRulesSourceRepositoriesUseCase.name,
            );
        if (tier === 'free') {
            throw new ForbiddenException(
                'Importing global Kody Rules is not available on the Free plan. Upgrade to enable it.',
            );
        }

        // Resolve the requested ids against the org's repositories SELECTED in
        // git settings (the ones with a webhook installed). This keeps a single
        // source of truth for "connected repos" and guarantees the global
        // rules stay updated via the PR-merge trigger. Also gives the persisted
        // entry a trustworthy name/fullName and rejects ids the user can't use.
        const availableRepos =
            (await this.codeManagementService.getRepositories({
                organizationAndTeamData,
            })) ?? [];
        const availableById = new Map(
            (Array.isArray(availableRepos) ? availableRepos : [])
                .filter((r: any) => r?.selected === true || r?.isSelected === true)
                .map((r: any) => [String(r.id), r]),
        );

        const nextRepositories: GlobalRulesSourceRepository[] = [];
        for (const requested of params.repositories ?? []) {
            const match = availableById.get(String(requested.id));
            if (!match) {
                this.logger.warn({
                    message:
                        'Ignoring global-rules source repo not available to org',
                    context: UpdateGlobalRulesSourceRepositoriesUseCase.name,
                    metadata: {
                        organizationAndTeamData,
                        requestedId: requested.id,
                    },
                });
                continue;
            }
            nextRepositories.push({
                id: String(match.id),
                name: match.name,
                fullName:
                    (match as any)?.fullName ||
                    `${(match as any)?.organizationName || ''}/${match.name}`,
            });
        }

        const previous = await this.getCurrentRepositories(
            organizationAndTeamData,
        );
        const previousIds = new Set(previous.map((r) => String(r.id)));
        const nextIds = new Set(nextRepositories.map((r) => String(r.id)));

        const added = nextRepositories.filter(
            (r) => !previousIds.has(String(r.id)),
        );
        const removed = previous.filter((r) => !nextIds.has(String(r.id)));

        // Persist the new selection as the source of truth first; rule
        // reconciliation follows and can be retried via resync if it fails.
        await this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.GLOBAL_RULES_SOURCE_REPOSITORIES,
            { repositories: nextRepositories } as GlobalRulesSourceConfig,
            organizationAndTeamData,
        );

        // Removed repos: soft-delete their global rules synchronously (fast, DB).
        for (const repo of removed) {
            await this.kodyRulesSyncService.purgeGlobalRulesForSourceRepository({
                organizationAndTeamData,
                sourceRepositoryId: String(repo.id),
            });
        }

        // Added repos: full scan + import can be slow (LLM), so run detached
        // and let the HTTP response return — mirrors the onboarding sync.
        if (added.length > 0) {
            setImmediate(async () => {
                for (const repo of added) {
                    await this.kodyRulesSyncService.syncRepositoryGlobal({
                        organizationAndTeamData,
                        repository: {
                            id: String(repo.id),
                            name: repo.name,
                            fullName: repo.fullName,
                        },
                    });
                }
            });
        }

        this.logger.log({
            message: `[kody-rules-global-sync] source list updated: +${added.length} added, -${removed.length} removed, ${nextRepositories.length} total`,
            context: UpdateGlobalRulesSourceRepositoriesUseCase.name,
            metadata: {
                organizationAndTeamData,
                added: added.map((r) => r.id),
                removed: removed.map((r) => r.id),
            },
        });

        return nextRepositories;
    }

    private async getCurrentRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<GlobalRulesSourceRepository[]> {
        const parameter = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.GLOBAL_RULES_SOURCE_REPOSITORIES,
            organizationAndTeamData,
        );
        const config = parameter?.configValue as
            | GlobalRulesSourceConfig
            | undefined;
        return Array.isArray(config?.repositories) ? config.repositories : [];
    }
}
