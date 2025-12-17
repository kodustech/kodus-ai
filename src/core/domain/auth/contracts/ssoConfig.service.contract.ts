import { ISSOConfigRepository } from './ssoConfig.repository.contract';

export const SSO_CONFIG_SERVICE_TOKEN = Symbol('SSOConfigService');

export interface ISSOConfigService extends ISSOConfigRepository {}
