"use server";

import axios from "axios";
import { MetadataReader } from "passport-saml-metadata";
import { useAgent } from "request-filtering-agent";

export async function parseMetadataFromFile(fileContent: string) {
    try {
        const metadata = new MetadataReader(fileContent);
        return {
            idpIssuer: metadata.entityId,
            entryPoint: metadata.identityProviderUrl,
            cert: metadata.signingCert,
            identifierFormat: metadata.identifierFormat,
            success: true,
        };
    } catch (error) {
        console.error("Metadata parse error:", error);
        return { success: false, error: "Failed to parse metadata file" };
    }
}

export async function fetchAndParseMetadata(url: string) {
    if (!url) throw new Error("URL is required");

    try {
        const parsedUrl = new URL(url);
        if (
            !["http:", "http", "https:", "https"].includes(parsedUrl.protocol)
        ) {
            throw new Error("URL must use http or https protocol");
        }

        const response = await axios.get(url, {
            // httpAgent: useAgent(url),
            // httpsAgent: useAgent(url),
            responseType: "text",
            transitional: {
                silentJSONParsing: false,
                forcedJSONParsing: false,
            },
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Failed to fetch metadata: ${response.statusText}`);
        }

        const rawMetadata = (await response.data) as string;
        return await parseMetadataFromFile(rawMetadata);
    } catch (error) {
        console.error("Metadata fetch error:", error);
        return { success: false, error: "Failed to fetch metadata" };
    }
}
