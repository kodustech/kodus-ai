import { redirect } from "next/navigation";

// Integrations only ever held the Git provider cards, and Repositories
// (/settings/git) connects, resets and scopes that same provider. Two pages
// for one connection, and nothing in the nav linked here; old links and
// bookmarks land on the one that stays.
export default function IntegrationsPage() {
    redirect("/settings/git");
}
