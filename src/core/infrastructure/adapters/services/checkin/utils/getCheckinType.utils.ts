import { CHECKIN_TYPE } from "@/core/domain/checkinHistory/enums/checkin-type.enum";

export class checkinTypeByFrequency {
    static get(checkinType) {
        switch (checkinType) {
            case 'weekly':
                return CHECKIN_TYPE.WEEKLY;
            case 'daily':
                return CHECKIN_TYPE.DAILY;
            case 'sprintRetro':
                return CHECKIN_TYPE.SPRINT_RETRO;
            default:
                return CHECKIN_TYPE.WEEKLY;
        }
    }
}
