import { isRabbitContext } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@libs/core/log/logger';
import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private readonly logService = createLogger(LoggingInterceptor.name);
    private readonly componentType: string;

    constructor(
        private readonly observability: ObservabilityService,
        private readonly configService: ConfigService,
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
    ) {
        this.componentType = this.configService.get<string>(
            'COMPONENT_TYPE',
            'unknown',
        );
    }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const shouldSkip = isRabbitContext(context);

        if (shouldSkip) {
            return next.handle().pipe();
        }

        const now = Date.now();
        const req = context.switchToHttp().getRequest();
        const userID = req.user?.uuid;
        const headerCorrelationId = req.headers['x-correlation-id'];
        const headerRequestId = req.headers['x-request-id'];

        // Generate a unique request ID
        const correlationId =
            (Array.isArray(headerCorrelationId)
                ? headerCorrelationId[0]
                : headerCorrelationId) ||
            (Array.isArray(headerRequestId)
                ? headerRequestId[0]
                : headerRequestId) ||
            req.requestId ||
            uuidv4();
        req.requestId = correlationId;
        this.observability.setContext(correlationId);

        setImmediate(() => {
            this.logService.debug({
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
                    correlationId,
                    userID: userID,
                },
            });
        });

        // Record request counter for error rate calculation
        this.metricsCollector?.recordCounter('http_request_total', 1, {
            method: req.method,
            path: req.url,
            component: this.componentType,
        });

        return next.handle().pipe(
            tap(() => {
                const durationMs = Date.now() - now;

                // Record request duration histogram
                this.metricsCollector?.recordHistogram(
                    'http_request_duration_ms',
                    durationMs,
                    {
                        method: req.method,
                        path: req.url,
                        component: this.componentType,
                    },
                );

                setImmediate(() => {
                    this.logService.debug({
                        message: `[${req.requestId}] Request finished: ${req.method} ${req.url} in ${durationMs}ms`,
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
                            correlationId,
                            durationMs,
                            userID: userID,
                        },
                    });
                });
            }),
        );
    }
}
