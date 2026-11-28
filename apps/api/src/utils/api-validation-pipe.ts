import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

export const API_VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: {
        enableImplicitConversion: true,
    },
};

export const createApiValidationPipe = (): ValidationPipe =>
    new ValidationPipe(API_VALIDATION_PIPE_OPTIONS);
