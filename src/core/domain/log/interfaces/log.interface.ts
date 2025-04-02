export interface ILog {
    uuid: string;
    timestamp?: string;
    level: 'info' | 'error' | 'warn' | 'debug' | 'verbose';
    message: string;
    stack: any;
    metadata?: Record<string, any>;
    requestId?: string;
    executionId?: string;
    serviceName?: string;
    traceId?: string;
    spanId?: string;
    environment?: string;
}
