import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolInfo {
  serverName: string;
  name: string;
  description: string | null;
  inputSchema: unknown;
}

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  enum?: string[];
  default?: unknown;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  description?: string;
}

function jsonSchemaTypeToTs(schema: JsonSchemaProperty): string {
  if (!schema.type) {
    return "any";
  }

  switch (schema.type) {
    case "string":
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum.map((v) => `"${v}"`).join(" | ");
      }
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (schema.items) {
        return `${jsonSchemaTypeToTs(schema.items)}[]`;
      }
      return "any[]";
    case "object":
      if (schema.properties) {
        const props = Object.entries(schema.properties)
          .map(([key, prop]) => {
            const optional = !schema.required?.includes(key) ? "?" : "";
            return `${key}${optional}: ${jsonSchemaTypeToTs(prop)}`;
          })
          .join("; ");
        return `{ ${props} }`;
      }
      return "Record<string, any>";
    case "null":
      return "null";
    default:
      return "any";
  }
}

function generateInlineArgsType(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "Record<string, any>";
  }

  const jsonSchema = schema as JsonSchema;

  if (jsonSchema.type !== "object" || !jsonSchema.properties) {
    return "Record<string, any>";
  }

  const props = Object.entries(jsonSchema.properties)
    .map(([key, prop]) => {
      const optional = !jsonSchema.required?.includes(key) ? "?" : "";
      const comment = prop.description ? `/** ${prop.description} */ ` : "";
      return `${comment}${key}${optional}: ${jsonSchemaTypeToTs(prop)}`;
    })
    .join("; ");

  return `{ ${props} }`;
}

function escapeJsDoc(str: string | null | undefined): string {
  if (!str) return "";
  return str.replace(/\*\//g, "* /").replace(/\n/g, " ");
}

function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

function formatPropertyName(name: string): string {
  if (isValidIdentifier(name)) {
    return name;
  }
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function generateTypeScriptDefinitions(tools: ToolInfo[]): string {
  const toolsByServer = new Map<string, ToolInfo[]>();
  for (const tool of tools) {
    const existing = toolsByServer.get(tool.serverName) ?? [];
    existing.push(tool);
    toolsByServer.set(tool.serverName, existing);
  }

  const lines: string[] = [];

  for (const [serverName, serverTools] of toolsByServer) {
    lines.push(`declare const ${serverName}: {`);
    for (const tool of serverTools) {
      const argsType = generateInlineArgsType(tool.inputSchema);
      const desc = escapeJsDoc(tool.description);
      const propName = formatPropertyName(tool.name);
      if (desc) {
        lines.push(`  /** ${desc} */`);
      }
      lines.push(`  ${propName}: (args: ${argsType}) => Promise<any>;`);
    }
    lines.push(`};`);
    lines.push("");
  }

  lines.push("// Built-in functions:");
  lines.push("declare function fetch(url: string, init?: RequestInit): Promise<Response>;");
  lines.push(
    "declare const console: { log: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };",
  );

  return lines.join("\n");
}

export function groupToolsByServer(tools: ToolInfo[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const tool of tools) {
    const existing = result.get(tool.serverName) ?? [];
    existing.push(tool.name);
    result.set(tool.serverName, existing);
  }
  return result;
}

export function toolsToToolInfo(
  toolsMap: Map<string, { tool: Tool; serverName: string }>,
): ToolInfo[] {
  const result: ToolInfo[] = [];
  for (const [, { tool, serverName }] of toolsMap) {
    result.push({
      serverName,
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
    });
  }
  return result;
}
