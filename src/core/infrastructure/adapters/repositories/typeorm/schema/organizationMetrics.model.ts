import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { OrganizationModel } from './organization.model';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

@Entity('organization_metrics')
export class OrganizationMetricsModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: METRICS_TYPE,
    })
    type: METRICS_TYPE;

    @Column('jsonb')
    value: any;

    @Column({ default: true })
    status: boolean;

    @CreateDateColumn({
        type: 'timestamp',
        default: () => 'CURRENT_TIMESTAMP(6)',
        nullable: true,
    })
    referenceDate: Date;

    @Column({
        type: 'enum',
        enum: METRICS_CATEGORY,
        nullable: true,
    })
    category: METRICS_CATEGORY | null;

    @ManyToOne(() => OrganizationModel, (organization) => organization.metrics)
    @JoinColumn({ name: 'organization_id' })
    organization: OrganizationModel;
}
