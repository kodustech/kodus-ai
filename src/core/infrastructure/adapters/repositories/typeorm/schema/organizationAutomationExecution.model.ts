import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { OrganizationAutomationModel } from './organizationAutomation.model';

@Entity('organization_automation_execution')
export class OrganizationAutomationExecutionModel extends CoreModel {
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
        () => OrganizationAutomationModel,
        (organizationAutomation) => organizationAutomation.executions,
    )
    @JoinColumn({ name: 'organization_automation_id', referencedColumnName: 'uuid' })
    organizationAutomation: OrganizationAutomationModel;

    @Column({ nullable: true })
    origin: string;
}
