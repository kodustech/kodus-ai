import { sanitizeString } from '../helpers';

export type NodeType =
    | 'heading'
    | 'paragraph'
    | 'bulletList'
    | 'orderedList'
    | 'listItem'
    | 'expand'
    | 'codeBlock'
    | 'mediaSingle'
    | 'table'
    | 'panel'
    | 'blockquote'
    | 'rule'
    | 'text'
    | 'status'
    | 'date'
    | 'mention';

export type ContentNode = {
    type: NodeType;
    content?: ContentNode[];
    text?: string;
    attrs?: any;
    marks?: any[];
};

const convertToMarkdown = (nodes: ContentNode[]): string => {
    try {
        if (nodes && nodes.length > 0) {
            const content = nodes
                .map((node) => {
                    const result = processNode(node, 0);

                    return sanitizeString(result);
                })
                .join('\n\n')
                .trim();

            return content;
        }

        return '';
    } catch (error) {
        console.log('convertToMarkdown', error);
    }
};

const processNode = (node: ContentNode, depth: number): string => {
    switch (node.type) {
        case 'heading':
            return processHeading(node, depth);
        case 'paragraph':
            return processParagraph(node, depth);
        case 'bulletList':
            return processList(node, depth, '-');
        case 'orderedList':
            return processList(node, depth, '1.');
        case 'listItem':
            return processListItem(node, depth);
        case 'text':
            return node.text || '';
        case 'codeBlock':
            return `\`\`\`${processContents(node.content, depth)}\`\`\``;
        case 'mention':
            return `${node.attrs?.text?.trim()}`;
        case 'blockquote':
            return processBlockquote(node, depth);
        case 'table':
            return processTable(node);
        case 'panel':
            return processPanel(node, depth);
        case 'date':
            return processDate(node);
        case 'status':
            return processStatus(node);
        case 'rule':
            return processRule();
        case 'expand':
            return processExpand(node, depth);
        default:
            return '';
    }
};

const processHeading = (node: ContentNode, depth: number): string => {
    const level = node.attrs?.level || 1;
    const heading = `${'#'.repeat(level)} ${processContents(
        node.content,
        depth,
    )}`;

    return heading;
};

const processParagraph = (node: ContentNode, depth: number): string => {
    const paragraph = processContents(node.content, depth);

    return paragraph;
};

const processList = (
    node: ContentNode,
    depth: number,
    bulletSymbol: string,
): string => {
    const list =
        node.content
            ?.map((item, index) => {
                const bullet =
                    bulletSymbol === '1.'
                        ? `${index + 1}. `
                        : `${bulletSymbol} `;
                return `${'  '.repeat(depth)}${bullet}${processNode(
                    item,
                    depth + 1,
                )}`;
            })
            .join('\n') || '';

    return list;
};

const processListItem = (node: ContentNode, depth: number): string => {
    const itemProcessed = processContents(node.content, depth);

    return itemProcessed;
};

const processContents = (
    contents: ContentNode[] | undefined,
    depth: number,
): string => {
    const content =
        contents
            ?.map((content) => processNode(content, depth))
            .join(' ')
            .trim() || '';

    return content;
};

const processTable = (node: ContentNode): string => {
    const rows =
        node.content?.map((row) => processTableRow(row)).join('\n') || '';
    return `| ${rows} |`;
};

const processTableRow = (rowNode: ContentNode): string => {
    return (
        rowNode.content?.map((cell) => processTableCell(cell)).join(' | ') || ''
    );
};

const processTableCell = (cellNode: ContentNode): string => {
    return processContents(cellNode.content, 0);
};

const processBlockquote = (node: ContentNode, depth: number): string => {
    const content = processContents(node.content, depth + 1);
    // Adds '>' to each line to create a blockquote
    const blockquoteLines = content
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n');
    return blockquoteLines;
};

const processPanel = (node: ContentNode, depth: number): string => {
    const content = processContents(node.content, depth);
    const panelType = node.attrs?.panelType || 'info';

    let panelMarkdown = '';

    switch (panelType) {
        case 'info':
            panelMarkdown = `> *Info:* ${content}`;
            break;
        case 'error':
            panelMarkdown = `> **Error:** ${content}`;
            break;
        case 'warning':
            panelMarkdown = `> **Warning:** ${content}`;
            break;
        case 'success':
            panelMarkdown = `> **Success:** ${content}`;
            break;
        default:
            panelMarkdown = `> ${content}`;
            break;
    }

    return panelMarkdown;
};

const processDate = (node: ContentNode): string => {
    const timestamp = node.attrs?.timestamp;
    const date = new Date(parseInt(timestamp)).toLocaleDateString();
    return date;
};

const processStatus = (node: ContentNode): string => {
    const statusText = node.attrs?.text || '';
    return `**${statusText}**`;
};

const processExpand = (node: ContentNode, depth: number): string => {
    const title = node.attrs?.title || 'Detalhes';
    const content = processContents(node.content, depth);
    return `> **${title}:**\n> ${content.replace(/\n/g, '\n> ')}`;
};

const processRule = (): string => {
    return '----------------------'; // A horizontal line in Markdown
};

export { convertToMarkdown };
