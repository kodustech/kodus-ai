import { notFound } from "next/navigation";
import { isKodyRuntimeReleased } from "src/core/feature-gate/kody-runtime";

import { KodyRuntimeRepositoryPage } from "./_page-component";

/** Kody Runtime is an alpha: an org it is not released to finds no settings page here. */
export default async function KodyRuntimeRepositoryRoute() {
    if (!(await isKodyRuntimeReleased())) notFound();
    return <KodyRuntimeRepositoryPage />;
}
