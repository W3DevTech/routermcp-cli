import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenAPIV3 } from "openapi-types";
import type { OpenApiAuthConfig } from "../config/types.js";
import type { OpenApiTool, ParameterLocation, ParameterMeta, ToolExecutionMeta } from "./types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export function convertSpecToTools(
  spec: OpenAPIV3.Document,
  serverName: string,
  baseUrl: string,
  auth?: OpenApiAuthConfig,
): OpenApiTool[] {
  const tools: OpenApiTool[] = [];
  const usedNames = new Set<string>();

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const baseName = operation.operationId || generateOperationId(method, path);
      const prefixedName = `${serverName}_${sanitizeName(baseName)}`;

      let finalName = prefixedName;
      let counter = 1;
      while (usedNames.has(finalName)) {
        finalName = `${prefixedName}_${counter++}`;
      }
      usedNames.add(finalName);

      const description =
        operation.description || operation.summary || `${method.toUpperCase()} ${path}`;

      const { inputSchema, parameters, requestBodyContentType } = buildInputSchema(operation);

      const tool: Tool = {
        name: finalName,
        description,
        inputSchema,
      };

      const execution: ToolExecutionMeta = {
        serverName,
        method: method.toUpperCase() as ToolExecutionMeta["method"],
        pathTemplate: path,
        baseUrl,
        parameters,
        requestBodyContentType,
        auth,
      };

      tools.push({ tool, execution });
    }
  }

  return tools;
}

function generateOperationId(method: string, path: string): string {
  const pathPart = path
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/\//g, "_");

  return `${method}_${pathPart}`;
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function buildInputSchema(operation: OpenAPIV3.OperationObject): {
  inputSchema: Tool["inputSchema"];
  parameters: ParameterMeta[];
  requestBodyContentType?: string;
} {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  const parameters: ParameterMeta[] = [];
  let requestBodyContentType: string | undefined;

  const allParams = (operation.parameters || []) as OpenAPIV3.ParameterObject[];

  for (const param of allParams) {
    if (!param.name || !param.schema) continue;

    const schema = param.schema as OpenAPIV3.SchemaObject;
    properties[param.name] = convertSchema(schema, param.description);

    if (param.required) {
      required.push(param.name);
    }

    parameters.push({
      name: param.name,
      in: param.in as ParameterLocation,
      required: param.required || false,
    });
  }

  if (operation.requestBody) {
    const reqBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
    const jsonContent = reqBody.content?.["application/json"];

    if (jsonContent?.schema) {
      const bodySchema = jsonContent.schema as OpenAPIV3.SchemaObject;
      properties.requestBody = convertSchema(bodySchema, "Request body");
      requestBodyContentType = "application/json";

      if (reqBody.required) {
        required.push("requestBody");
      }
    }
  }

  const inputSchema: Tool["inputSchema"] = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    inputSchema.required = required;
  }

  return { inputSchema, parameters, requestBodyContentType };
}

function convertSchema(
  schema: OpenAPIV3.SchemaObject,
  description?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (schema.type === "integer") {
    result.type = "number";
  } else if (schema.type) {
    result.type = schema.type;
  }

  if (description || schema.description) {
    result.description = description || schema.description;
  }
  if (schema.enum) result.enum = schema.enum;
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.minLength !== undefined) result.minLength = schema.minLength;
  if (schema.maxLength !== undefined) result.maxLength = schema.maxLength;
  if (schema.pattern) result.pattern = schema.pattern;

  if (schema.nullable && typeof result.type === "string") {
    result.type = [result.type, "null"];
  }

  if (schema.properties) {
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      (result.properties as Record<string, unknown>)[key] = convertSchema(
        value as OpenAPIV3.SchemaObject,
      );
    }
  }
  if (schema.required) result.required = schema.required;

  if (schema.type === "array" && "items" in schema && schema.items) {
    result.items = convertSchema(schema.items as OpenAPIV3.SchemaObject);
  }

  return result;
}
