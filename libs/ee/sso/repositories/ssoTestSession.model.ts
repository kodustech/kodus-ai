import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { OrganizationModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organization.model';
import {
    SSOConnectionTestSessionStatus,
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../domain/interfaces/ssoConfig.interface';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

@Entity('sso_test_session')
@Index('IDX_SSOTestSession_SessionId', ['sessionId'], { unique: true })
@Index('IDX_SSOTestSession_ExpiresAt', ['expiresAt'])
export class SSOTestSessionModel extends CoreModel {
    @Index('IDX_SSOTestSession_OrganizationId')
    @ManyToOne(() => OrganizationModel, { nullable: false })
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @Column({ name: 'session_id', type: 'text' })
    sessionId: string;

    @Column({
        name: 'protocol',
        type: 'enum',
        enum: SSOProtocol,
    })
    protocol: SSOProtocol;

    @Column({
        name: 'status',
        type: 'enum',
        enum: SSOConnectionTestSessionStatus,
        default: SSOConnectionTestSessionStatus.PENDING,
    })
    status: SSOConnectionTestSessionStatus;

    @Column({ name: 'config_fingerprint', type: 'text' })
    configFingerprint: string;

    @Column({ name: 'provider_config', type: 'jsonb' })
    providerConfig: SSOProtocolConfigMap[SSOProtocol];

    @Column({ name: 'domains', type: 'text', array: true, default: [] })
    domains: string[];

    @Column({
        name: 'created_by',
        type: 'text',
        nullable: true,
    })
    createdBy?: string;

    @Column({ name: 'tested_at', type: 'timestamp', nullable: true })
    testedAt?: Date;

    @Column({
        name: 'failure_code',
        type: 'text',
        nullable: true,
    })
    failureCode?: string;

    @Column({ name: 'failure_message', type: 'text', nullable: true })
    failureMessage?: string;

    @Column({ name: 'expires_at', type: 'timestamp' })
    expiresAt: Date;
}
