import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionMeta } from "./types.js";

export async function executeHttpRequest(
  execution: ToolExecutionMeta,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  let url = `${execution.baseUrl}${execution.pathTemplate}`;

  for (const param of execution.parameters.filter((p) => p.in === "path")) {
    const value = args[param.name];
    if (value === undefined && param.required) {
      return {
        content: [{ type: "text", text: `Missing required path parameter: ${param.name}` }],
        isError: true,
      };
    }
    url = url.replace(`{${param.name}}`, encodeURIComponent(String(value)));
  }

  const queryParams: string[] = [];
  for (const param of execution.parameters.filter((p) => p.in === "query")) {
    const value = args[param.name];
    if (value !== undefined) {
      queryParams.push(`${param.name}=${encodeURIComponent(String(value))}`);
    }
  }
  if (queryParams.length > 0) {
    url += `?${queryParams.join("&")}`;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  for (const param of execution.parameters.filter((p) => p.in === "header")) {
    const value = args[param.name];
    if (value !== undefined) {
      headers[param.name] = String(value);
    }
  }

  if (execution.auth) {
    switch (execution.auth.type) {
      case "bearer":
        if (execution.auth.token) {
          headers["Authorization"] = `Bearer ${execution.auth.token}`;
        }
        break;
      case "api-key":
        if (execution.auth.header && execution.auth.value) {
          headers[execution.auth.header] = execution.auth.value;
        }
        break;
      case "basic":
        if (execution.auth.username && execution.auth.password) {
          const credentials = Buffer.from(
            `${execution.auth.username}:${execution.auth.password}`
          ).toString("base64");
          headers["Authorization"] = `Basic ${credentials}`;
        }
        break;
    }
  }

  let body: string | undefined;
  if (args.requestBody !== undefined && execution.requestBodyContentType) {
    headers["Content-Type"] = execution.requestBodyContentType;
    body = JSON.stringify(args.requestBody);
  }

  try {
    const response = await fetch(url, {
      method: execution.method,
      headers,
      body,
    });

    const text = await response.text();

    return {
      content: [
        {
          type: "text",
          text: response.ok ? text : `HTTP ${response.status} ${response.statusText}: ${text}`,
        },
      ],
      isError: !response.ok,
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
