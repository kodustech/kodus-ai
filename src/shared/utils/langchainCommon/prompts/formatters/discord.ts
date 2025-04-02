export const prompt_discord_format = (payload: {
    inputMessage: string;
    conversationStyle: string;
    language: string;
}) => {
    return `# Message Formatting Prompt

## Objective
Receive an input with incorrectly formatted text and format it according to Discord's Markdown formatting rules, while removing the unsupported tag and adopting conversation style.

## Input Text to Format
[${payload.inputMessage}]

## Conversation Style
${payload.conversationStyle}

## Instructions
1. **Input:** Text with potential incorrect or unsupported formatting.
2. **Output:** Text formatted according to Discord's supported Markdown rules, with unsupported elements removed or converted.
3. **Content Preservation:** Maintain the original content's meaning and structure as closely as possible while reformatting. Change only to attend "Conversation Style".
4. **Language:** Always return the text in ${payload.language}.
5. **No Extra Tags or Formatting:** Return only the text with specified formatting styles. Do not add additional tags or enclose in code blocks.
6. **Strict Adherence:** Follow the formatting rules strictly. Do not apply any formatting not explicitly mentioned in the rules below.
7. Do not mention anything related to the format

## Pre-processing
1. Identify all HTML, BBCode, or other markup tags in the text.
2. Check each tag against the list of Discord-supported formatting rules.
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
2. For unsupported formatting tags (e.g., color, font size), consider using Discord-supported formats to convey similar emphasis (e.g., bold or italic).
3. For structured content, use combinations of lists, paragraphs, and basic formatting to maintain the information structure as faithfully as possible.
4. For files, send them using link tags. If there is files always send it.

## Fallback Strategy
1. For complex structures without direct Discord formatting equivalents:
   - Use bullet or numbered lists to represent hierarchies.
   - Utilize spacing and formatting (e.g., bold for titles) to indicate different information levels.
   - If necessary, add brief textual descriptions to explain the original structure.

## Formatting Rules
1. **Italics:** Use *asterisks* or _underscores_.
2. **Underline:** Use two underscores __before and after__ the text.
3. **Bold:** Use **two asterisks**.
4. **Bold and Italics:** Use ***three asterisks*** or ___three underscores___.
5. **Underline and Bold:** Use __**two underscores and two asterisks**__.
6. **Underline, Bold, and Italics:** Use __***three underscores and three asterisks***__.
7. **Strikethrough:** Use ~~two tildes~~.
8. **Quote:** Use > before the text.
9. **Code:** For inline code, use \`backticks\`.
10. **Code Block:** For multi-line code blocks, use \`\`\`three backticks\`\`\`, instead of \`\`\`typescript or similar.
11. **Headers:** Use #, ##, or ### for headers (do not use more than three levels).
12. **Subtext:** Use -# before the text.
13. **Masked Links:** Use [display text](URL).
14. **Lists:** Use - or * for bulleted lists.
15. **Indented List:** Add a space before - or * for indentation.
16. **Block Quotes:** Use > for single line or >>> for multiple lines.
17. **Spoilers:** Use ||double vertical bars|| around the text.
18. **No Tables:** Do not use markdown tables. Convert tabular content to lists or formatted paragraphs.

## Final Verification
1. Confirm all unsupported tags have been removed.
2. Verify that only Discord-allowed formatting is used.
3. Ensure the original content's structure and meaning are preserved as much as possible.
4. If important information was lost due to complex formatting removal, add an explanatory note at the beginning or end of the text.

**Reminder:** Apply only the formatting described above. The output should contain only the formatted text, without additional tags or elements.`;
};
