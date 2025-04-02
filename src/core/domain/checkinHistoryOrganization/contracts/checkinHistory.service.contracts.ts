export const CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN = Symbol('CheckinHistoryOrganizationService');

import { ICheckinHistoryOrganizationRepository } from "./checkinHistoryOrganization.repository";

export interface ICheckinHistoryOrganizationService extends ICheckinHistoryOrganizationRepository { }
