import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import type { TeamModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/team.model';

import type { AutomationModel } from './automation.model';
import type { AutomationExecutionModel } from './automationExecution.model';

@Entity('team_automations')
@Index('idx_team_automations_team_auto', ['team', 'automation'])
export class TeamAutomationModel extends CoreModel {
    @ManyToOne('TeamModel', 'teamAutomations')
    team: TeamModel;

    @ManyToOne('AutomationModel')
    automation: AutomationModel;

    @Column({ type: 'boolean', default: true })
    status: boolean;

    @OneToMany('AutomationExecutionModel', 'teamAutomation')
    executions: AutomationExecutionModel[];
}
