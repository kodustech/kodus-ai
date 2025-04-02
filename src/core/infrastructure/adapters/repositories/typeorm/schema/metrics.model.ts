import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
} from 'typeorm';
import { TeamModel } from './team.model';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

@Entity('metrics')
export class MetricsModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: METRICS_TYPE,
    })
    type: METRICS_TYPE;

    @Column('jsonb')
    value: any;

    @Column({ default: true })
    status: boolean;

    @Column({
        type: 'enum',
        enum: METRICS_CATEGORY,
        nullable: true,
    })
    category: METRICS_CATEGORY | null;

    @CreateDateColumn({
        type: 'timestamp',
        default: () => 'CURRENT_TIMESTAMP(6)',
        nullable: true,
    })
    referenceDate: Date;

    @ManyToOne(() => TeamModel, (team) => team.metrics)
    @JoinColumn({ name: 'team_id' }) // This column will be added to the 'metrics' table
    team: TeamModel;
}
