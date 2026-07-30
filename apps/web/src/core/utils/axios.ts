import Axios, { AxiosRequestConfig, AxiosResponse } from "axios";

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

// The /api/proxy route injects the Bearer token from the httpOnly session
// cookie server-side, so these client methods no longer fetch/attach the
// token themselves — they only need to send the cookie (withCredentials).
const fetcher = async <T>(url: string, params?: AxiosRequestConfig<any>) => {
    return axiosApi
        .get<T>(url, { withCredentials: true, ...params })
        .then((res) => res.data);
};

const post = async <T>(
    url: string,
    data: any,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    return axiosApi
        .post<T>(url, data, { ...params, withCredentials: true })
        .then((res) => res.data);
};

const patch = async <T>(
    url: string,
    data: any,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    return axiosApi
        .patch<T>(url, data, { ...params, withCredentials: true })
        .then((res) => res.data);
};

const deleted = async <T>(
    url: string,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    return axiosApi
        .delete<T>(url, { ...params, withCredentials: true })
        .then((res) => res.data);
};

const put = async <T>(
    url: string,
    data: any,
    params?: AxiosRequestConfig<any>,
): Promise<T> => {
    return axiosApi
        .put<T>(url, data, { ...params, withCredentials: true })
        .then((res) => res.data);
};

export const axiosAuthorized = {
    post,
    fetcher,
    deleted,
    patch,
    put,
};
