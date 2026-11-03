import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";

const providerLabel = (providerId?: string) => {
    switch (providerId) {
        case "kodus":
            return "Kodus";
        case "openai":
            return "OpenAI";
        case "openai_compatible":
            return "OpenAI-compatible";
        case "anthropic_compatible":
            return "Anthropic-compatible";
        case "anthropic":
            return "Anthropic";
        case "google_gemini":
            return "Google AI Studio (Gemini)";
        case "google_vertex":
            return "Google Vertex AI";
        default:
            return providerId ?? "Unknown";
    }
};

const EnvDataValue = ({ children }: { children: React.ReactNode }) => (
    <code className="bg-card-lv2 rounded px-1.5 py-0.5 font-mono text-xs break-all">
        {children}
    </code>
);

/** The LLM configured through environment variables, as the server reads it. */
export const EnvConfigNotice = ({ env }: { env: LLMConfigStatus["env"] }) => {
    if (!env.configured) {
        if (!env.invalidReason) return null;
        return (
            <Alert variant="danger">
                <TriangleAlertIcon />
                <AlertTitle className="text-balance">
                    The LLM configured via environment variables cannot run.
                </AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                    <p className="text-pretty">{env.invalidReason}</p>
                    <p className="text-pretty">
                        Reviews fail until the server environment is fixed and
                        restarted, or a model is connected below.
                    </p>
                </AlertDescription>
            </Alert>
        );
    }

    const declared = env.providerSource === "declared";

    return (
        <Alert variant="info">
            <InfoIcon />
            <AlertTitle className="text-balance">
                Kodus is currently using an LLM configured via environment
                variables.
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
                <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
                    {env.model && (
                        <>
                            <dt className="text-text-secondary">Model</dt>
                            <dd>
                                <EnvDataValue>{env.model}</EnvDataValue>
                            </dd>
                        </>
                    )}

                    <dt className="text-text-secondary">Provider</dt>
                    <dd className="text-text-primary">
                        {providerLabel(env.providerId)}{" "}
                        <span className="text-text-secondary">
                            {declared ? (
                                <>
                                    (set in{" "}
                                    <EnvDataValue>API_LLM_PROVIDER</EnvDataValue>
                                    )
                                </>
                            ) : (
                                <>
                                    (guessed from the model name; set{" "}
                                    <EnvDataValue>API_LLM_PROVIDER</EnvDataValue>{" "}
                                    to choose it)
                                </>
                            )}
                        </span>
                    </dd>

                    {env.baseUrl && (
                        <>
                            <dt className="text-text-secondary">Endpoint</dt>
                            <dd>
                                <EnvDataValue>{env.baseUrl}</EnvDataValue>
                            </dd>
                        </>
                    )}

                    {env.vertexLocation && (
                        <>
                            <dt className="text-text-secondary">
                                Vertex location
                            </dt>
                            <dd>
                                <EnvDataValue>
                                    {env.vertexLocation}
                                </EnvDataValue>
                            </dd>
                        </>
                    )}

                    {env.reasoningEffort && (
                        <>
                            <dt className="text-text-secondary">
                                Reasoning effort
                            </dt>
                            <dd>
                                <EnvDataValue>
                                    {env.reasoningEffort}
                                </EnvDataValue>
                            </dd>
                        </>
                    )}
                </dl>

                {!!env.warnings?.length && (
                    <ul className="text-warning flex list-disc flex-col gap-1 pl-5">
                        {env.warnings.map((warning) => (
                            <li key={warning} className="text-pretty">
                                {warning}
                            </li>
                        ))}
                    </ul>
                )}

                <p className="text-pretty">
                    The API key is not shown for security. Connecting a model
                    below and saving will{" "}
                    <strong className="text-text-primary font-semibold">
                        override
                    </strong>{" "}
                    this env-based configuration.
                </p>
            </AlertDescription>
        </Alert>
    );
};
