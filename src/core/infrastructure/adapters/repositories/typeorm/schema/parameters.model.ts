import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { TeamModel } from './team.model';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

@Entity('parameters')
export class ParametersModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: ParametersKey,
    })
    configKey: ParametersKey;

    @Column({ type: 'jsonb' })
    configValue: any;

    @ManyToOne(() => TeamModel, (team) => team.parameters)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;

    @Column({ nullable: true })
    description: string;
}
