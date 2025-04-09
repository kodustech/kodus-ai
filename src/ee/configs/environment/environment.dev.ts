/**
 * @license
 * Kodus Tech. All rights reserved.
 *
 * This file is generated at Docker image build time.
 * Once compiled, the value of `API_CLOUD_MODE` is hardcoded and cannot be changed using .env,
 * docker run, or docker-compose overrides.
 */

export const environment = {
    /**
     * Enables cloud mode when running locally.
     * Can be overridden with process.env.API_CLOUD_MODE=true/false
     */
    API_CLOUD_MODE:
        (process.env.API_CLOUD_MODE || 'true').toLowerCase() === 'true',
};
