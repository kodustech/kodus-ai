import { ConfigModuleOptions } from '@nestjs/config/dist/interfaces';
import * as Joi from 'joi';
import { environmentConfigLoader } from './loaders/environment.loader';
import { serverConfigLoader } from './loaders/server.loader';
import { configSchema } from './schemas/config.schema';

export const configOptions: ConfigModuleOptions = {
    cache: true,
    isGlobal: true,
    load: [serverConfigLoader, environmentConfigLoader],
    validationSchema: Joi.object().keys({
        ...configSchema.keys,
    }),
    validationOptions: {
        allowUnknown: true,
        abortEarly: true,
    },
};
