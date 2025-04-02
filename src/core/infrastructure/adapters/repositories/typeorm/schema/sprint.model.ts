import { SPRINT_STATE } from '@/core/domain/sprint/enum/sprintState.enum';
import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { TeamModel } from './team.model';
import { COMPILE_STATE } from '@/core/domain/sprint/enum/compileState.enum';

@Entity('sprint')
export class SprintModel extends CoreModel {
    @Column()
    projectManagementSprintId: string;

    @Column()
    name: string;

    @Column({ type: 'enum', enum: SPRINT_STATE })
    state: SPRINT_STATE;

    @Column({ type: 'enum', enum: COMPILE_STATE })
    compileState: COMPILE_STATE;

    @Column({ nullable: true })
    startDate: Date;

    @Column({ nullable: true })
    endDate: Date;

    @Column({ nullable: true })
    completeDate: Date;

    @Column({ nullable: true })
    description: string;

    @Column({ nullable: true })
    goal: string;

    @ManyToOne(() => TeamModel, (team) => team.parameters)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;

    @Column({ type: 'jsonb', nullable: true })
    value: any;
}
