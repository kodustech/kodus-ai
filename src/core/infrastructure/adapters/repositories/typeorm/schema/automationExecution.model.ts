import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { TeamAutomationModel } from './teamAutomation.model';

@Entity('automation_execution')
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

    @ManyToOne(
        () => TeamAutomationModel,
        (teamAutomation) => teamAutomation.executions,
    )
    @JoinColumn({ name: 'team_automation_id', referencedColumnName: 'uuid' })
    teamAutomation: TeamAutomationModel;

    @Column({ nullable: true })
    origin: string;
}
