import {
    BadRequestException,
    InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
});
