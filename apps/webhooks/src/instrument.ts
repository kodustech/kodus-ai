import 'dotenv/config';

import { setupSentry } from '@libs/core/infrastructure/config/log/sentry';
import {
    registerLangfuseAiSdkTelemetry,
    registerLangfuseStandalone,
} from '@libs/core/log/langfuse';

setupSentry('webhook');
registerLangfuseStandalone();
registerLangfuseAiSdkTelemetry();
