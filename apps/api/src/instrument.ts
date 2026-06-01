import 'dotenv/config';

import { setupSentry } from '@libs/core/infrastructure/config/log/sentry';
import { registerLangfuseStandalone } from '@libs/core/log/langfuse';

// Sentry runs with `skipOpenTelemetrySetup: true` so it doesn't claim the
// global TracerProvider — Sentry keeps capturing errors via its own API,
// and Langfuse owns the OTel side here. Order doesn't matter anymore.
setupSentry('api');
registerLangfuseStandalone();
