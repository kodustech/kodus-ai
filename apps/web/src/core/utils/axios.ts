import Axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import { getJWTToken } from "./session";

const axiosClient = Axios.create({
    headers: {
        "Accept": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
    },
});

export const axiosApi = {
    get: <T>(
        url: string,
        params?: AxiosRequestConfig<any>,
    ): Promise<AxiosResponse<any, any>> =>
        axiosClient.get<T>(url, {
            ...params,
        }),
    post: <T>(
        url: string,
        data: any,
        params?: AxiosRequestConfig<any>,
    ): Promise<AxiosResponse<any, any>> =>
        axiosClient.post<T>(url, data, {
            ...params,
        }),
    patch: <T>(
        url: string,
        data: any,
        params?: AxiosRequestConfig<any>,
    ): Promise<AxiosResponse<any, any>> =>
        axiosClient.patch<T>(url, data, {
            ...params,
        }),
    delete: <T>(
        url: string,
        params?: AxiosRequestConfig<any>,
    ): Promise<AxiosResponse<any, any>> =>
        axiosClient.delete<T>(url, {
            ...params,
        }),
    put: <T>(
        url: string,
        data: any,
        params?: AxiosRequestConfig<any>,
    ): Promise<AxiosResponse<any, any>> =>
        axiosClient.put<T>(url, data, {
            ...params,
        }),
};

const fetcher = async <T>(url: string, params?: AxiosRequestConfig<any>) => {
    const headers = {
        Authorization: "Bearer " + (await getJWTToken()),
    };

    const axiosParams = {
        headers,
        withCredentials: true,
        ...params,
    };

    return axiosApi.get<T>(url, axiosParams).then((res) => res.data);
};

const post = async <T>(
    url: string,
    data: any,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    const headers = {
        Authorization: "Bearer " + (await getJWTToken()),
    };

    const axiosParams = {
        ...params,
        headers,
        withCredentials: true,
    };

    return axiosApi.post<T>(url, data, axiosParams).then((res) => res.data);
};

const patch = async <T>(
    url: string,
    data: any,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    const headers = {
        Authorization: "Bearer " + (await getJWTToken()),
    };

    const axiosParams = {
        ...params,
        headers,
        withCredentials: true,
    };

    return axiosApi.patch<T>(url, data, axiosParams).then((res) => res.data);
};

const deleted = async <T>(
    url: string,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    const headers = {
        Authorization: "Bearer " + (await getJWTToken()),
    };

    const axiosParams = {
        ...params,
        headers,
        withCredentials: true,
    };

    return axiosApi.delete<T>(url, axiosParams).then((res) => res.data);
};

const put = async <T>(
    url: string,
    data: any,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    const headers = {
        Authorization: "Bearer " + (await getJWTToken()),
    };

    const axiosParams = {
        ...params,
        headers,
        withCredentials: true,
    };

    return axiosApi.put<T>(url, data, axiosParams).then((res) => res.data);
};

export const axiosAuthorized = {
    post,
    fetcher,
    deleted,
    patch,
    put,
};
