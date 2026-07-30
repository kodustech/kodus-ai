import { createLogger } from '@libs/core/log/logger';
import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class LoggerWrapperService implements LoggerService {
    private logger;

    constructor() {
        this.logger = createLogger('KodusApp');
    }

    log(message: any, ...optionalParams: any[]) {
        this.callLogger('log', message, ...optionalParams);
    }

    error(message: any, ...optionalParams: any[]) {
        this.callLogger('error', message, ...optionalParams);
    }

    warn(message: any, ...optionalParams: any[]) {
        this.callLogger('warn', message, ...optionalParams);
    }

    debug(message: any, ...optionalParams: any[]) {
        this.callLogger('debug', message, ...optionalParams);
    }

    verbose(message: any, ...optionalParams: any[]) {
        // Map verbose to debug or trace if available, here mapping to debug for safety
        this.callLogger('debug', message, ...optionalParams);
    }

    private callLogger(level: string, message: any, ...optionalParams: any[]) {
        if (
            typeof message === 'object' &&
            message !== null &&
            !Array.isArray(message)
        ) {
            // Assume it fits the sdk logger signature if it is an object
            // The SDK logger expects { message, context, ... }
            this.logger[level](message);
        } else {
            // NestJS style: message is string, last param is context
            let context = '';
            if (optionalParams.length > 0) {
                const last = optionalParams[optionalParams.length - 1];
                if (typeof last === 'string') {
                    context = last;
                }
            }

            this.logger[level]({
                message: String(message),
                context,
            });
        }
    }
}
