/**
 * "reaches `pkg/api/health.go` · Kody's mapping": the changed file with no
 * route of its own that this route reaches. It is what Kody's mapping says,
 * never measured coverage of the file, so the screen says so in words.
 */
export const ViaNote = ({ via }: { via: string }) => (
    <span
        className="text-text-tertiary inline-flex min-w-0 flex-wrap items-baseline gap-x-1 text-xs"
        title="Kody mapped this changed file to the route. The file itself is not measured: only the route's answers are.">
        reaches
        <code className="text-text-secondary font-mono break-all">{via}</code>
        <span>· Kody&apos;s mapping</span>
    </span>
);
