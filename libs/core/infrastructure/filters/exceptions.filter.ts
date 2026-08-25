import { createLogger } from '@libs/core/log/logger';
import {
    Catch,
    ExceptionFilter,
    ExecutionContext,
    HttpException,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { reportExceptionToSentry } from '../config/log/sentry';
import { QueryFailedError } from 'typeorm';

interface ExceptionResponse {
    statusCode?: number;
    message?: string | string[];
    error?: string;
    error_key?: string;
    code?: string;
    details?: unknown;
}

@Catch()
export class ExceptionsFilter implements ExceptionFilter {
    private readonly loggerService = createLogger(ExceptionsFilter.name);
    private readonly componentType: string;
    constructor(
        private readonly configService: ConfigService,
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
    ) {
        this.componentType = this.configService.get<string>(
            'COMPONENT_TYPE',
            'unknown',
        );
    }

    catch(exception: unknown, context: ExecutionContext): void {
        const response = context.switchToHttp().getResponse();
        const request = context.switchToHttp().getRequest();
        // Postgres 22P02 = invalid_text_representation: a malformed uuid / int
        // / enum reached a query (e.g. an empty or garbage `?teamId=`, a `:id`
        // that isn't a UUID). That is a client input error, not a server fault,
        // so map it to 400 — otherwise it surfaces as a 500 (Sentry noise,
        // error-rate spikes, http_errors_total) for what is simply bad input.
        const isPgInvalidInput =
            exception instanceof QueryFailedError &&
            (exception as { driverError?: { code?: string } }).driverError
                ?.code === '22P02';

        const status = isPgInvalidInput
            ? StatusCodes.BAD_REQUEST
            : exception instanceof HttpException
              ? exception.getStatus()
              : StatusCodes.INTERNAL_SERVER_ERROR;

        const requestId = request?.requestId || 'unknown-request-id';
        const shouldReportToSentry =
            !isPgInvalidInput &&
            (!(exception instanceof HttpException) || status >= 500);

        if (shouldReportToSentry) {
            void reportExceptionToSentry(exception, {
                context: 'ExceptionsFilter',
                tags: {
                    requestId,
                    statusCode: status,
                },
                extra: {
                    path: request?.url,
                    method: request?.method,
                    ...(exception instanceof HttpException
                        ? { response: exception.getResponse() }
                        : {}),
                },
            });
        }

        const errorResponse =
            exception instanceof HttpException ? exception.getResponse() : {};
        let message = isPgInvalidInput
            ? 'Invalid parameter format'
            : 'An unexpected error occurred';
        let error_key: string | undefined;
        let code: string | undefined;
        let details: unknown | undefined;
        if (typeof errorResponse === 'string') {
            message = errorResponse;
        } else if (
            errorResponse &&
            typeof errorResponse === 'object' &&
            'message' in errorResponse
        ) {
            const typedErrorResponse = errorResponse as ExceptionResponse;
            message = Array.isArray(typedErrorResponse.message)
                ? typedErrorResponse.message.join(', ')
                : typedErrorResponse.message || message;

            error_key = typedErrorResponse?.error_key;
            code = typedErrorResponse?.code;
            details = typedErrorResponse?.details;
        }

        const error =
            exception instanceof HttpException || isPgInvalidInput
                ? getReasonPhrase(status)
                : 'Internal Server Error';

        // Level mirrors Sentry gating: a 4xx is a CLIENT error (bad input,
        // validation reject, not-found) — expected traffic, logged at `warn`,
        // not `error`. Only a 5xx (server fault) is `error`. Without this every
        // 400 ("model in use", "listing not available") inflated the error rate
        // and the logs table. `isPgInvalidInput` is a 400 → falls into `warn`.
        const logLevel = status >= 500 ? 'error' : 'warn';
        this.loggerService[logLevel]({
            message: `[${status}] ${error}: ${message}`,
            context: 'ExceptionsFilter',
            serviceName: 'ExceptionsFilter',
            error: exception instanceof Error ? exception : undefined,
            metadata: {
                path: request.url,
                method: request.method,
                status,
                requestId: request.requestId,
                exceptionType: exception.constructor.name,
            },
        });

        // Record metrics for 5xx errors
        if (status >= 500) {
            const component = this.componentType;
            this.metricsCollector?.recordCounter('http_errors_total', 1, {
                component,
                path: request.url,
                statusCode: String(status),
            });
        }

        response.status(status).json({
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            error,
            message,
            ...(error_key ? { error_key } : {}),
            ...(code ? { code } : {}),
            ...(details ? { details } : {}),
        });
    }
}
