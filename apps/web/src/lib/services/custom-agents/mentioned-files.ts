/**
 * "Follow it" (#2384): the rule files an agent's instructions name that the
 * agent does not follow, and the repository the text places each one in.
 *
 * The text is read once, then in stages, each a small function over that
 * reading: files and sentences → linked repositories it names → choices
 * between repositories ("a or b") → place phrases ("in the a repository") →
 * what each file is attached to → where each file lives. The rule throughout:
 * a file is offered only in a repository the text names for it, and anything
 * unclear offers nothing. "Follow it" must never add a source the text does
 * not name.
 */
import { isLinked, knowledgeItemFromPath, knowledgeKey } from "./drafts";
import type { KnowledgeItem } from "./types";

/** A file the instructions name, as the item that would follow it. */
export type MentionedFile = Pick<KnowledgeItem, "path" | "kind" | "repository">;

/** A text file named in prose: `rules/x.mdc`, `CLAUDE.md`, never a URL or a
 *  code file (instructions name code to look at, not rules to follow). */
const MENTIONED_FILE =
    /(?:^|[\s`'"([<])((?:[\w.-]+\/)*[\w.-]+\.(?:mdc|mdx|md|markdown))(?=$|[\s`'".,;:!?)\]>])/gi;

/** Files a repository has that are never a rule to follow. */
const NOT_A_RULE_FILE =
    /^(readme|changelog|changes|history|license|licence|notice|authors|contributors)\.(md|mdx|markdown)$/i;

/** Where each sentence ends: a mark before whitespace or the end of the
 *  text (the dot in "a.md" ends nothing), or a blank line (a wrapped line
 *  does not end one). A repository named in a file's sentence says where
 *  the file lives ("in the pump-rules repository"); one in another sentence
 *  is about something else ("use the repository pattern"). */
const SENTENCE_END = /[.;!?](?=\s|$)|\r?\n[ \t]*\r?\n/g;

/** A phrase that names where a file lives: a named repository after "in",
 *  "from"… ("in the pump-rules repository", "from our rules repo"), the
 *  Portuguese "no repositório X", "repository owner/name", or an
 *  `owner/name` (a URL too) after "in", "from"… ("in acme/rules"). */
const REPOSITORY_PLACE = new RegExp(
    [
        String.raw`\b(?:in|from|on|at|inside|under)\s+(?:(?:the|our|a|their|its|this)\s+)?(?:(?!(?:the|our|a|their|its|this)\b)[\x60'"]?[\w./-]+[\x60'"]?\s+){1,4}(?:repo|repository)\b`,
        String.raw`\b(?:no|na|do|da|em)\s+(?:nosso\s+|o\s+)?reposit[óo]rio\s+[\x60'"]?[\w./-]+`,
        String.raw`\b(?:repo|repository|reposit[óo]rio)\s+[\x60'"]?[\w.-]+\/[\w./-]+`,
        String.raw`\b(?:in|from|on|at|inside|under)\s+(?:the\s+)?[\x60'"]?(?:https?:\/\/[\w.-]+\/)?[\w.-]+\/[\w.-]+(?![\w/-])`,
    ].join("|"),
    "gi",
);

/** A place that names the reviewed repository itself: "in this
 *  repository", "in the same repo", "neste repositório". */
const LOCAL_PLACE = new RegExp(
    [
        String.raw`\b(?:in|from|on|at|inside|under)\s+(?:this|the)\s+(?:(?:same|current|reviewed|present)\s+)?(?:repo|repository)\b(?!\s+[\x60'"]?[\w.-]+\/)`,
        String.raw`\b(?:neste|nesse|deste|desse|n[oa]\s+(?:mesmo|pr[óo]prio)|d[oa]\s+(?:mesmo|pr[óo]prio))\s+reposit[óo]rio\b`,
        String.raw`\b(?:no|do)\s+reposit[óo]rio\s+(?:atual|revisado)\b`,
    ].join("|"),
    "gi",
);

/** What turns a local place into a comparison: "the same repo as …". */
const COMPARED_TO = /^\s+(?:as|like|que)\s+(?:(?:the|o|a)\s+)?[\x60'"]?/;

/** A repository named at the very start of a text, linked or not: an
 *  owner/name or its URL, "the pump-rules repository", "repositório X".
 *  "this repository" names the reviewed one, not another. */
const NAMES_A_REPOSITORY = new RegExp(
    [
        String.raw`^(?:https?:\/\/[\w.-]+\/)?[\w-][\w.-]*\/[\w.-]*[\w-](?![\w/-])(?!\.[\w-])`,
        String.raw`^(?!(?:this|the\s+same)\s+(?:repo|repository)\b)(?:(?:our|their|its)\s+)?(?:[\x60'"]?[\w/-]+(?:[./][\w/-]+)*[\x60'"]?\s+){1,4}(?:repo|repository)\b`,
        String.raw`^reposit[óo]rio\s+[\x60'"]?[\w./-]+`,
    ].join("|"),
    "i",
);

/** An owner/name the instructions write that is not a linked repository
 *  (a URL to it too): it can be the other side of a choice ("in acme/rules
 *  or other/policies"). A deeper path (an issue link) is not one. */
const OWNER_NAME =
    /(?:^|[^\w./:-])((?:https?:\/\/[\w.-]+\/)?[\w-][\w.-]*\/[\w.-]*[\w-])(?![\w/-])(?!\.[\w-])/g;

/** The noun a place phrase puts after or before a name ("repository"). */
const REPOSITORY_NOUN =
    /\b(?:repositories|repository|repos|repo|reposit[óo]rios?)\b/g;

/** What joins two repositories into a choice: "a or b", "a, b", "a and/or
 *  b", "a (or b)", "a e b", and with the nouns dropped (REPOSITORY_NOUN),
 *  "the a repository or in the b repository". */
const REPOSITORIES_JOINED =
    /^[\s\x60'"(]*(?:,\s*(?:(?:and\/or|e\/ou|and|or|&|e|ou)\s+)?|(?:and\/or|e\/ou|and|or|&|e|ou)\s+)(?:(?:in|from|on|at|inside|under|no|na|do|da|em)\s+)?(?:(?:the|o|a)\s+)?[\x60'"]?$/;

/** A conjunction that opens a clause with its own place: "and in the",
 *  "or from", "e no". Without the preposition ("a or b") it is a choice. */
const CLAUSE_OPENER =
    /(?:and|or|e|ou|&)\s+(?:in|from|on|at|inside|under|no|na|do|da|em)\s/;

/** What lies between a file and the repository right after it, nouns
 *  dropped: "docs/a.md in the a repository", "docs/a.md (a)", "docs/a.md
 *  from https://github.com/acme/a". */
const FILE_THEN_REPOSITORY =
    /^[\s\x60'"),]*(?:(?:in|from|on|at|inside|under|no|na|do|da|em)\s+)?(?:(?:the|our|o|a)\s+)?[\x60'"(]?(?:https?:\/\/[\w.-]+\/)?$/;

/** A list that goes on to more files: a file after it is the list's, not a
 *  clause of the repository before it. A boundary word anywhere ("a or b,
 *  then read docs/c.md", "and docs/c.md"), an adverb only right before the
 *  file ("also docs/c.md"; "also read docs/c.md" is the clause's own verb). */
const LIST_GOES_ON =
    /(?:^|[\s,(])(?:and|or|e|ou|&|then|plus|depois)(?:$|[\s,)])|(?:^|[\s,(])(?:also|too|as well as|também|tambem)[\s,(\x60'"]*$/;

/** What may lie between a file and a place that belongs to it ("docs/b.md
 *  in the pump-rules repository": the place starts with its preposition). */
const PLACE_RIGHT_AFTER = /^[\s\x60'"),]*$/;

/** What may lie between a file and a mention that belongs to it: "docs/b.md
 *  from irrigation-rules", "docs/b.md (irrigation-rules)". A comma is not
 *  one: "docs/a.md, irrigation-rules" is a list. */
const MENTION_RIGHT_AFTER =
    /^[\s\x60'"),]*(?:(?:in|from|on|at|inside|under)\s+(?:the\s+)?|\(\s*)[\x60'"]?$/;

/** What joins the files of one list ("docs/a.md, docs/b.md and docs/c.md"). */
const LIST_SEPARATOR =
    /^[\s\x60'"),]*(?:,|\b(?:and|or|e|ou)\b|&)?[\s\x60'"(]*$/;

type Span = { at: number; end: number };
type CitedFile = Span & { cited: string };
/** A linked repository named in the text, or (in the choice stage only) an
 *  unlinked owner/name. Ambiguous: named in a choice or by a short name two
 *  linked repositories share, so it places nothing. */
type Mention = Span & { repository: string; ambiguous: boolean };
/** Where a place or an attachment puts a file: the reviewed repository
 *  (`local`), a linked one (`repository`), or nowhere (neither). */
type Placement = { repository?: string; local?: true };
type Place = Placement & { at: number };

/** The text read once: lowercase, its files, where its sentences end. */
type Reading = {
    text: string;
    files: CitedFile[];
    ends: number[];
    sentenceOf: (position: number) => number;
};

/** Index of the first item at or after `position`, by halving: `items` is in
 *  text order. */
const firstFrom = (items: Array<{ at: number }>, position: number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (items[mid].at < position) low = mid + 1;
        else high = mid;
    }
    return low;
};

const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const read = (instructions: string): Reading => {
    const text = instructions.toLowerCase();
    const files = [...instructions.matchAll(MENTIONED_FILE)].map((match) => {
        const at = (match.index ?? 0) + match[0].indexOf(match[1]);
        return { cited: match[1], at, end: at + match[1].length };
    });
    const ends = [...text.matchAll(SENTENCE_END)].map(
        (mark) => (mark.index ?? 0) + mark[0].length,
    );
    // The sentence a position falls in, as an index over `ends`.
    const sentenceOf = (position: number) => {
        let low = 0;
        let high = ends.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (ends[mid] <= position) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    return { text, files, ends, sentenceOf };
};

/**
 * The linked repositories the text names, in text order. A full name may
 * follow a `/` (a URL); a bare name may not: in "other/irrigation-rules" it
 * is another owner's repository, not an alias of the linked
 * `greenhouse/irrigation-rules`. A dot ends a name only at the end of a
 * sentence: "acme/rules.v2" is another repository. A name inside a file's
 * path names nothing ("rules/api.md" is not `acme/rules`). Two linked
 * repositories with the same short name, named by it, are ambiguous.
 */
const findMentions = (
    { text, files }: Reading,
    repositories: string[],
): Mention[] => {
    const everyMention = repositories
        .flatMap((repository) => {
            const full = repository.toLowerCase();
            const name = full.split("/").pop() ?? full;
            return [
                new RegExp(
                    `(^|[^a-z0-9_.-])${escapeRegExp(full)}(?=$|[^a-z0-9_.-]|\\.(?![a-z0-9_-]))`,
                    "g",
                ),
                new RegExp(
                    `(^|[^a-z0-9_./-])${escapeRegExp(name)}(?=$|[^a-z0-9_./-]|\\.(?![a-z0-9_-]))`,
                    "g",
                ),
            ].flatMap((pattern) =>
                [...text.matchAll(pattern)].map((match) => {
                    const at = (match.index ?? 0) + match[1].length;
                    return {
                        repository,
                        at,
                        end: at + match[0].length - match[1].length,
                        ambiguous: false,
                    };
                }),
            );
        })
        .sort((a, b) => a.at - b.at);
    // Files and mentions are both in text order: one cursor.
    let file = 0;
    const mentions = everyMention.filter((mention) => {
        while (file < files.length && files[file].end <= mention.at) file++;
        return !(files[file] && files[file].at <= mention.at);
    });
    for (const [index, mention] of mentions.entries()) {
        const next = mentions[index + 1];
        if (
            next &&
            next.at === mention.at &&
            next.repository !== mention.repository
        ) {
            mention.ambiguous = true;
            next.ambiguous = true;
        }
    }
    return mentions;
};

/**
 * Marks as ambiguous every linked mention joined to another repository into
 * a choice ("irrigation-rules or pump-rules", "in acme/a and acme/b", "in the
 * a repository or the b repository", "in acme/rules or other/policies" with
 * the other side not linked): neither one places a file. Unless the second
 * opens a clause of its own, its preposition repeated, between a file the
 * first one places and a file it places itself: "docs/a.md in the pump-rules
 * repository, and in the irrigation-rules repository read docs/b.md".
 */
const markChoices = (
    { text, files, sentenceOf }: Reading,
    mentions: Mention[],
): void => {
    // The other side a choice can offer: an owner/name that is not linked.
    // Matches, files and mentions are all in text order and neither files
    // nor mentions overlap one another: one cursor over each.
    let overlapping = 0;
    let containing = 0;
    const unlinked = [...text.matchAll(OWNER_NAME)].flatMap((match) => {
        const at = (match.index ?? 0) + match[0].length - match[1].length;
        const end = at + match[1].length;
        if (/^(?:and\/or|e\/ou)$/.test(match[1])) return [];
        while (containing < files.length && files[containing].end <= at) {
            containing++;
        }
        if (files[containing] && files[containing].at <= at) return [];
        while (
            overlapping < mentions.length &&
            mentions[overlapping].end <= at
        ) {
            overlapping++;
        }
        if (mentions[overlapping] && mentions[overlapping].at < end) return [];
        return [
            { repository: `unlinked:${match[1]}`, at, end, ambiguous: false },
        ];
    });
    const candidates = [...mentions, ...unlinked].sort((a, b) => a.at - b.at);
    // Whether each candidate closes a clause with a file right before it, and
    // opens one with a file right after it: one cursor over files each way.
    const closesAFile: boolean[] = [];
    let before = 0;
    for (const [index, mention] of candidates.entries()) {
        while (before < files.length && files[before].end <= mention.at) {
            before++;
        }
        const file = files[before - 1];
        closesAFile[index] =
            !!file &&
            sentenceOf(file.at) === sentenceOf(mention.at) &&
            FILE_THEN_REPOSITORY.test(
                text.slice(file.end, mention.at).replace(REPOSITORY_NOUN, ""),
            );
    }
    const opensAFile: boolean[] = [];
    let after = 0;
    for (const [index, mention] of candidates.entries()) {
        while (after < files.length && files[after].at < mention.end) after++;
        const file = files[after];
        const nextMention = candidates[index + 1];
        opensAFile[index] =
            !!file &&
            sentenceOf(file.at) === sentenceOf(mention.at) &&
            !(nextMention && nextMention.at < file.at) &&
            !LIST_GOES_ON.test(text.slice(mention.end, file.at));
    }
    for (const [index, mention] of candidates.entries()) {
        const next = candidates[index + 1];
        if (!next || next.repository === mention.repository) continue;
        const between = text
            .slice(mention.end, next.at)
            .replace(REPOSITORY_NOUN, "");
        if (!REPOSITORIES_JOINED.test(between)) continue;
        const twoClauses =
            CLAUSE_OPENER.test(between) &&
            closesAFile[index] &&
            opensAFile[index + 1];
        if (twoClauses) continue;
        mention.ambiguous = true;
        next.ambiguous = true;
    }
};

/**
 * The places that name the reviewed repository itself ("in this
 * repository"). Not one a linked name follows ("in the repository
 * irrigation-rules"), and not a comparison that names a repository: "in the
 * same repo as acme/rules" is acme/rules, "as other/policies" or "as the
 * pump-rules repository" (not linked) nowhere. "The same repo as before"
 * names none: still the reviewed one.
 */
const findLocalPlaces = (
    { text, ends, sentenceOf }: Reading,
    mentions: Mention[],
): Array<Place & Span> =>
    [...text.matchAll(LOCAL_PLACE)].flatMap((place): Array<Place & Span> => {
        const at = place.index ?? 0;
        const end = at + place[0].length;
        const named = mentions[firstFrom(mentions, end)];
        if (named && /^[\s\x60'"]*$/.test(text.slice(end, named.at))) return [];
        const compared = COMPARED_TO.exec(text.slice(end));
        if (compared) {
            const after = end + compared[0].length;
            if (
                named &&
                /^(?:https?:\/\/[\w.-]+\/)?$/.test(text.slice(after, named.at))
            ) {
                const repository = named.ambiguous
                    ? undefined
                    : named.repository;
                return [{ at, end, repository }];
            }
            // Read within its own sentence: "as before. Follow every
            // repository rule." names no repository.
            const sentenceEnd = ends[sentenceOf(after)] ?? text.length;
            const naming = NAMES_A_REPOSITORY.exec(
                text.slice(after, sentenceEnd),
            );
            if (naming) {
                // A linked repository inside it ("as our irrigation-rules
                // repository") is the one compared to.
                const inside = mentions[firstFrom(mentions, after)];
                const repository =
                    inside &&
                    inside.at < after + naming[0].length &&
                    !inside.ambiguous
                        ? inside.repository
                        : undefined;
                return [{ at, end, repository }];
            }
        }
        return [{ at, end, local: true }];
    });

/**
 * Every place phrase, with the linked repository it names if any, and the
 * local places. A phrase over a file's own path is the file, not a place
 * ("the rules in docs/rules.md"). One that crosses a sentence end places
 * nothing ("in full. Pump repository notes follow."), unless its own
 * sentence already names an owner/name place ("in acme/rules. Repository
 * notes follow.").
 */
const findPlaces = (reading: Reading, mentions: Mention[]): Place[] => {
    const { text, files, ends, sentenceOf } = reading;
    const localPlaces = findLocalPlaces(reading, mentions);
    // Local places and files are in text order like the place phrases: one
    // cursor over each.
    let local = 0;
    let file = 0;
    const phrases = [...text.matchAll(REPOSITORY_PLACE)].flatMap(
        (place): Place[] => {
            const at = place.index ?? 0;
            let end = at + place[0].length;
            while (file < files.length && files[file].end <= at) file++;
            if (files[file] && files[file].at < end) return [];
            while (local < localPlaces.length && localPlaces[local].end <= at) {
                local++;
            }
            if (localPlaces[local] && localPlaces[local].at < end) return [];
            const sentence = sentenceOf(at);
            if (sentenceOf(end - 1) !== sentence) {
                if (!text.slice(at, ends[sentence]).includes("/")) return [];
                end = ends[sentence];
            }
            const named = mentions[firstFrom(mentions, at)];
            const repository =
                named && named.at < end && !named.ambiguous
                    ? named.repository
                    : undefined;
            return [{ at, repository }];
        },
    );
    return [
        ...localPlaces.map(({ at, repository, local: isLocal }) =>
            isLocal ? { at, local: isLocal } : { at, repository },
        ),
        ...phrases,
    ].sort((a, b) => a.at - b.at);
};

/** Items grouped by the sentence they fall in, built once for every file. */
const bySentence = <T extends { at: number }>(
    items: T[],
    sentenceOf: (position: number) => number,
) => {
    const map = new Map<number, T[]>();
    for (const item of items) {
        const sentence = sentenceOf(item.at);
        const group = map.get(sentence);
        if (group) group.push(item);
        else map.set(sentence, [item]);
    }
    return map;
};

/**
 * What each file is attached to: the place or mention right after it, or,
 * for an item of a list, what the list's last file is attached to
 * ("docs/a.md and docs/b.md in irrigation-rules" places both). Read from
 * the last file back, so a list of any length inherits.
 */
const attachFiles = (
    { text, files, sentenceOf }: Reading,
    placesBySentence: Map<number, Place[]>,
    mentionsBySentence: Map<number, Mention[]>,
) => {
    const rightAfter = <T extends { at: number }>(
        candidates: T[],
        end: number,
        between: RegExp,
    ) =>
        candidates.find(
            (candidate) =>
                candidate.at >= end &&
                between.test(text.slice(end, candidate.at)),
        );
    const attached: Array<Placement | undefined> = [];
    const inherited: boolean[] = [];
    // Places that right follow a file belong to it, not to its sentence.
    const placesOfAFile = new Set<Place>();
    for (let k = files.length - 1; k >= 0; k--) {
        const { at, end } = files[k];
        const sentence = sentenceOf(at);
        const next = files[k + 1];
        const place = rightAfter(
            placesBySentence.get(sentence) ?? [],
            end,
            PLACE_RIGHT_AFTER,
        );
        if (place) placesOfAFile.add(place);
        const mention = rightAfter(
            mentionsBySentence.get(sentence) ?? [],
            end,
            MENTION_RIGHT_AFTER,
        );
        const directly =
            place ?? (mention?.ambiguous ? { repository: undefined } : mention);
        const fromList =
            !directly &&
            next &&
            sentenceOf(next.at) === sentence &&
            LIST_SEPARATOR.test(text.slice(end, next.at))
                ? attached[k + 1]
                : undefined;
        attached[k] = directly ?? fromList;
        inherited[k] = !!fromList;
    }
    return { attached, inherited, placesOfAFile };
};

/** Where a placement puts a file: the reviewed repository (`undefined`), a
 *  linked one, or nowhere it can be followed (`null`). */
const where = (placement: Placement) =>
    placement.local ? undefined : (placement.repository ?? null);

/**
 * Text files the agent's instructions name that it does not follow, as the
 * item each would be: "read stack/rails/rules/performance-queries.mdc in our
 * rules repository" left to the agent's judgment whether it reads the file,
 * and a finding cannot cite a rule from a file the agent does not follow. A
 * followed doc goes into the agent's prompt whole (#2384).
 *
 * A file is placed by the most explicit place the text gives it: a path that
 * starts with a linked repository's full name, then what it is attached to,
 * then a place phrase in its own sentence ("in the pump-rules repository",
 * "in acme/rules", "in this repository"), then a linked repository its
 * sentence names, then the linked repository named last before it, and the
 * reviewed repository when the instructions name none. A file whose own place
 * is not a linked repository, or is a choice, is left out rather than guessed.
 */
export const mentionedFilesNotFollowed = (
    instructions: string,
    repositories: string[],
    knowledge: KnowledgeItem[],
    agentId: string,
): MentionedFile[] => {
    const reading = read(instructions);
    const { files, sentenceOf } = reading;
    const mentions = findMentions(reading, repositories);
    markChoices(reading, mentions);
    const placesBySentence = bySentence(
        findPlaces(reading, mentions),
        sentenceOf,
    );
    const mentionsBySentence = bySentence(mentions, sentenceOf);
    const { attached, inherited, placesOfAFile } = attachFiles(
        reading,
        placesBySentence,
        mentionsBySentence,
    );
    const byFullName = new Map(
        repositories.map((repository) => [
            repository.toLowerCase(),
            repository,
        ]),
    );
    const bareNames = new Set(
        repositories.map(
            (repository) =>
                repository.toLowerCase().split("/").pop() ??
                repository.toLowerCase(),
        ),
    );

    // Where each file was placed. One placed by its own text (a prefix, what
    // it is attached to, its sentence) is "said"; one placed only by an
    // earlier sentence or as the reviewed repository's is a fallback.
    const placed: Array<{
        file: MentionedFile;
        path: string;
        fallback: boolean;
    }> = [];
    const said = new Set<string>();
    for (const [index, { cited, at }] of files.entries()) {
        // A path that starts with a linked repository's full name names it.
        // One that starts with its bare name is ambiguous ("rules/api.md"
        // may be the reviewed repository's own folder): nothing is offered.
        // The longest known prefix: a GitLab subgroup or an Azure project
        // makes a full name of more than two segments.
        const segments = cited.toLowerCase().split("/");
        let owner: string | undefined;
        let prefixLength = 0;
        for (let n = segments.length - 1; n >= 2 && !owner; n--) {
            owner = byFullName.get(segments.slice(0, n).join("/"));
            prefixLength = owner ? n : 0;
        }
        if (!owner && segments.length > 1 && bareNames.has(segments[0])) {
            continue;
        }
        if (NOT_A_RULE_FILE.test(cited.split("/").pop() ?? "")) continue;
        const item = knowledgeItemFromPath(
            owner ? cited.split("/").slice(prefixLength).join("/") : cited,
        );
        if (!item) continue;
        const sentence = sentenceOf(at);
        const placesHere = placesBySentence.get(sentence) ?? [];
        const mentionsHere = mentionsBySentence.get(sentence) ?? [];
        const own = attached[index];
        // `null`: the text places the file where it cannot be followed from
        // (a repository that is not linked, or two candidates): no offer.
        let repository: string | null | undefined;
        let fallback = false;
        if (owner) {
            repository = owner;
        } else if (own) {
            // What the file is attached to says where it lives: there, or
            // nowhere when it names no linked repository. A list item whose
            // sentence names another place of its own ("In the pump-rules
            // repository, see docs/a.md and docs/b.md in irrigation-rules")
            // has two: nothing is offered rather than a guess.
            const twoPlaces =
                inherited[index] &&
                placesHere.some(
                    (place) =>
                        !placesOfAFile.has(place) &&
                        where(place) !== where(own),
                );
            repository = twoPlaces ? null : where(own);
        } else if (placesHere.length) {
            // The sentence says where its files live: the last place before
            // the file ("In the pump-rules repository, read docs/a.md"), else
            // the first after it; there, or nowhere.
            const nearest =
                placesHere.filter((place) => place.at < at).pop() ??
                placesHere[0];
            repository = where(nearest);
        } else if (mentionsHere.length) {
            // "read x.mdc, kept in irrigation-rules". A sentence naming two
            // linked repositories with neither attached to the file, or a
            // choice ("In pump-rules or acme/style, read docs/a.md"), does
            // not say which one holds it: nothing is offered.
            const named = new Set(mentionsHere.map((m) => m.repository));
            repository =
                named.size > 1 || mentionsHere.some((m) => m.ambiguous)
                    ? null
                    : mentionsHere[0].repository;
        } else {
            // Its own text says nothing: the repository named last before
            // it, else the reviewed repository.
            const before = mentions[firstFrom(mentions, at) - 1];
            repository = before?.ambiguous ? null : before?.repository;
            fallback = true;
        }
        const path = item.path.toLowerCase();
        if (!fallback) said.add(path);
        if (repository === null) continue;
        placed.push({
            file: { ...item, ...(repository && { repository }) },
            path,
            fallback,
        });
    }

    // A file its own text places somewhere, even a repository that is not
    // linked ("Read docs/a.md. docs/a.md lives in the pump-rules
    // repository"), is not offered again where only a fallback places it.
    const followed = new Set(
        knowledge
            .filter((entry) => isLinked(entry, { agentId }))
            .map(knowledgeKey),
    );
    const offered = new Set<string>();
    const found: MentionedFile[] = [];
    for (const { file, path, fallback } of placed) {
        if (fallback && said.has(path)) continue;
        const key = knowledgeKey(file);
        if (followed.has(key) || offered.has(key)) continue;
        offered.add(key);
        found.push(file);
    }
    return found;
};
