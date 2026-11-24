/**
 * Every unambiguous way the instructions say where a rule file lives, read
 * the same way: each place form (the bare name with "repository", quoted or
 * not, the owner/name, its URL, "from <name>", "(<name>)", the Portuguese
 * form), linked or not, after or before a list of one to three files joined
 * by each separator, with a file quoted or not, and two files each with its
 * own place. A guard for the placement rules in mentioned-files.ts: any
 * change to them has to keep all of these.
 */
import { mentionedFilesNotFollowed } from "./mentioned-files";

type Repository = { full: string; bare: string; linked: boolean };

const IRRIGATION = {
    full: "greenhouse/irrigation-rules",
    bare: "irrigation-rules",
    linked: true,
};
const PUMPS = {
    full: "greenhouse/pump-rules",
    bare: "pump-rules",
    linked: true,
};
const VALVES = { full: "acme/valve-rules", bare: "valve-rules", linked: false };
const LINKED = [IRRIGATION.full, PUMPS.full];

/** Each way to place a file in a repository; null where the form cannot
 *  name an unlinked repository (a bare name is only known when linked). */
const FORMS: Record<string, (repository: Repository) => string | null> = {
    "the <name> repository": (r) => `in the ${r.bare} repository`,
    "the `<name>` repository": (r) => `in the \`${r.bare}\` repository`,
    "<owner/name>": (r) => `in ${r.full}`,
    "`<owner/name>`": (r) => `in \`${r.full}\``,
    "<URL>": (r) => `from https://github.com/${r.full}`,
    "from <name>": (r) => (r.linked ? `from ${r.bare}` : null),
    "(<name>)": (r) => (r.linked ? `(${r.bare})` : null),
    "no repositório <owner/name>": (r) => `no repositório ${r.full}`,
};
/** Forms that read only after the files they place. */
const AFTER_ONLY = new Set(["from <name>", "(<name>)"]);
const SEPARATORS = [", ", " and ", ", and ", " or ", " & "];
const LISTS = [
    ["docs/a.md"],
    ["docs/a.md", "docs/b.md"],
    ["docs/a.md", "docs/b.md", "docs/c.md"],
];

const list = (files: string[], separator: string, quoted: boolean) => {
    const q = (file: string) => (quoted ? `\`${file}\`` : file);
    if (files.length === 1) return q(files[0]);
    if (files.length === 2) return `${q(files[0])}${separator}${q(files[1])}`;
    return `${q(files[0])}, ${q(files[1])}${separator}${q(files[2])}`;
};
const placedIn = (repository: Repository, ...files: string[]) =>
    repository.linked ? files.map((file) => `${repository.full}:${file}`) : [];
const other = (repository: Repository) =>
    repository === IRRIGATION ? PUMPS : IRRIGATION;
const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);

const cases: Array<{ form: string; text: string; expected: string[] }> = [];
for (const [form, place] of Object.entries(FORMS)) {
    for (const repository of [IRRIGATION, PUMPS, VALVES]) {
        const where = place(repository);
        if (!where) continue;
        // A repository named in an earlier sentence never outranks it.
        const earlier = `Read ${other(repository).bare} first. `;
        for (const files of LISTS) {
            for (const separator of SEPARATORS) {
                for (const quoted of [false, true]) {
                    const named = list(files, separator, quoted);
                    const expected = placedIn(repository, ...files);
                    cases.push({
                        form,
                        text: `${earlier}Read ${named} ${where}.`,
                        expected,
                    });
                    if (!AFTER_ONLY.has(form)) {
                        cases.push({
                            form,
                            text: `${earlier}${capitalized(where)}, read ${named}.`,
                            expected,
                        });
                    }
                }
            }
        }
        for (const second of [IRRIGATION, PUMPS, VALVES]) {
            const secondWhere = place(second);
            if (!secondWhere) continue;
            cases.push({
                form,
                text: `Read docs/a.md ${where} and docs/b.md ${secondWhere}.`,
                expected: [
                    ...placedIn(repository, "docs/a.md"),
                    ...placedIn(second, "docs/b.md"),
                ],
            });
            cases.push({
                form,
                text: `Read docs/a.md and docs/b.md ${where}, then docs/c.md ${secondWhere}.`,
                expected: [
                    ...placedIn(repository, "docs/a.md", "docs/b.md"),
                    ...placedIn(second, "docs/c.md"),
                ],
            });
        }
    }
}

describe("mentionedFilesNotFollowed phrasings", () => {
    it(`reads all ${cases.length} phrasings of where a file lives`, () => {
        const misread = cases.flatMap(({ form, text, expected }) => {
            const offered = mentionedFilesNotFollowed(
                text,
                LINKED,
                [],
                "valves",
            ).map((file) => `${file.repository ?? "(reviewed)"}:${file.path}`);
            return JSON.stringify([...offered].sort()) ===
                JSON.stringify([...expected].sort())
                ? []
                : [`${form}: ${text} → ${JSON.stringify(offered)}`];
        });
        expect(misread).toEqual([]);
    });
});
