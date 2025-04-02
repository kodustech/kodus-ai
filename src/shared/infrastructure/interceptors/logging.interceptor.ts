import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { isRabbitContext } from '@golevelup/nestjs-rabbitmq';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    constructor(private readonly logService: PinoLoggerService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const shouldSkip = isRabbitContext(context);

        if (shouldSkip) {
            return next.handle().pipe();
        }

        const now = Date.now();
        const req = context.switchToHttp().getRequest();
        const userID = req.user?.uuid;

        // Generate a unique request ID
        req.requestId = req.requestId || uuidv4();

        setImmediate(() => {
            this.logService.log({
                message: `[${req.requestId}] Request started: ${req.method} ${req.url}`,
                context: 'HTTP Request',
                serviceName: 'LoggingInterceptor',
                metadata: {
                    method: req.method,
                    url: req.url,
                    body: req.method === 'POST' ? '[Body]' : {},
                    headers: req.headers,
                    query: req.query,
                    params: req.params,
                    requestId: req.requestId,
                    userID: userID,
                },
            });
        });

        return next.handle().pipe(
            tap(() => {
                setImmediate(() => {
                    this.logService.log({
                        message: `[${req.requestId}] Request finished: ${req.method} ${req.url} in ${Date.now() - now}ms`,
                        context: 'HTTP Request',
                        serviceName: 'LoggingInterceptor',
                        metadata: {
                            method: req.method,
                            url: req.url,
                            body: req.method === 'POST' ? '[Body]' : {},
                            headers: req.headers,
                            query: req.query,
                            params: req.params,
                            requestId: req.requestId,
                            durationMs: Date.now() - now,
                            userID: userID,
                        },
                    });
                });
            }),
        );
    }
}
