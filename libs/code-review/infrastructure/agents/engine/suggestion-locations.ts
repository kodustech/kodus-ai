import {
    OTHER_LOCATIONS_HEADING,
    otherLocationsToRender,
} from './kody-rules-merge';
import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';

/**
 * One place a suggestion points at. A comment may stand for the same problem
 * in several places: the dedup keeps one finding and lists the others under
 * "Also found in", and the developer has to fix every one of them.
 */
export interface SuggestionLocation {
    /** `file:start-end`, as the list under "Also found in" writes it. */
    key: string;
    file: string;
    start?: number;
    end?: number;
    /** The location the comment itself is on. */
    own: boolean;
}

type Locatable = Pick<
    Partial<CodeSuggestion>,
    | 'relevantFile'
    | 'relevantLinesStart'
    | 'relevantLinesEnd'
    | 'suggestionContent'
    | 'alsoFoundIn'
    | 'kodyRuleOtherLocations'
>;

const keyOf = (file: string, start?: number, end?: number) =>
    `${file}:${start ?? '?'}-${end ?? '?'}`;

const lineOf = (value: string | undefined) => {
    const line = Number(value);
    return Number.isInteger(line) && line > 0 ? line : undefined;
};

function parseLocation(location: string): SuggestionLocation | null {
    const match = /^(.+):([^:-]*)-([^:-]*)$/.exec(location.trim());
    if (!match?.[1]) return null;
    const [, file, start, end] = match;
    return {
        key: location.trim(),
        file,
        start: lineOf(start),
        end: lineOf(end),
        own: false,
    };
}

/** The list the comment shows, for a suggestion saved without its own. */
function locationsInComment(content: string | undefined): string[] {
    const section = content?.split(OTHER_LOCATIONS_HEADING)[1];
    if (!section) return [];
    return [...section.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
}

/** Every location of a suggestion, its own first. One entry when it is not a group. */
export function suggestionLocations(
    suggestion: Locatable,
): SuggestionLocation[] {
    const own: SuggestionLocation = {
        key: keyOf(
            suggestion.relevantFile,
            suggestion.relevantLinesStart,
            suggestion.relevantLinesEnd,
        ),
        file: suggestion.relevantFile,
        start: suggestion.relevantLinesStart,
        end: suggestion.relevantLinesEnd,
        own: true,
    };
    const listed = otherLocationsToRender(suggestion);
    const others = (
        listed.length
            ? listed
            : locationsInComment(suggestion.suggestionContent)
    )
        .map(parseLocation)
        .filter(
            (location): location is SuggestionLocation =>
                !!location && location.key !== own.key,
        );
    return [own, ...others];
}

/** What the suggestion asked for, without the list of its other locations. */
export function problemWithoutLocations(text: string | undefined): string {
    return (text ?? '').split(OTHER_LOCATIONS_HEADING)[0].trimEnd();
}

/**
 * The status of a group from its locations: implemented once every one of
 * them is fixed, partial while some are, and undecided (null) when none is
 * and a location that had to be read could not be.
 */
export function groupImplementationStatus(input: {
    locations: SuggestionLocation[];
    /** Keys of the locations fixed so far, in this check or an earlier one. */
    fixed: ReadonlySet<string>;
    /** A location read in this check came back partially fixed. */
    partial: boolean;
    /** A location that had to be read in this check could not be decided. */
    undecided: boolean;
}): ImplementationStatus | null {
    const { locations, fixed, partial, undecided } = input;
    if (locations.every((location) => fixed.has(location.key))) {
        return ImplementationStatus.IMPLEMENTED;
    }
    if (fixed.size > 0 || partial) {
        return ImplementationStatus.PARTIALLY_IMPLEMENTED;
    }
    return undecided ? null : ImplementationStatus.NOT_IMPLEMENTED;
}
