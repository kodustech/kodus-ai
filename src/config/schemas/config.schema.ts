import * as Joi from 'joi';

export const configSchema = Joi.object({
    API_HOST: Joi.string().default('localhost'),
    API_PORT: Joi.number().required(),
    API_RATE_MAX_REQUEST: Joi.number().default(100),
    API_RATE_INTERVAL: Joi.number().default(60),
});
