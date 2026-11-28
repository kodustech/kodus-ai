import type { ImageStoreConfig, ImageStoreProvider } from '@libs/runtime/fleet/image-store';
import { OciRegistryImageStore } from '@libs/runtime/fleet/image-store-oci';

/**
 * The provider a pool's `imageStore` config names, for the hub's production wiring. Only `oci-registry` is served, and only
 * with the signing key (RUNTIME_IMAGE_STORE_SIGNING_KEY); a config this hub cannot serve gets no provider, so its pool's
 * claims build as before. A key that is not EC P-256 throws here, at boot, never at the first claim. The `fake` provider is
 * for specs, which pass their own.
 */
export function imageStoreProviders(signingKeyPem: string | undefined): (config: ImageStoreConfig) => ImageStoreProvider | undefined {
    const oci = signingKeyPem ? new OciRegistryImageStore(signingKeyPem) : undefined;
    return (config) => (config.provider === 'oci-registry' ? oci : undefined);
}
