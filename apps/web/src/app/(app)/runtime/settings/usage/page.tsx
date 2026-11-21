import { redirect } from "next/navigation";
import { RUNTIME_USAGE_HREF } from "@services/runtime/model/usage-report";

/** Runtime usage moved to the Runtime tab of the Usage screen; old links land there. */
export default function RuntimeUsageRoute() {
    redirect(RUNTIME_USAGE_HREF);
}
