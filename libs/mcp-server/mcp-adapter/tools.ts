import { safeJsonSchemaToZod } from './json-schema-to-zod';
import { EngineTool, MCPToolRawWithServer } from './types';

/**
 * Validate MCP tool schema
 */
export function validateMCPSchema(schema: unknown): boolean {
    if (!schema || typeof schema !== 'object') {
        return false;
    }

    const s = schema as Record<string, unknown>;

    // Must have type or properties
    if (!s.type && !s.properties) {
        return false;
    }

    // If has type, must be valid
    if (s.type && typeof s.type !== 'string') {
        return false;
    }

    // If has properties, must be object
    if (s.properties && typeof s.properties !== 'object') {
        return false;
    }

    return true;
}

/**
 * Convert MCP tool to Kodus Flow engine tool with validation
 */
export function mcpToolToEngineTool(mcpTool: MCPToolRawWithServer): EngineTool {
    if (!mcpTool || typeof mcpTool !== 'object') {
        throw new Error('Invalid MCP tool structure');
    }

    if (!mcpTool.name || typeof mcpTool.name !== 'string') {
        throw new Error('Invalid MCP tool name');
    }

    // serverName is now optional since we removed server prefix from tool names
    if (mcpTool.serverName && typeof mcpTool.serverName !== 'string') {
        throw new Error('Invalid MCP server name');
    }

    if (!validateMCPSchema(mcpTool.inputSchema)) {
        mcpTool.inputSchema = { type: 'object', properties: {} };
    }

    if (mcpTool.outputSchema && !validateMCPSchema(mcpTool.outputSchema)) {
        mcpTool.outputSchema = undefined;
    }

    const zodSchema = safeJsonSchemaToZod(mcpTool.inputSchema);
    const outputZodSchema = mcpTool.outputSchema
        ? safeJsonSchemaToZod(mcpTool.outputSchema)
        : undefined;

    // Use apenas o nome da tool, sem prefixo do servidor
    const toolName = mcpTool.name;

    if (!toolName || toolName.includes('..')) {
        throw new Error(`Invalid tool name: ${toolName}`);
    }

    const enhancedJsonSchema = enhanceMCPSchema(mcpTool.inputSchema);
    const enhancedOutputJsonSchema = enhanceMCPSchema(mcpTool.outputSchema);

    return {
        name: toolName,
        description:
            mcpTool?.description ||
            mcpTool?.title ||
            `MCP Tool: ${mcpTool.name}`,
        inputZodSchema: zodSchema,
        inputSchema: enhancedJsonSchema,
        outputZodSchema: outputZodSchema,
        outputSchema: enhancedOutputJsonSchema,
        annotations: mcpTool.annotations,
        title: mcpTool.title,
        execute: async (_args: unknown, _ctx: unknown) => {
            throw new Error(
                'Tool execute function not connected to MCP client',
            );
        },
    };
}

function enhanceMCPSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }

    const enhancedSchema = { ...schema } as Record<string, unknown>;

    if (schema && typeof schema === 'object' && 'annotations' in schema) {
        enhancedSchema.annotations = (
            schema as Record<string, unknown>
        ).annotations;
    }

    if (
        enhancedSchema.properties &&
        typeof enhancedSchema.properties === 'object'
    ) {
        const properties = enhancedSchema.properties as Record<string, unknown>;

        if (
            !enhancedSchema.required ||
            !Array.isArray(enhancedSchema.required)
        ) {
            const inferredRequired: string[] = [];

            for (const [key, prop] of Object.entries(properties)) {
                const propObj = prop as Record<string, unknown>;

                if (propObj.required === true) {
                    inferredRequired.push(key);
                }
            }

            if (inferredRequired.length > 0) {
                enhancedSchema.required = inferredRequired;
            }
        }

        for (const [key, prop] of Object.entries(properties)) {
            const propObj = prop as Record<string, unknown>;
            const enhancedProp = { ...propObj };

            if (propObj.format && typeof propObj.format === 'string') {
                enhancedProp.format = propObj.format;
            }

            if (propObj.enum && Array.isArray(propObj.enum)) {
                enhancedProp.enum = propObj.enum;
            }

            if (
                propObj.description &&
                typeof propObj.description === 'string'
            ) {
                enhancedProp.description = propObj.description;
            }

            if (propObj.type === 'object' && propObj.properties) {
                enhancedProp.properties = enhanceMCPSchema(propObj.properties);
            }

            if (propObj.type === 'array' && propObj.items) {
                enhancedProp.items = enhanceMCPSchema(propObj.items);
            }

            properties[key] = enhancedProp;
        }
    }

    return enhancedSchema;
}

/**
 * Convert multiple MCP tools to engine tools with validation
 */
export function mcpToolsToEngineTools(
    mcpTools: MCPToolRawWithServer[],
): EngineTool[] {
    const validTools: EngineTool[] = [];
    const invalidTools: string[] = [];
    const toolNameCounts = new Map<string, string[]>();

    // Check for name conflicts
    for (const mcpTool of mcpTools) {
        const existing = toolNameCounts.get(mcpTool.name) || [];
        if (mcpTool.serverName) {
            existing.push(mcpTool.serverName);
        }
        toolNameCounts.set(mcpTool.name, existing);
    }

    // Handle conflicts
    for (const [toolName, servers] of toolNameCounts) {
        if (servers.length > 1) {
            throw new Error(
                `Tool name conflict detected: "${toolName}" exists in multiple servers: ${servers.join(', ')}. Please rename tools to ensure uniqueness.`,
            );
        }
    }

    for (const mcpTool of mcpTools) {
        try {
            const engineTool = mcpToolToEngineTool(mcpTool);
            validTools.push(engineTool);
        } catch {
            invalidTools.push(mcpTool.name);
        }
    }

    return validTools;
}

/**
 * Parse tool name to extract server name and tool name
 * Since we now use only tool names without server prefix,
 * we need to find the tool in the registry to get the server name
 */
export function parseToolName(fullName: string): {
    serverName?: string;
    toolName: string;
} {
    if (!fullName || typeof fullName !== 'string') {
        throw new Error('Invalid tool name');
    }

    // Since we removed server prefix, just return the tool name
    // The server name will be resolved during execution
    return { toolName: fullName };
}
