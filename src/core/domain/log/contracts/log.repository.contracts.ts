import { LogEntity } from '../entities/log.entity';
import { ILog } from '../interfaces/log.interface';

export const LOG_REPOSITORY_TOKEN = Symbol('LogRepository');

export interface ILogRepository {
    create(log: Omit<ILog, 'uuid'>): Promise<LogEntity | void>;
    update(
        filter: Partial<ILog>,
        data: Partial<ILog>,
    ): Promise<LogEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<LogEntity | null>;
    find(filter?: Partial<ILog>): Promise<LogEntity[]>;
    getNativeCollection(): any;
    findOne(filter?: Partial<ILog>): Promise<LogEntity | null>;
}
