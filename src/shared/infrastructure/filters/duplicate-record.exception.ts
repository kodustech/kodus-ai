import { HttpException, HttpStatus } from '@nestjs/common';

export class DuplicateRecordException extends HttpException {
    constructor(message: string, error_key: string = 'error_key', code: string = 'DUPLICATE_RECORD') {
        super(
            {
                error_key: error_key,
                message,
                code,
                statusCode: HttpStatus.CONFLICT,
                error: 'Duplicate Record'
            },
            HttpStatus.CONFLICT
        );
    }
}
