"use client";

import { Image } from "@components/ui/image";
import { ExternalLinkIcon } from "lucide-react";

import { ConnectProviderFlow } from "./connect-provider-flow";

const BYOK_DOCS_URL = "https://docs.kodus.io/how_to_use/en/byok";

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
            hero={
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
                            Add your key once — then enable as many of that
                            provider’s models as you want. You pay your provider
                            directly, and Kodus never sees your key.
                        </p>
                    </div>
                </>
            }
            footer={
                <a
                    href={BYOK_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-secondary hover:text-text-primary inline-flex items-center gap-1 text-xs hover:underline">
                    How BYOK works
                    <ExternalLinkIcon size={12} />
                </a>
            }
        />
    );
}
