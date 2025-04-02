import {
    SPRINT_REPOSITORY_TOKEN,
    ISprintRepository,
} from '@/core/domain/sprint/contracts/sprint.repository.contracts';
import { ISprintService } from '@/core/domain/sprint/contracts/sprint.service.contract';
import { SprintEntity } from '@/core/domain/sprint/entities/sprint.entity';
import { ISprint } from '@/core/domain/sprint/interface/sprint.interface';
import { Injectable, Inject } from '@nestjs/common';
import { ProjectManagementService } from './platformIntegration/projectManagement.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import * as moment from 'moment-timezone';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { PinoLoggerService } from './logger/pino.service';
import { SPRINT_STATE } from '@/core/domain/sprint/enum/sprintState.enum';
import { COMPILE_STATE } from '@/core/domain/sprint/enum/compileState.enum';
import { FindManyOptions } from 'typeorm';
import { ValidateProjectManagementIntegration } from '@/shared/utils/decorators/validate-project-management-integration.decorator';

@Injectable()
export class SprintService implements ISprintService {
    constructor(
        @Inject(SPRINT_REPOSITORY_TOKEN)
        private readonly sprintRepository: ISprintRepository,

        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    @ValidateProjectManagementIntegration()
    async getCurrentAndPreviousSprintForRetro(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ currentSprint: ISprint; previousSprint: ISprint }> {
        try {
            const sprint = await this.decideWhichSprintShouldBeCompiled(
                organizationAndTeamData,
            );

            let compiledSprint: ISprint = sprint;

            if (sprint.compileState === COMPILE_STATE.ACTIVE) {
                compiledSprint = await this.compileSprint(
                    organizationAndTeamData,
                    sprint.projectManagementSprintId,
                );
            }

            const previousSprint = await this.getPreviousSprintCompiledForTeam(
                organizationAndTeamData,
                compiledSprint,
            );

            return {
                currentSprint: compiledSprint,
                previousSprint: previousSprint,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error while executing Sprint Retro',
                context: SprintService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    @ValidateProjectManagementIntegration()
    async decideWhichSprintShouldBeCompiled(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ISprint> {
        const currentSprint =
            await this.projectManagementService.getCurrentSprintForTeam({
                organizationAndTeamData,
            });

        const now = moment();

        if (
            currentSprint &&
            now.diff(moment(currentSprint.startDate), 'hours') > 24
        ) {
            return {
                projectManagementSprintId: currentSprint.id,
                compileState: COMPILE_STATE.ACTIVE,
                startDate: currentSprint.startDate,
                endDate: currentSprint.endDate,
                goal: currentSprint.goal,
                description: currentSprint.goal,
                name: currentSprint.name,
                state: currentSprint.state,
                value: {},
            };
        }

        const lastSprintCompiledInProjectManagementSoftware =
            await this.projectManagementService.getLastCompletedSprintForTeam({
                organizationAndTeamData,
            });

        const lastSpringCompiledInDB = await this.sprintRepository.findOne({
            projectManagementSprintId:
                lastSprintCompiledInProjectManagementSoftware.id,
        });

        if (lastSpringCompiledInDB && lastSpringCompiledInDB.value) {
            return {
                projectManagementSprintId:
                    lastSpringCompiledInDB.projectManagementSprintId,
                compileState: COMPILE_STATE.ACTIVE,
                startDate:
                    lastSprintCompiledInProjectManagementSoftware.startDate,
                endDate: lastSprintCompiledInProjectManagementSoftware.endDate,
                goal: lastSprintCompiledInProjectManagementSoftware.goal,
                description: lastSprintCompiledInProjectManagementSoftware.goal,
                name: lastSprintCompiledInProjectManagementSoftware.name,
                state: lastSprintCompiledInProjectManagementSoftware.state,
                value: lastSpringCompiledInDB.value,
            };
        }

        return {
            projectManagementSprintId:
                lastSprintCompiledInProjectManagementSoftware.id,
            compileState: COMPILE_STATE.ACTIVE,
            startDate: lastSprintCompiledInProjectManagementSoftware.startDate,
            endDate: lastSprintCompiledInProjectManagementSoftware.endDate,
            goal: lastSprintCompiledInProjectManagementSoftware.goal,
            description: lastSprintCompiledInProjectManagementSoftware.goal,
            name: currentSprint.name,
            state: currentSprint.state,
            value: {},
        };
    }

    private async compileSprint(
        organizationAndTeamData: OrganizationAndTeamData,
        projectManagementSprintId: string,
    ): Promise<ISprint> {
        try {
            const sprint =
                await this.projectManagementService.getSprintByProjectManagementId(
                    {
                        organizationAndTeamData,
                        projectManagementSprintId,
                    },
                );

            const artifacts = await this.teamArtifactsService.executeForSprint(
                organizationAndTeamData,
                {
                    startDate: moment(sprint.startDate).format(
                        'YYYY-MM-DD HH:mm',
                    ),
                    endDate: moment(sprint.endDate).format('YYYY-MM-DD HH:mm'),
                },
            );

            const metrics = await this.metricsFactory.getRealTime(
                organizationAndTeamData,
                {
                    analysisPeriod: {
                        startTime: sprint.startDate,
                        endTime: sprint.endDate,
                    },
                },
            );

            const sprintToSave: ISprint = {
                name: sprint.name,
                projectManagementSprintId: sprint.id,
                startDate: sprint.startDate,
                endDate: sprint.endDate,
                completeDate: sprint.completeDate || null,
                description: sprint.description,
                goal: sprint.goal,
                state: sprint.state,
                compileState:
                    sprint.state === SPRINT_STATE.CLOSED
                        ? COMPILE_STATE.CLOSED
                        : COMPILE_STATE.ACTIVE,
                value: {
                    artifacts,
                    metrics,
                },
            };

            await this.createOrUpdateSprintValue(
                organizationAndTeamData,
                sprintToSave,
            );

            return sprintToSave;
        } catch (error) {
            this.logger.error({
                message: 'Error while compiling sprint',
                context: SprintService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    @ValidateProjectManagementIntegration()
    async compileLastSprint(organizationAndTeamData: OrganizationAndTeamData) {
        const currentSprint =
            await this.projectManagementService.getCurrentSprintForTeam({
                organizationAndTeamData,
            });

        if (!currentSprint) {
            return;
        }

        const lastSprint =
            await this.projectManagementService.getLastCompletedSprintForTeam({
                organizationAndTeamData,
                originBoardId: currentSprint.originBoardId,
            });

        if (!lastSprint) {
            return;
        }

        const sprintInDB = await this.sprintRepository.find({
            projectManagementSprintId: lastSprint.id,
            state: SPRINT_STATE.CLOSED,
        });

        if (sprintInDB) {
            return;
        }

        await this.compileSprint(organizationAndTeamData, lastSprint.id);
    }

    private async getPreviousSprintCompiledForTeam(
        organizationAndTeamData: OrganizationAndTeamData,
        currentSprint: Partial<ISprint>,
    ): Promise<ISprint> {
        const sprints = await this.find({
            team: { uuid: organizationAndTeamData.teamId },
        });

        if (!sprints || sprints.length === 0) {
            return null;
        }

        const eligibleSprints = sprints.filter((sprint) =>
            moment(currentSprint.endDate).isAfter(moment(sprint.endDate)),
        );

        return eligibleSprints.sort((a, b) => {
            return b.endDate.getTime() - a.endDate.getTime();
        })[0];
    }

    async createOrUpdateSprintValue(
        organizationAndTeamData: OrganizationAndTeamData,
        sprint: ISprint,
    ) {
        this.sprintRepository.createOrUpdateSprintValue(
            organizationAndTeamData,
            sprint,
        );
    }

    findById(uuid: string): Promise<SprintEntity> {
        return this.sprintRepository.findById(uuid);
    }
    create(sprint: ISprint): Promise<SprintEntity> {
        return this.sprintRepository.create(sprint);
    }
    update(
        filter: Partial<ISprint>,
        data: Partial<ISprint>,
    ): Promise<SprintEntity> {
        return this.sprintRepository.update(filter, data);
    }
    delete(uuid: string): Promise<void> {
        return this.sprintRepository.delete(uuid);
    }

    find(
        filter?: Partial<ISprint>,
        options?: FindManyOptions,
    ): Promise<SprintEntity[]> {
        return this.sprintRepository.find(filter, options);
    }

    findOne(filter?: Partial<ISprint>): Promise<SprintEntity> {
        return this.sprintRepository.findOne(filter);
    }
}
