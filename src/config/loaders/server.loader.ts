import { registerAs } from '@nestjs/config';

import { HttpServerConfiguration } from '@/config/types/http/http-server.type';
import { configLoader } from '.';

export const serverConfigLoader = registerAs(
    'server',
    (): HttpServerConfiguration => configLoader().server,
);
