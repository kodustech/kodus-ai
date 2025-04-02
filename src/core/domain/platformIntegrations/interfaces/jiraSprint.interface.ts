import { SPRINT_STATE } from '../../sprint/enum/sprintState.enum';

export interface ISprint {
    id: string;
    state: SPRINT_STATE;
    name?: string;
    startDate?: Date;
    endDate?: Date;
    completeDate?: Date;
    goal?: string;
    description?: string;
    originBoardId?: number;
}
