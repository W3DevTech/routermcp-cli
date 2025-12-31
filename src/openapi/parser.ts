import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

export async function parseOpenApiSpec(
  source: string | Record<string, unknown>,
): Promise<OpenAPIV3.Document> {
  let spec: unknown;

  if (typeof source === "object") {
    spec = JSON.parse(JSON.stringify(source));
  } else if (source.startsWith("http://") || source.startsWith("https://")) {
    spec = source;
  } else {
    const absolutePath = resolve(process.cwd(), source);
    const content = await readFile(absolutePath, "utf-8");
    spec =
      source.endsWith(".yaml") || source.endsWith(".yml")
        ? await import("yaml").then((yaml) => yaml.parse(content))
        : JSON.parse(content);
  }

  const dereferenced = await SwaggerParser.dereference(spec as OpenAPIV3.Document);
  return dereferenced as OpenAPIV3.Document;
}

export function extractBaseUrl(spec: OpenAPIV3.Document): string {
  if (spec.servers && spec.servers.length > 0) {
    return spec.servers[0].url;
  }
  return "";
}
