import { RealApi } from './api.real.js';

export type {
    IKodusApi,
    IMemoryApi,
    IRulesApi,
    ISessionsApi,
} from './api.interface.js';

export const api = new RealApi();
