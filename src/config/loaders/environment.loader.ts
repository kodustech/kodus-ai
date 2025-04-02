import { registerAs } from '@nestjs/config';
import { EnvironmentConfig } from '@/config/types/environment/environment.type';

export const environmentConfigLoader = registerAs(
    'environment',
    (): EnvironmentConfig => ({
        nodeEnv: process.env.API_NODE_ENV || 'development',
    }),
);
