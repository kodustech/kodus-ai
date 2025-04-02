/**
 * Possible types of relationships between code elements
 */
export type RelationshipType =
    // File Relationships
    | 'importedBy' // Files that import this file
    | 'imports' // Files imported by this file

    // Type Relationships (Class/Interface)
    | 'implementedBy' // Classes that implement this interface
    | 'implements' // Interfaces implemented by this class

    // Function Relationships
    | 'calledBy' // Functions that call this function
    | 'calls' // Functions called by this function

    // Dependency Relationships
    | 'usedBy' // Where this type is used as a parameter/return
    | 'uses' // Types used as parameters/return

    // Injection Relationships
    | 'injectedBy' // Where this service is injected
    | 'injects'; // Services injected into this class

/**
 * Inbound relationships (who uses this element)
 */
export interface InboundRelationships {
    importedBy: string[]; // Files that import this file
    implementedBy: string[]; // Classes that implement this interface
    calledBy: string[]; // Functions that call this function
    usedBy: string[]; // Where this type is used
    injectedBy: string[]; // Where this service is injected
}

export interface FunctionUsage {
    name: string;
    location?: { line: number; column: number };
}

/**
 * Outbound relationships (what this element uses)
 */
export interface OutboundRelationships {
    imports: string[]; // Imported files
    implements: string[]; // Implemented interfaces
    calls: string[]; // Called functions
    uses: string[]; // Used types
    injects: string[]; // Injected services
}

/**
 * All relationships of an element
 */
export interface NodeRelationships {
    inbound: InboundRelationships;
    outbound: OutboundRelationships;
}

/**
 * Specific metadata for each type of node
 */
export interface FileMetadata {
    imports?: string[]; // Imports declared in the file
    exports?: {
        // Elements exported by the file
        name: string;
        type: string;
        decorators?: string[];
    }[];
}

export interface TypeMetadata {
    implements?: string[]; // Implemented interfaces
    decorators?: string[]; // Class/interface decorators
    methods?: {
        // Declared methods
        name: string;
        parameters?: string[];
        returnType?: string;
        decorators?: string[];
    }[];
}

export interface FunctionMetadata {
    parameters?: string[]; // Function parameters
    returnType?: string; // Return type
    decorators?: string[]; // Function decorators
    visibility?: string; // public, private, protected
    async?: boolean; // Whether it is an asynchronous function
}

/**
 * Node representing a code element
 */
export interface CodeNode {
    type: 'file' | 'class' | 'interface' | 'function' | 'method';
    name: string;
    path: string;
    metadata: FileMetadata | TypeMetadata | FunctionMetadata;
    relationships: NodeRelationships;
}

/**
 * Indices for quick relationship lookup
 */
export interface CodeGraphIndices {
    // Basic indices
    byPath: { [path: string]: string[] }; // Elements by path
    byName: { [name: string]: string[] }; // Elements by name
    byType: { [type: string]: string[] }; // Elements by type

    // Relationship indices
    imports: {
        // Import relationships
        [fileId: string]: {
            imports: string[]; // What this file imports
            importedBy: string[]; // Who imports this file
        };
    };
    implementations: {
        // Implementation relationships
        [interfaceId: string]: {
            implementedBy: string[]; // Classes that implement
            extends: string[]; // Interfaces that extend
        };
    };
    calls: {
        // Call relationships
        [functionId: string]: {
            calls: string[]; // Functions this function calls
            calledBy: string[]; // Functions that call this function
        };
    };
    injections: {
        // Injection relationships
        [serviceId: string]: {
            injects: string[]; // Services this service injects
            injectedBy: string[]; // Where this service is injected
        };
    };
}

/**
 * Edge representing a relationship between elements
 */
export interface Edge {
    type: RelationshipType; // Type of the relationship
    source: string; // Source element ID
    target: string; // Target element ID
    metadata?: {
        // Additional metadata
        path?: string; // Path where it occurs
        weight?: number; // Weight/importance
        injectionType?: string; // Type of injection
    };
}

/**
 * Enriched graph representing the entire codebase
 */
export interface EnrichedCodeGraph {
    nodes: {
        [nodeId: string]: CodeNode; // Graph nodes
    };
    edges: {
        [edgeId: string]: Edge; // Graph edges
    };
    indices: CodeGraphIndices; // Lookup indices
}

/**
 * Analysis of a file with its definitions and calls
 */
export interface FileAnalysis {
    defines: string[];
    calls: Call[];
    imports: string[];
    className?: string[];
    usedBy?: {
        files: string[]; // Files that import this file
        functions: string[]; // Functions that use this file
        types: string[]; // Types defined in this file
    };
    dependencies?: {
        direct: string[]; // May include functions and imported files
        transitive: string[]; // To be calculated later (simple example)
    };
}

/**
 * Details of a function call
 */
export interface Call {
    function: string;
    file: string;
    caller?: string;
}

/**
 * Complete details of a defined function
 */
export interface FunctionAnalysis {
    file: string;
    name: string;
    params: string[];
    lines: number;
    returnType: string;
    calls: Call[];
    className?: string;
    startLine: number;
    endLine: number;
    functionHash: string;
    signatureHash: string;
    bodyNode?: any;
    fullText: string;
}

/**
 * Details of a type (interface, type alias, or enum)
 */
export interface TypeAnalysis {
    file: string;
    type: string;
    name: string;
    fields: Record<string, string>;
    implements?: string[];
    implementedBy?: string[];
    extends?: string[];
    extendedBy?: string[];
}

/**
 * Complete code graph
 */
export interface CodeGraph {
    files: Map<string, FileAnalysis>;
    functions: Map<string, FunctionAnalysis>;
    types: Map<string, TypeAnalysis>;
}

// Interface for the cross-relationships section
export interface Relationships {
    functionCalls: { caller: string; callee: string }[];
    imports: { importer: string; imported: string }[];
    typeImplementations: { interface: string; implementor: string }[];
}

export interface ImpactAnalysis {
    direct: string[];
    transitive: string[];
}

/**
 * Location of an element in the code
 */
export interface CodeLocation {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

/**
 * Original metadata of a node
 */
export interface NodeMetadataOriginal {
    visibility?: 'public' | 'private' | 'protected';
    static?: boolean;
    abstract?: boolean;
    async?: boolean;
    parameters?: Parameter[];
    returnType?: string;
    decorators?: string[];
    documentation?: string;
}

/**
 * Parameter of a function
 */
export interface Parameter {
    name: string;
    type: string;
    optional: boolean;
    defaultValue?: string;
}

/**
 * Mapping of relationships
 */
export interface RelationshipMap {
    [sourceId: string]: {
        [targetId: string]: {
            type: string;
            metadata?: RelationshipMetadata;
        };
    };
}

/**
 * Metadata of a relationship
 */
export interface RelationshipMetadata {
    location?: CodeLocation;
    count?: number;
    async?: boolean;
    conditional?: boolean;
}
