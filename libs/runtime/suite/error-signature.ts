// `errorSignature` (docs/runtime/e2e-suites.md section 7): the first error line
// with what changes between two runs of the same failure replaced, cut at 200
// characters. It decides "the same failure on both sides" in the classifier.
// Never read by a model.

export const ERROR_SIGNATURE_MAX = 200;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// A long hex run that holds a digit: a hash or a build id, never a word.
const HASH = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi;
// A selector token that holds a digit (a generated id or class): #radix-:r1a:-trigger, .css-1x2y3z.
const GENERATED_SELECTOR = /[#.][A-Za-z_][\w:-]*\d[\w:-]*/g;
const NUMBER = /\d+(?:\.\d+)?/g;

export function errorSignature(error: string | undefined): string {
    const line = (error ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) return '';
    return line
        .replace(UUID, '<id>')
        .replace(HASH, '<hash>')
        .replace(GENERATED_SELECTOR, '<sel>')
        .replace(NUMBER, '<n>')
        .replace(/\s+/g, ' ')
        .slice(0, ERROR_SIGNATURE_MAX);
}
