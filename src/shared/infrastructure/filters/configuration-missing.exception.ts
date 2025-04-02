import { HttpException, HttpStatus } from '@nestjs/common';

export class ConfigurationMissingException extends HttpException {
    constructor(message: string, code: string) {
        super({ message, code }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
}
