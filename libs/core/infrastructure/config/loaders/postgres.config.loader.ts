import { registerAs } from '@nestjs/config';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';
import { resolvePooledConnection } from '@libs/core/infrastructure/database/typeorm/postgres-connection-env';

export const postgresConfigLoader = registerAs(
    'postgresDatabase',
    (): DatabaseConnection => resolvePooledConnection(),
);
