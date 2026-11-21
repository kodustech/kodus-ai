import { redirect } from "next/navigation";

export default function RuntimeIndexPage() {
    redirect("/runtime/runs");
}
