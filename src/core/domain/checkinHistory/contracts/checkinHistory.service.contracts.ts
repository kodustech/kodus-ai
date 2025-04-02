
import { ICheckinHistoryRepository } from './checkinHistory.repository';

export const CHECKIN_HISTORY_SERVICE_TOKEN = Symbol('CheckinHistoryService');

export interface ICheckinHistoryService extends ICheckinHistoryRepository {}
