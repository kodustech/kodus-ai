import {
    BadRequestException,
    InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { ExceptionsFilter } from './exceptions.filter';
import { reportExceptionToSentry } from '../config/log/sentry';

jest.mock('../config/log/sentry', () => ({
    reportExceptionToSentry: jest.fn(),
}));

describe('ExceptionsFilter', () => {
    const response = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
    };
    const request = {
        url: '/test',
        method: 'GET',
        requestId: 'req-1',
    };
    const host = {
        switchToHttp: () => ({
            getResponse: () => response,
            getRequest: () => request,
        }),
    };

    let filter: ExceptionsFilter;

    beforeEach(() => {
        jest.clearAllMocks();
        filter = new ExceptionsFilter({
            get: jest.fn().mockReturnValue('api'),
        } as unknown as ConfigService);
    });

    it('does not capture 4xx http exceptions in sentry', () => {
        filter.catch(new BadRequestException('invalid payload'), host as any);

        expect(reportExceptionToSentry).not.toHaveBeenCalled();
    });

    it('captures 5xx http exceptions in sentry', () => {
        filter.catch(
            new InternalServerErrorException('server exploded'),
            host as any,
        );

        expect(reportExceptionToSentry).toHaveBeenCalledTimes(1);
    });

    it('maps Postgres 22P02 (invalid uuid/int input) to 400 and skips sentry', () => {
        // A malformed uuid reaching a query (e.g. an empty ?teamId=) throws a
        // QueryFailedError with driver code 22P02 — a client input error, not a
        // 500. It must not be reported to Sentry nor counted as a server error.
        const qfe = new QueryFailedError(
            'SELECT * FROM team WHERE uuid = $1',
            [''],
            {
                code: '22P02',
                message: 'invalid input syntax for type uuid: ""',
            } as any,
        );

        filter.catch(qfe, host as any);

        expect(response.status).toHaveBeenCalledWith(400);
        expect(reportExceptionToSentry).not.toHaveBeenCalled();
        const body = (response.json as jest.Mock).mock.calls[0][0];
        expect(body.statusCode).toBe(400);
        expect(body.message).toBe('Invalid parameter format');
    });
});
