/**
 * Config module exports
 */

export { loadConfig, CONFIG_FILE_NAMES } from "./loader.js";
export { routerMcpConfigSchema, serverConfigSchema } from "./schema.js";
export type {
  RouterMcpConfig,
  ServerConfig,
  FilterConfig,
} from "./types.js";
