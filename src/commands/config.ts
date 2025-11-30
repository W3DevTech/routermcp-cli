import {
  findConfigFile,
  loadConfig,
  getDefaultConfigPath,
} from "../lib/config-loader.ts";
import { runConfigEditor } from "../lib/config-editor.ts";

/**
 * Run the interactive configuration editor
 */
export async function configCommand(): Promise<void> {
  const existingConfigPath = findConfigFile();

  let config = null;
  let configPath: string;

  if (existingConfigPath) {
    try {
      config = loadConfig(existingConfigPath);
      configPath = existingConfigPath;
      console.log(`Found existing configuration: ${existingConfigPath}`);
    } catch (error) {
      console.error(`Error loading existing config: ${error}`);
      console.log("Starting with empty configuration.");
      configPath = getDefaultConfigPath();
    }
  } else {
    console.log("No configuration file found. Creating new configuration.");
    configPath = getDefaultConfigPath();
  }

  await runConfigEditor(config, configPath);
}
