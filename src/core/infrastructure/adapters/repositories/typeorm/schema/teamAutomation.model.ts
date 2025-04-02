import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { TeamModel } from './team.model';
import { Column, Entity, ManyToOne, OneToMany } from 'typeorm';
import { AutomationModel } from './automation.model';
import { AutomationExecutionModel } from './automationExecution.model';

@Entity('team_automations')
export class TeamAutomationModel extends CoreModel {
    @ManyToOne(() => TeamModel, (team) => team.teamAutomations)
    team: TeamModel;

    @ManyToOne(() => AutomationModel)
    automation: AutomationModel;

    @Column({ type: 'boolean', default: true })
    status: boolean;

    @OneToMany(
        () => AutomationExecutionModel,
        (execution) => execution.teamAutomation,
    )
    executions: AutomationExecutionModel[];
}
