import {
    SSOProtocol,
    SSOProtocolConfigMap,
} from '@/core/domain/auth/interfaces/ssoConfig.interface';
import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { OrganizationModel } from './organization.model';

@Entity('sso_config')
@Index('IDX_SSOConfig_Domains_GIN', { synchronize: false })
export class SSOConfigModel extends CoreModel {
    @Index('IDX_SSOConfig_OrganizationId')
    @ManyToOne(
        () => OrganizationModel,
        (organization) => organization.ssoConfig,
    )
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @Column({
        name: 'protocol',
        type: 'enum',
        enum: SSOProtocol,
        default: SSOProtocol.SAML,
    })
    protocol: SSOProtocol;

    @Column({ name: 'active', default: true })
    active: boolean;

    @Column({ name: 'domains', type: 'text', array: true, default: [] })
    domains: string[];

    @Column({ name: 'provider_config', type: 'jsonb' })
    providerConfig: SSOProtocolConfigMap[SSOProtocol];
}
