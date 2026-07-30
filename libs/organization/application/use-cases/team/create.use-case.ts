import { ConflictException, Inject, Injectable } from '@nestjs/common';

import { CreateOrUpdateParametersUseCase } from '../parameters/create-or-update-use-case';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { TeamEntity } from '@libs/organization/domain/team/entities/team.entity';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    KodyLearningStatus,
    PlatformConfigValue,
} from '@libs/organization/domain/parameters/types/configValue.type';
import { ParametersKey } from '@libs/core/domain/enums';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import { createLogger } from '@libs/core/log/logger';
import { buildDefaultGlobalCodeReviewConfig } from '@libs/common/utils/validateCodeReviewConfigFile';

@Injectable()
export class CreateTeamUseCase implements IUseCase {
    private readonly logger = createLogger(CreateTeamUseCase.name);

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly telemetry: TelemetryService,
    ) {}

    public async execute(payload: {
        teamName: string;
        organizationId: string;
        organizationName?: string;
        actorUserId?: string;
    }): Promise<TeamEntity | undefined> {
        const orgId = payload.organizationId;

        const validStatuses = Object.values(STATUS).filter(
            (status) => status !== STATUS.REMOVED,
        );

        const hasTeams = await this.teamService.find(
            {
                name: payload.teamName,
                organization: { uuid: orgId },
            },
            [...validStatuses],
        );

        if (hasTeams?.length) {
            throw new ConflictException('api.team.team_name_already_exists');
        }

        const team = await this.teamService.createTeam({
            ...payload,
            organizationId: orgId,
        });

        if (team && team?.uuid) {
            await this.saveInitialTeamParameters(orgId, team.uuid);
        }

        if (team?.uuid) {
            void this.telemetry.teamCreated({
                teamId: team.uuid,
                name: team.name,
                organizationId: team.organization?.uuid ?? orgId,
                organizationName:
                    team.organization?.name ?? payload.organizationName,
                actorUserId: payload.actorUserId,
            });
        }

        return team;
    }

    savePlatormConfigsParameters(organizationId: string, teamId: string) {
        const initialStatus: PlatformConfigValue = {
            finishOnboard: false,
            finishProjectManagementConnection: false,
            kodyLearningStatus: KodyLearningStatus.ENABLED,
        };

        return this.createOrUpdateParametersUseCase.execute(
            ParametersKey.PLATFORM_CONFIGS,
            initialStatus,
            { organizationId, teamId },
        );
    }

    /**
     * Persist the parameter rows a new team needs before it can be used:
     * `platform_configs` (or finish-onboarding throws "Platform config not
     * found") and the default `code_review_config` (historically created only
     * by the browser during repo selection, so a closed tab or a silent
     * request failure left the team with no config row).
     *
     * Both writes are awaited and retried; a definitive failure is logged
     * (there was previously no server-side signal at all) but never breaks
     * signup — the review-time and repository-sync safeguards recreate the row.
     */
    private async saveInitialTeamParameters(
        organizationId: string,
        teamId: string,
    ): Promise<void> {
        // Independent rows (different configKeys, so no unique-index contention)
        // — run them in parallel so signup only waits for the slower of the two,
        // not their sum. persistWithRetry never rejects, so Promise.all is safe.
        await Promise.all([
            this.persistWithRetry(
                () => this.savePlatormConfigsParameters(organizationId, teamId),
                ParametersKey.PLATFORM_CONFIGS,
                organizationId,
                teamId,
            ),
            this.persistWithRetry(
                () =>
                    this.createOrUpdateParametersUseCase.execute(
                        ParametersKey.CODE_REVIEW_CONFIG,
                        buildDefaultGlobalCodeReviewConfig(),
                        { organizationId, teamId },
                    ),
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationId,
                teamId,
            ),
        ]);
    }

    private async persistWithRetry(
        operation: () => Promise<unknown>,
        parametersKey: ParametersKey,
        organizationId: string,
        teamId: string,
    ): Promise<void> {
        const MAX_ATTEMPTS = 3;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await operation();
                return;
            } catch (error) {
                if (attempt === MAX_ATTEMPTS) {
                    this.logger.error({
                        message: `Failed to persist ${parametersKey} for new team after ${MAX_ATTEMPTS} attempts`,
                        context: CreateTeamUseCase.name,
                        error:
                            error instanceof Error
                                ? error
                                : new Error(String(error)),
                        metadata: { organizationId, teamId, parametersKey },
                    });
                    return;
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, 200 * 4 ** (attempt - 1)),
                );
            }
        }
    }
}
