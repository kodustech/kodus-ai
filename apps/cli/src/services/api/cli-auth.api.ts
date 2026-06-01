import { request } from './api-core.js';

export interface CliLoginInitResponse {
    verificationUri: string;
    state: string;
    expiresIn: number;
}

export interface CliDeviceInitResponse {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
}

export type CliLoginPollStatus =
    | 'pending'
    | 'completed'
    | 'consumed'
    | 'denied'
    | 'expired'
    | 'not_found';

export interface CliLoginPollResponse {
    status: CliLoginPollStatus;
    accessToken?: string;
    refreshToken?: string;
    userEmail?: string;
}

export const cliAuthApi = {
    initLoopback(port: number): Promise<CliLoginInitResponse> {
        return request<CliLoginInitResponse>('/cli/auth/login-init', {
            method: 'POST',
            body: JSON.stringify({ port }),
        });
    },
    initDevice(): Promise<CliDeviceInitResponse> {
        return request<CliDeviceInitResponse>('/cli/auth/device-init', {
            method: 'POST',
        });
    },
    poll(params: {
        state?: string;
        deviceCode?: string;
    }): Promise<CliLoginPollResponse> {
        const search = new URLSearchParams();
        if (params.state) {search.append('state', params.state);}
        if (params.deviceCode) {search.append('device_code', params.deviceCode);}
        return request<CliLoginPollResponse>(
            `/cli/auth/login-poll?${search.toString()}`,
            { method: 'GET' },
        );
    },
};
