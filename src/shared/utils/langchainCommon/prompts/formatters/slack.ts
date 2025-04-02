export const prompt_slack_format = (payload: {
    inputMessage: string;
    conversationStyle: string;
    language: string;
}) => {
    return `
   # Message Formatting Prompt for Slack

## Objective
Receive an input with incorrectly formatted text and format it according to Slack's Markdown formatting rules, while removing the unsupported tag and adopting conversation style.

## Input Text to Format
[${payload.inputMessage}]

## Conversation Style
${payload.conversationStyle}

## Instructions

1. **Input:** Use the text provided in the "Input Text to Format" section above.
2. **Output:** Text formatted according to Slack's supported Markdown rules, with unsupported elements removed or converted.
3. **Content Preservation:** Maintain the original content's meaning and structure as closely as possible while reformatting.
4. **Language:** Always return the text in ${payload.language}.
5. **No Extra Tags or Formatting:** Return only the text with specified formatting styles. Do not add additional tags or enclose in code blocks.
6. **Strict Adherence:** Follow the formatting rules strictly. Do not apply any formatting not explicitly mentioned in the rules below.
7. Do not mention anything related to the format 

## Pre-processing

1. Identify all HTML, BBCode, or other markup tags in the text.
2. Check each tag against the list of Slack-supported formatting rules.
3. Remove unsupported tags, preserving their internal content.
4. Convert structured content (e.g., tables, complex layouts) to simple text format that maintains information structure.

## Commonly Unsupported Tags

- <table>, <tr>, <td>, <th>
- <div>, <span>
- <font>, <color>
- <size>
- <align>
- [table], [tr], [td], [th] (BBCode)
- [div], [align], [center]
- Other proprietary markup system tags

## Content Preservation

1. Retain internal content when removing unsupported tags. Change only to attend "Conversation Style".
2. For unsupported formatting tags (e.g., color, font size, titles), consider using Slack-supported formats to convey similar emphasis (e.g., bold or italic).
3. For structured content, use combinations of lists, paragraphs, and basic formatting to maintain the information structure as faithfully as possible.
4. For files, send them using link tags. If there is files always send it.

## Fallback Strategy

1. For complex structures without direct Slack formatting equivalents:
   - Use bullet or numbered lists to represent hierarchies.
   - Utilize spacing and formatting to indicate different information levels.
   - If necessary, add brief textual descriptions to explain the original structure.

## Formatting Rules

1. Bold: Wrap the text with *asterisks*.
2. Italics: Wrap the text with _underscores_.
3. Strikethrough: Wrap the text with ~tildes~.
4. Code:
   - For inline code, wrap the text with \`backticks\`.
   - For multi-line code blocks, use \`\`\`three backticks\`\`\` before and after the block.
5. Block Quote:** Use > before the text.
6. Lists:
   - For ordered lists, start with a number followed by a period and space.
   - For bulleted lists, start with an asterisk (*) followed by a space.
7. Links:** Surround the URL with angle brackets <https://example.com>.
8. No Headings:** Slack doesn't support Markdown headings in messages. Convert headings to bold text.

## Final Verification

1. Confirm all unsupported tags have been removed.
2. Verify that only Slack-allowed formatting is used.
3. Ensure the original content's structure and meaning are preserved as much as possible.
4. If important information was lost due to formatting limitations, add a brief explanatory note at the end of the text.

**Reminder:** Apply only the formatting described above. The output should contain only the formatted text, without additional tags or elements.`;
};
