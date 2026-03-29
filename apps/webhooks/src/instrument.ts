import 'dotenv/config';

import { setupSentry } from '@libs/core/infrastructure/config/log/sentry';

setupSentry('webhook');
