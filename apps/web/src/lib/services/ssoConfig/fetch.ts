import { authorizedFetch, TypedFetchError } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";
import {
    ConfirmSSODomainVerificationResponse,
    GetSSOConnectionTestResultResponse,
    RequestSSODomainVerificationResponse,
    SSOConfig,
    SSODomainVerificationStatusItem,
    SSOProtocol,
    SSOProtocolConfigMap,
    StartSSOConnectionTestResponse,
} from "src/lib/auth/types";

import { SSO_CONFIG_PATHS } from "./index";

export const getSSOConfig = async <T extends SSOProtocol>(params: {
    active?: boolean;
    protocol?: T;
}): Promise<SSOConfig<T> | null> => {
    try {
        const response = await authorizedFetch<SSOConfig<T>>(
            SSO_CONFIG_PATHS.GET,
            {
                params,
            },
        );

        return response;
    } catch (error) {
        if (TypedFetchError.isError(error) && error.statusCode === 404) {
            return null;
        }
        throw error;
    }
};

export const createOrUpdateSSOConfig = async <T extends SSOProtocol>(params: {
    uuid?: string;
    protocol: T;
    providerConfig: SSOProtocolConfigMap[T];
    active?: boolean;
    domains?: string[];
    testSessionId?: string;
}): Promise<SSOConfig<T>> => {
    const response = await axiosAuthorized.post<SSOConfig<T>>(
        SSO_CONFIG_PATHS.CREATE_OR_UPDATE,
        {
            uuid: params.uuid,
            protocol: params.protocol,
            providerConfig: params.providerConfig,
            active: params.active,
            domains: params.domains,
            testSessionId: params.testSessionId,
        },
    );

    return response;
};

export const startSSOConnectionTest = async <T extends SSOProtocol>(params: {
    protocol: T;
    providerConfig: SSOProtocolConfigMap[T];
    domains: string[];
}): Promise<StartSSOConnectionTestResponse> => {
    const response = await axiosAuthorized.post<StartSSOConnectionTestResponse>(
        SSO_CONFIG_PATHS.TEST_START,
        params,
    );
    return "data" in response
        ? (response.data as StartSSOConnectionTestResponse)
        : response;
};

export const getSSOConnectionTestResult = async (
    sessionId: string,
): Promise<GetSSOConnectionTestResultResponse> => {
    const response =
        await axiosAuthorized.fetcher<GetSSOConnectionTestResultResponse>(
            SSO_CONFIG_PATHS.TEST_RESULT,
            {
                params: {
                    sessionId,
                },
            },
        );
    return "data" in response
        ? (response.data as GetSSOConnectionTestResultResponse)
        : response;
};

export const requestSSODomainVerification = async (params: {
    domain: string;
    contactEmail: string;
    organizationName: string;
}): Promise<RequestSSODomainVerificationResponse> => {
    const response =
        await axiosAuthorized.post<RequestSSODomainVerificationResponse>(
            SSO_CONFIG_PATHS.DOMAIN_VERIFICATION_REQUEST,
            params,
        );
    return "data" in response
        ? (response.data as RequestSSODomainVerificationResponse)
        : response;
};

export const confirmSSODomainVerification = async (token: string) => {
    const response =
        await axiosAuthorized.post<ConfirmSSODomainVerificationResponse>(
            SSO_CONFIG_PATHS.DOMAIN_VERIFICATION_CONFIRM,
            {
                token,
            },
        );
    return "data" in response
        ? (response.data as ConfirmSSODomainVerificationResponse)
        : response;
};

export const getSSODomainVerificationStatus = async (domains: string[]) => {
    const response = await axiosAuthorized.post<
        SSODomainVerificationStatusItem[]
    >(SSO_CONFIG_PATHS.DOMAIN_VERIFICATION_STATUS, {
        domains,
    });
    return "data" in response
        ? (response.data as SSODomainVerificationStatusItem[])
        : response;
};
