import { sealingKeyFrom } from '@libs/runtime/run';

/**
 * DEV AND TESTS ONLY: the sealing key of the local stacks (the runtime-worker
 * default in docker-compose.dev.yml is this same value). A production worker
 * gets its own RUNTIME_SECRET_SEAL_KEY, shared only with the product.
 */
export const DEV_SECRET_SEAL_KEY_HEX = 'de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de70';

export const devSealKey = () => sealingKeyFrom(DEV_SECRET_SEAL_KEY_HEX);
