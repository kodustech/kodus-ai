import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { OrganizationModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organization.model';

@Entity({ name: 'notification_routing_rules' })
@Unique('UQ_nrr_org_event_role', ['organization', 'event', 'role'])
@Index('IDX_nrr_org', ['organization'])
export class RoutingRuleModel extends CoreModel {
    @ManyToOne(() => OrganizationModel, { nullable: false })
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @Column({ type: 'text' })
    event: string;

    @Column({ type: 'text', nullable: true })
    category?: string | null;

    @Column({ type: 'text' })
    role: string;

    @Column({ type: 'jsonb', default: {} })
    channels: Record<string, boolean>;
}
