import 'dotenv/config';

import { setupSentry } from '@libs/core/infrastructure/config/log/sentry';
import { registerLangfuseStandalone } from '@libs/core/log/langfuse';

setupSentry('worker');
registerLangfuseStandalone();
