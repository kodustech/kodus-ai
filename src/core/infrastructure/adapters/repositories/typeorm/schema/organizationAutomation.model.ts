import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { AutomationModel } from './automation.model';
import { OrganizationModel } from './organization.model';
import { OrganizationAutomationExecutionModel } from './organizationAutomationExecution.model';

@Entity('organization_automations')
export class OrganizationAutomationModel extends CoreModel {
    @ManyToOne(
        () => OrganizationModel,
        (organization) => organization.organizationAutomations
    )
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @ManyToOne(
        () => AutomationModel,
        (automation) => automation.organizationAutomations
    )
    @JoinColumn({ name: 'automation_id', referencedColumnName: 'uuid' })
    automation: AutomationModel;

    @Column({ type: 'boolean', default: true })
    status: boolean;

    @OneToMany(
        () => OrganizationAutomationExecutionModel,
        (execution) => execution.organizationAutomation,
    )
    executions: OrganizationAutomationExecutionModel[];


}
