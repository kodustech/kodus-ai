import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import {
    SSOConnectionTestMetadata,
    SSODomainVerificationMetadata,
    SSOProtocol,
    SSOProtocolConfigMap,
} from '@libs/ee/sso/domain/interfaces/ssoConfig.interface';
import { OrganizationModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organization.model';

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

    @Column({ name: 'connection_test', type: 'jsonb', nullable: true })
    connectionTest?: SSOConnectionTestMetadata;

    @Column({ name: 'domain_verification', type: 'jsonb', nullable: true })
    domainVerification?: SSODomainVerificationMetadata;
}
