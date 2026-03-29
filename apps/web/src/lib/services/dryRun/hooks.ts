import { useEffect, useRef, useState } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { getJWTToken } from "src/core/utils/session";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { DRY_RUN_PATHS } from ".";
import { fetchDryRunDetails, fetchDryRunStatus } from "./fetch";
import {
    DryRunEventType,
    DryRunStatus,
    IDryRunEvent,
    IDryRunMessage,
    IDryRunMessageAddedPayload,
    IFile,
    ISuggestionByPR,
} from "./types";

export const PREVIEW_JOB_ID_KEY = "activePreviewJobId";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const useDryRun = ({
    correlationId,
    teamId,
}: {
    correlationId: string | null;
    teamId: string;
}) => {
    const [messages, setMessages] = useState<IDryRunMessage[]>([]);
    const [status, setStatus] = useState<DryRunStatus | null>(null);
    const [description, setDescription] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [files, setFiles] = useState<IFile[]>([]);
    const [prLevelSuggestions, setPrLevelSuggestions] = useState<
        ISuggestionByPR[]
    >([]);

    const eventSourceRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!correlationId || !teamId) {
            setIsLoading(false);
            return;
        }

        const checkAndConnect = async () => {
            setIsLoading(true);
            setError(null);
            setMessages([]);
            setStatus(null);
            setDescription(null);
            setFiles([]);
            setPrLevelSuggestions([]);

            try {
                let initialStatus: DryRunStatus | null = null;
                const maxRetries = 5;
                const initialDelay = 500; // 500ms

                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    initialStatus = await fetchDryRunStatus(
                        correlationId,
                        teamId,
                    );

                    if (initialStatus !== null) {
                        break;
                    }

                    console.warn(
                        `Attempt ${attempt} to fetch dry run status: Not found (null). Retrying...`,
                    );

                    if (attempt < maxRetries) {
                        await sleep(initialDelay * Math.pow(2, attempt - 1));
                    }
                }

                if (initialStatus === null) {
                    throw new Error(
                        "Failed to get dry run status after multiple attempts. Job not found.",
                    );
                }

                if (
                    initialStatus === DryRunStatus.COMPLETED ||
                    initialStatus === DryRunStatus.FAILED
                ) {
                    await fetchFinalDetails();
                    return;
                }

                if (initialStatus === DryRunStatus.IN_PROGRESS) {
                    setStatus(initialStatus);
                    connectToStream();
                    return;
                }

                throw new Error(`Unexpected dry run status: ${initialStatus}`);
            } catch (err: any) {
                console.error("Error checking dry run status:", err);
                setError(err.message || "An unknown error occurred");
                setIsLoading(false);
                sessionStorage.removeItem(PREVIEW_JOB_ID_KEY);
            }
        };

        const fetchFinalDetails = async () => {
            try {
                setIsLoading(true);
                const details = await fetchDryRunDetails(correlationId, teamId);

                if (details) {
                    setMessages(details.messages || []);
                    setStatus(details.status);
                    setDescription(details.description || null);
                    setFiles(details.files || []);
                    setPrLevelSuggestions(details.prLevelSuggestions || []);
                }
            } catch (err: any) {
                console.error("Failed to fetch final dry run details:", err);
                setError(err.message || "Failed to get final details.");
            } finally {
                sessionStorage.removeItem(PREVIEW_JOB_ID_KEY);
                setIsLoading(false);
                setIsConnected(false);
            }
        };

        const connectToStream = async () => {
            eventSourceRef.current?.abort();

            const controller = new AbortController();
            eventSourceRef.current = controller;

            const url = new URL(`${DRY_RUN_PATHS.SSE_EVENTS}/${correlationId}`);
            const finalUrl = addSearchParamsToUrl(url.toString(), {
                teamId,
            });

            const accessToken = await getJWTToken();

            return fetchEventSource(finalUrl, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
                signal: controller.signal,

                onopen: async (response) => {
                    if (response.ok) {
                        setIsConnected(true);
                    } else {
                        controller.abort();
                        setError(
                            `Failed to connect: ${response.status} ${response.statusText}`,
                        );
                        setIsLoading(false);
                        setIsConnected(false);
                    }
                },

                onmessage: (event) => {
                    if (!event.data) {
                        return;
                    }

                    console.log("Received SSE event:", event);

                    let parsedEvent: IDryRunEvent | undefined;
                    try {
                        parsedEvent = JSON.parse(event.data) as IDryRunEvent;
                    } catch (err) {
                        console.error("Failed to parse SSE event data:", err);
                        return;
                    }

                    if (!parsedEvent) {
                        console.warn("Received empty or invalid event:", event);
                        return;
                    }

                    switch (parsedEvent.type) {
                        case DryRunEventType.MESSAGE_ADDED: {
                            const payload =
                                parsedEvent.payload as IDryRunMessageAddedPayload;

                            console.log("Adding message:", payload.message);
                            setMessages((prev) => {
                                const index = prev.findIndex(
                                    (msg) => msg.id === payload.message.id,
                                );

                                if (index !== -1) {
                                    const newState = [...prev];
                                    newState[index] = payload.message;
                                    return newState;
                                }

                                return [...prev, payload.message];
                            });
                            break;
                        }

                        case DryRunEventType.MESSAGE_UPDATED: {
                            const payload = parsedEvent.payload;
                            setMessages((prev) =>
                                prev.map((msg) => {
                                    if (msg.id === payload.messageId) {
                                        return {
                                            ...msg,
                                            content: payload.content,
                                        };
                                    }
                                    return msg;
                                }),
                            );
                            break;
                        }

                        case DryRunEventType.STATUS_UPDATED: {
                            const payload = parsedEvent.payload;
                            setStatus(payload.status);

                            if (
                                payload.status === DryRunStatus.COMPLETED ||
                                payload.status === DryRunStatus.FAILED
                            ) {
                                controller.abort(); // Gracefully close connection
                                setIsConnected(false);
                                fetchFinalDetails();
                            }
                            break;
                        }

                        case DryRunEventType.DESCRIPTION_UPDATED: {
                            const payload = parsedEvent.payload;
                            setDescription(payload.description);
                            break;
                        }

                        case DryRunEventType.REMOVED: {
                            controller.abort();
                            setIsConnected(false);
                            setIsLoading(false);
                            break;
                        }
                    }
                },

                onclose: () => {
                    console.log("SSE connection closed.");
                    setIsConnected(false);
                    setIsLoading(false);
                },

                onerror: (err) => {
                    console.error("SSE Error:", err);
                    setError("Connection to server lost.");
                    setIsConnected(false);
                    setIsLoading(false);

                    if (err.name === "AbortError") {
                        return;
                    }
                },
            });
        };

        checkAndConnect();

        return () => {
            console.log("Aborting event source from effect cleanup.");
            eventSourceRef.current?.abort();
            setIsConnected(false);
            setIsLoading(false);
        };
    }, [correlationId, teamId]);

    return {
        messages,
        status,
        description,
        isLoading,
        isConnected,
        error,
        files,
        prLevelSuggestions,
    };
};
