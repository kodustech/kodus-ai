import * as Joi from 'joi';

export const databaseSchema = Joi.object({
    DB_HOST: Joi.string().hostname,
    DB_PORT: Joi.number().optional(),
    DB_USERNAME: Joi.string().optional(),
    DB_PASSWORD: Joi.string().optional(),
    DB_DATABASE: Joi.string().optional(),
});
