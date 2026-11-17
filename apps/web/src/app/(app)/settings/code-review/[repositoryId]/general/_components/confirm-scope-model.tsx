"use client";

import { ConfirmModal } from "@components/ui/confirm-modal";
import { magicModal } from "@components/ui/magic-modal";

/**
 * Speed-bump before saving a `byokModel` override that isn't in the provider's
 * known-models list — we can't verify it, and a wrong id makes reviews fail (or
 * fall back). Preserves the escape hatch for legit custom/proxy model ids.
 */
export const confirmOffCatalogModelSave = (model: string): Promise<boolean> =>
    new Promise((resolve) => {
        magicModal.show(() => (
            <ConfirmModal
                open
                title="Save this model?"
                description={`"${model}" is outside your configured models. Test it before saving.`}
                confirmText="Save anyway"
                cancelText="Go back"
                variant="primary-dark"
                onConfirm={() => {
                    resolve(true);
                    magicModal.hide();
                }}
                onCancel={() => {
                    resolve(false);
                    magicModal.hide();
                }}
            />
        ));
    });
