import { ITeam } from '../../team/interfaces/team.interface';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { SPRINT_STATE } from '../enum/sprintState.enum';
import { COMPILE_STATE } from '../enum/compileState.enum';

export interface ISprint {
    uuid?: string;
    name: string;
    state: SPRINT_STATE;
    compileState: COMPILE_STATE;
    startDate?: Date;
    endDate?: Date;
    completeDate?: Date;
    description?: string;
    goal?: string;
    team?: Partial<ITeam>;
    value: any;
    projectManagementSprintId: string;
}
