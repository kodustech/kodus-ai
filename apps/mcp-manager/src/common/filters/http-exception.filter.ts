import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { FastifyRequest, FastifyReply } from 'fastify';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    constructor(private httpAdapterHost: HttpAdapterHost) {}

    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: any, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<FastifyReply>();
        const request = ctx.getRequest<FastifyRequest>();

        let status = HttpStatus.INTERNAL_SERVER_ERROR;
        let message = 'Internal server error';
        let code = 'INTERNAL_SERVER_ERROR';
        let details = exception.response?.data || null;

        // Log the exception
        this.logger.error(
            `Error processing request ${request.method} ${request.url}`,
            exception instanceof Error ? exception.stack : exception,
        );

        if (exception instanceof HttpException) {
            const errorResponse = exception.getResponse() as any;

            status = exception.getStatus();
            message = errorResponse.message || exception.message;
            code = errorResponse.code || this.getErrorCode(status);
            details = errorResponse.details || null;
        } else if (exception instanceof QueryFailedError) {
            status = HttpStatus.BAD_REQUEST;
            message = 'Database operation failed';
            code = 'DATABASE_ERROR';
            details = {
                message: exception.message,
                // Removing sensitive information in production
                ...(process.env.API_MCP_MANAGER_NODE_ENV === 'development' && {
                    query: exception.query,
                }),
            };
        } else if (exception instanceof Error) {
            message = exception.message;
            details = details || exception.stack || null;
        }

        const errorResponse = {
            statusCode: status,
            timestamp: new Date().toISOString(),
            url: request.originalUrl,
            method: request.method,
            message,
            code,
            details,
        };

        return this.httpAdapterHost.httpAdapter.reply(
            response,
            errorResponse,
            status,
        );
    }

    private getErrorCode(status: number): string {
        const codes = {
            [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
            [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
            [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
            [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
            [HttpStatus.CONFLICT]: 'CONFLICT',
            [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
            [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
            [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
        };

        return codes[status] || 'UNKNOWN_ERROR';
    }
}
