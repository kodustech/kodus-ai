import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ExceptionsFilter } from '@libs/core/infrastructure/filters/exceptions.filter';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

jest.mock('@sentry/nestjs', () => ({
    withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })),
    captureException: jest.fn(),
}));

// ============================================================================
// HELPERS
// ============================================================================

function makeContext(overrides: { url?: string; method?: string } = {}) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const response = { status };
    const request = {
        url: overrides.url ?? '/test',
        method: overrides.method ?? 'GET',
        requestId: 'req-123',
    };

    return {
        mockContext: {
            switchToHttp: () => ({
                getResponse: () => response,
                getRequest: () => request,
            }),
        } as any,
        status,
        json,
    };
}

function makeFilter(componentType = 'api') {
    const configService = {
        get: jest.fn((key: string, defaultVal?: string) => {
            if (key === 'COMPONENT_TYPE') return componentType;
            return defaultVal;
        }),
    } as unknown as ConfigService;

    return new ExceptionsFilter(configService);
}

// ============================================================================
// SUITE
// ============================================================================

describe('ExceptionsFilter', () => {
    let filter: ExceptionsFilter;

    beforeEach(() => {
        filter = makeFilter();
    });

    describe('Standard HttpException', () => {
        it('returns correct statusCode, error, and message', () => {
            const { mockContext, status, json } = makeContext();
            const exception = new HttpException(
                'Not Found',
                HttpStatus.NOT_FOUND,
            );

            filter.catch(exception, mockContext);

            expect(status).toHaveBeenCalledWith(404);
            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusCode: 404,
                    message: 'Not Found',
                    path: '/test',
                }),
            );
        });

        it('includes timestamp in response', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException('err', 400);

            filter.catch(exception, mockContext);

            const body = json.mock.calls[0][0];
            expect(body.timestamp).toBeDefined();
            expect(new Date(body.timestamp).getTime()).not.toBeNaN();
        });
    });

    describe('HttpException with code and details', () => {
        it('passes code through to response', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                {
                    message: 'Device limit reached',
                    code: 'DEVICE_LIMIT_REACHED',
                },
                HttpStatus.UNAUTHORIZED,
            );

            filter.catch(exception, mockContext);

            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusCode: 401,
                    message: 'Device limit reached',
                    code: 'DEVICE_LIMIT_REACHED',
                }),
            );
        });

        it('passes details through to response', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                {
                    message: 'Limit reached',
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 3, current: 3 },
                },
                HttpStatus.UNAUTHORIZED,
            );

            filter.catch(exception, mockContext);

            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 3, current: 3 },
                }),
            );
        });

        it('passes error_key through to response', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                {
                    message: 'Something wrong',
                    error_key: 'SOME_ERROR_KEY',
                },
                HttpStatus.BAD_REQUEST,
            );

            filter.catch(exception, mockContext);

            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error_key: 'SOME_ERROR_KEY',
                }),
            );
        });

        it('does not include code/details/error_key when not present', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                { message: 'Simple error' },
                HttpStatus.BAD_REQUEST,
            );

            filter.catch(exception, mockContext);

            const body = json.mock.calls[0][0];
            expect(body).not.toHaveProperty('code');
            expect(body).not.toHaveProperty('details');
            expect(body).not.toHaveProperty('error_key');
        });

        it('handles all three fields together', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                {
                    message: 'Full error',
                    code: 'ERR_CODE',
                    details: { foo: 'bar' },
                    error_key: 'ERR_KEY',
                },
                HttpStatus.FORBIDDEN,
            );

            filter.catch(exception, mockContext);

            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusCode: 403,
                    message: 'Full error',
                    code: 'ERR_CODE',
                    details: { foo: 'bar' },
                    error_key: 'ERR_KEY',
                }),
            );
        });
    });

    describe('HttpException with string response', () => {
        it('uses string as message', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                'String message',
                HttpStatus.BAD_REQUEST,
            );

            filter.catch(exception, mockContext);

            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'String message',
                }),
            );
        });
    });

    describe('HttpException with array message', () => {
        it('joins array messages with comma', () => {
            const { mockContext, json } = makeContext();
            const exception = new HttpException(
                { message: ['error 1', 'error 2'] },
                HttpStatus.BAD_REQUEST,
            );

            filter.catch(exception, mockContext);

            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'error 1, error 2',
                }),
            );
        });
    });

    describe('Non-HttpException (unknown errors)', () => {
        it('returns 500 with generic message', () => {
            const { mockContext, status, json } = makeContext();
            const exception = new Error('Something broke');

            filter.catch(exception, mockContext);

            expect(status).toHaveBeenCalledWith(500);
            expect(json).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusCode: 500,
                    error: 'Internal Server Error',
                    message: 'An unexpected error occurred',
                }),
            );
        });

        it('does not include code/details for non-HttpException', () => {
            const { mockContext, json } = makeContext();
            const exception = new TypeError('cannot read property');

            filter.catch(exception, mockContext);

            const body = json.mock.calls[0][0];
            expect(body).not.toHaveProperty('code');
            expect(body).not.toHaveProperty('details');
        });
    });
});
