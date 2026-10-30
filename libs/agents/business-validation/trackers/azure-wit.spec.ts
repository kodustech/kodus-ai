import { buildReadArgs } from './custom-mcp.tracker';
import { describeTask, linksIn } from './task-payload';
import { wholeItem } from './whole-item';

/**
 * The official Azure DevOps MCP, as it answers today: one `wit_work_item`
 * tool whose `action` is free text listed only in its description, an `id`
 * with no declared type, and an item whose `url` is the API's.
 */
const witWorkItem = {
    name: 'wit_work_item',
    description:
        "Read operations on Azure DevOps work items. Use 'action' to choose: 'get' (single work item by organization-unique ID; project is optional), 'get_batch' (multiple work items by IDs), 'list_comments' (comments on a work item).",
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description:
                    "The operation to perform. One of: 'get', 'get_batch', 'list_comments'.",
            },
            project: { type: ['string', 'null'], default: null },
            id: {
                description: "For 'get': The ID of the work item to retrieve.",
                default: null,
            },
            expand: {
                description:
                    "For 'get', 'get_batch', 'list_revisions': Expand options ('All', 'Fields', 'Links', 'None', 'Relations'). For 'get' and 'get_batch', cannot be used with fields.",
                default: null,
            },
        },
        required: ['action'],
    },
} as any;

describe('the Azure DevOps work item reader', () => {
    it('reads with the get action named in the description, and a numeric id', () => {
        expect(
            buildReadArgs(witWorkItem, {
                kind: 'work_item',
                id: '9',
                raw: 'AB#9',
                source: 'title',
                intent: 'closes',
            }),
        ).toEqual({ id: 9, action: 'get' });
    });

    it('never picks an action the description does not name as a read', () => {
        const writeOnly = {
            ...witWorkItem,
            description: "Use 'action' to choose: 'create', 'update'.",
            inputSchema: {
                ...witWorkItem.inputSchema,
                properties: {
                    ...witWorkItem.inputSchema.properties,
                    action: {
                        type: 'string',
                        description: "One of: 'create', 'update'.",
                    },
                },
            },
        };
        expect(
            buildReadArgs(writeOnly, {
                kind: 'work_item',
                id: '9',
                raw: 'AB#9',
                source: 'title',
                intent: 'closes',
            }),
        ).toBeUndefined();
    });

    it('links the work item page, not its API url', () => {
        expect(
            describeTask({
                id: 9,
                url: 'https://dev.azure.com/acme/123/_apis/wit/workItems/9',
                fields: { 'System.Title': 'Bulk actions' },
                _links: {
                    html: {
                        href: 'https://dev.azure.com/acme/123/_workitems/edit/9',
                    },
                },
            })?.url,
        ).toBe('https://dev.azure.com/acme/123/_workitems/edit/9');
    });

    it("names the parent a work item's fields carry", () => {
        expect(
            linksIn({
                id: 10,
                fields: { 'System.Title': 'Bulk archive', 'System.Parent': 9 },
            }),
        ).toEqual({ parentId: '9' });
    });

    it('asks for the whole work item, relations included', () => {
        expect(wholeItem(witWorkItem, { action: 'get', id: 10 })).toEqual({
            action: 'get',
            id: 10,
            expand: 'All',
        });
    });

    it('links the page its MCP server names under links.links.html', () => {
        expect(
            describeTask({
                id: 10,
                url: 'https://dev.azure.com/acme/123/_apis/wit/workItems/10',
                fields: { 'System.Title': 'Bulk archive' },
                links: {
                    links: {
                        html: {
                            href: 'https://dev.azure.com/acme/123/_workitems/edit/10',
                        },
                    },
                },
            })?.url,
        ).toBe('https://dev.azure.com/acme/123/_workitems/edit/10');
    });
});
