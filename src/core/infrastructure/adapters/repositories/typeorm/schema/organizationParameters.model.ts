import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { OrganizationModel } from './organization.model';

@Entity('organization_parameters')
export class OrganizationParametersModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: OrganizationParametersKey,
    })
    configKey: OrganizationParametersKey;

    @Column({ type: 'jsonb' })
    configValue: any;

    @ManyToOne(() => OrganizationModel, (organization) => organization.organizationParameters)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @Column({ nullable: true })
    description: string;
}
