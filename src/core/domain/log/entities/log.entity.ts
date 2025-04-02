import { ILog } from '../interfaces/log.interface';

export class LogEntity implements ILog {
    private _uuid: string;
    private _timestamp: string;
    private _level: 'info' | 'error' | 'warn' | 'debug' | 'verbose';
    private _message: string;
    private _stack: any;
    private _metadata?: Record<string, any>;
    private _requestId?: string;
    private _executionId?: string;
    private _serviceName?: string;
    private _traceId?: string;
    private _spanId?: string;
    private _environment?: string;

    constructor(log: ILog | Partial<ILog>) {
        this._uuid = log.uuid;
        this._timestamp = log.timestamp || new Date().toISOString();
        this._level = log.level;
        this._message = log.message;
        this._stack = log.stack;
        this._metadata = log.metadata;
        this._requestId = log.requestId;
        this._executionId = log.executionId;
        this._serviceName = log.serviceName;
        this._traceId = log.traceId;
        this._spanId = log.spanId;
        this._environment = log.environment;
    }

    public static create(log: ILog | Partial<ILog>): LogEntity {
        return new LogEntity(log);
    }

    get uuid(): string {
        return this._uuid;
    }

    get timestamp(): string {
        return this._timestamp;
    }

    get level(): 'info' | 'error' | 'warn' | 'debug' | 'verbose' {
        return this._level;
    }

    get message(): string {
        return this._message;
    }

    get stack(): any {
        return this._stack;
    }

    get metadata(): Record<string, any> | undefined {
        return this._metadata;
    }

    get requestId(): string {
        return this._requestId;
    }

    get executionId(): string {
        return this._executionId;
    }

    get serviceName(): string {
        return this._serviceName;
    }

    get traceId(): string {
        return this._traceId;
    }

    get spanId(): string {
        return this._spanId;
    }

    get environment(): string {
        return this._environment;
    }
}
