import type { ComponentType } from "react";

import { BedrockFields } from "./bedrock";
import { OpenRouterRoutingFields } from "./openrouter-advanced";
import { VertexFields } from "./vertex";

/**
 * Per-provider credential FORMS, keyed by provider id.
 *
 * A provider whose connect form needs more than a single API key — multi-field
 * cloud auth like Vertex's service-account JSON + region, or Bedrock's API-key /
 * IAM-user split — registers its form component HERE (one entry, next to the form
 * file it points at). `ByokCredentialsInput` renders the match automatically;
 * every provider NOT in this map falls back to the generic single-key input.
 *
 * This is the web-side sibling of the backend provider module: UI components
 * can't live in `libs/llm` (that's backend), but a contributor still adds their
 * provider's form in ONE contributable place instead of editing a hardcoded
 * switch. To add one: drop `./<provider>.tsx` exporting a form component that
 * reads/writes the RHF `EditKeyForm`, then add a line below.
 */
export const CREDENTIAL_FORMS: Record<string, ComponentType> = {
    google_vertex: VertexFields,
    amazon_bedrock: BedrockFields,
};

/**
 * Per-provider ADVANCED fields, rendered at the foot of the "Advanced settings"
 * section (non-credential, provider-specific knobs — e.g. OpenRouter's upstream
 * pinning). Same contributor pattern as CREDENTIAL_FORMS: register here instead
 * of adding a `provider === "x"` branch inside the shared advanced-settings UI.
 */
export const ADVANCED_FIELDS: Record<string, ComponentType> = {
    open_router: OpenRouterRoutingFields,
};
