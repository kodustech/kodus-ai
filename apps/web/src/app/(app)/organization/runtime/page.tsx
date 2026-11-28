import { redirect } from "next/navigation";

/**
 * The organization's Runtime settings (the budget and the stop) live with the rest of the Runtime, under
 * /runtime/settings. This route stays for old links.
 */
export default function OrganizationRuntimePage() {
    redirect("/runtime/settings");
}
