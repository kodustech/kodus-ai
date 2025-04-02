import { Entity, Column, OneToMany, JoinColumn } from 'typeorm';
import { TeamAutomationModel } from './teamAutomation.model';
import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { OrganizationAutomationModel } from './organizationAutomation.model';
import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';

@Entity('automation')
export class AutomationModel extends CoreModel {
    @Column()
    name: string;

    @Column()
    description: string;

    @Column('simple-array')
    tags: string[];

    @Column('simple-array')
    antiPatterns: string[];

    @Column({ type: 'boolean', default: true })
    status: boolean;

    @Column({ type: 'enum', enum: AutomationType, unique: true })
    automationType: AutomationType;

    @Column({ type: 'enum', enum: AutomationLevel, default: AutomationLevel.TEAM })
    level: AutomationLevel;

    @OneToMany(
        () => TeamAutomationModel,
        (teamAutomation) => teamAutomation.automation,
    )
    @JoinColumn({ name: 'team_automation_id', referencedColumnName: 'uuid' })
    teamAutomations: TeamAutomationModel[];

    @OneToMany(
        () => OrganizationAutomationModel,
        (organizationAutomation) => organizationAutomation.automation,
    )
    @JoinColumn({ name: 'organization_automation_id', referencedColumnName: 'uuid' })
    organizationAutomations: OrganizationAutomationModel[];
}
