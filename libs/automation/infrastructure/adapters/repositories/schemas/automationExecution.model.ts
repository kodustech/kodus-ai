import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
} from 'typeorm';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

import type { CodeReviewExecutionModel } from './codeReviewExecution.model';
import type { TeamAutomationModel } from './teamAutomation.model';

@Entity('automation_execution')
@Index('IDX_automation_exec_team_status', ['teamAutomation', 'status'], {
    concurrent: true,
})
@Index('IDX_automation_exec_pr_repo', ['pullRequestNumber', 'repositoryId'], {
    concurrent: true,
})
@Index(
    'IDX_automation_exec_performance',
    ['teamAutomation', 'status', 'createdAt'],
    {
        concurrent: true,
    },
)
@Index('IDX_automation_exec_created_desc', { synchronize: false }) // Typeorm does not support DESC indexes natively, so we set synchronize to false and create it manually in migrations
@Index(
    'idx_automation_exec_inprogress_lookup',
    ['teamAutomation', 'status', 'repositoryId', 'pullRequestNumber'],
    {
        where: '"repositoryId" IS NOT NULL AND "pullRequestNumber" IS NOT NULL',
    },
)
export class AutomationExecutionModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: AutomationStatus,
        default: AutomationStatus.SUCCESS,
    })
    status: AutomationStatus;

    @Column({ nullable: true })
    errorMessage?: string;

    @Column({ type: 'jsonb', nullable: true })
    dataExecution: any;

    @Column({ nullable: true })
    pullRequestNumber?: number;

    @Column({ nullable: true })
    repositoryId?: string;

    @ManyToOne('TeamAutomationModel', 'executions')
    @JoinColumn({ name: 'team_automation_id', referencedColumnName: 'uuid' })
    teamAutomation: TeamAutomationModel;

    @OneToMany('CodeReviewExecutionModel', 'automationExecution', {
        nullable: true,
    })
    codeReviewExecutions: CodeReviewExecutionModel[];

    @Column({ nullable: true })
    origin: string;
}
