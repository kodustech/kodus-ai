import { LogEntity } from '../entities/log.entity';
import { ILog } from '../interfaces/log.interface';
import { ILogRepository } from './log.repository.contracts';

export const LOG_SERVICE_TOKEN = Symbol('LogService');

export interface ILogService extends ILogRepository {
    register(session: Omit<ILog, 'uuid'>): Promise<LogEntity | void>;
}
