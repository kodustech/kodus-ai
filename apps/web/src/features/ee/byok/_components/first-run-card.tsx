"use client";

import { Image } from "@components/ui/image";
import { ExternalLinkIcon } from "lucide-react";

import { ConnectProviderFlow } from "./connect-provider-flow";

const PROVIDERS_DOCS_URL = "https://docs.kodus.io/how_to_use/en/byok";

/**
 * D-UI-FIRSTRUN empty state. A no-model org sees the 🐶 hero + copy above the
 * shared PROVIDER-FIRST flow (pick a provider → its Add-a-model form, where the
 * key is pasted and the model chosen). Which model runs each task is chosen later
 * in the Routing tab, so the connect step stays provider-first — no cross-provider
 * "best model" catalog.
 */
export function FirstRunCard() {
    return (
        <ConnectProviderFlow
            existingKeyByProvider={{}}
            // The Kodus line is spoken only when the Kodus tile is actually in
            // the grid. The tile comes from the server registry (cloud-only and
            // allow-listed per org), which is a different gate from the web
            // feature flag — reading the flag here told orgs to "pick Kodus"
            // next to a grid that had no Kodus card.
            hero={({ kodusAvailable }) => (
                <>
                    <span aria-hidden className="w-20">
                        <Image
                            src="/assets/images/kody/look-left-with-paws.png"
                            alt="Kody"
                        />
                    </span>

                    <div className="flex max-w-md flex-col gap-2">
                        <h3 className="text-text-primary text-lg font-semibold text-balance">
                            Connect your first provider
                        </h3>
                        <p className="text-text-secondary text-sm text-pretty">
                            {kodusAvailable
                                ? "Pick Kodus to start with no key at all — usage is billed to your Kodus credits. Or add your own provider key once and enable as many of its models as you want; you pay that provider directly, and Kodus never sees your key."
                                : "Add your provider key once and enable as many of its models as you want. You pay that provider directly, and Kodus never sees your key."}
                        </p>
                    </div>
                </>
            )}
            footer={
                <a
                    href={PROVIDERS_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-secondary hover:text-text-primary inline-flex items-center gap-1 text-xs hover:underline">
                    How connecting a provider works
                    <ExternalLinkIcon size={12} />
                </a>
            }
        />
    );
}
