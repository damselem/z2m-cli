/**
 * Configuration management with XDG Base Directory support
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface Config {
  url?: string;
  timeout?: number;
}

export interface ConfigPaths {
  configDir: string;
  configFile: string;
}

/**
 * Get XDG-compliant config paths
 */
export function getConfigPaths(): ConfigPaths {
  const xdgConfigHome = Bun.env.XDG_CONFIG_HOME || join(Bun.env.HOME || '', '.config');
  const configDir = join(xdgConfigHome, 'z2m-cli');
  const configFile = join(configDir, 'config.json');

  return { configDir, configFile };
}

/**
 * Ensure config directory exists
 */
export function ensureConfigDir(): string {
  const { configDir } = getConfigPaths();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

/**
 * Load configuration from file
 */
export function loadConfig(): Config {
  const { configFile } = getConfigPaths();

  let fileConfig: Config = {};

  if (existsSync(configFile)) {
    try {
      const content = readFileSync(configFile, 'utf-8');
      fileConfig = JSON.parse(content);
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  return fileConfig;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: Config): void {
  ensureConfigDir();
  const { configFile } = getConfigPaths();
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Get a specific config value with priority resolution
 * Priority: CLI arg > Environment var > Config file > Default
 */
export function resolveConfig(options: {
  cliUrl?: string;
  cliTimeout?: number;
}): Config {
  const fileConfig = loadConfig();

  return {
    url: options.cliUrl || Bun.env.Z2M_URL || fileConfig.url || 'ws://localhost:8080',
    timeout: options.cliTimeout || (Bun.env.Z2M_TIMEOUT ? parseInt(Bun.env.Z2M_TIMEOUT) : undefined) || fileConfig.timeout || 10000,
  };
}

/**
 * Get config file path for display
 */
export function getConfigFilePath(): string {
  return getConfigPaths().configFile;
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return existsSync(getConfigPaths().configFile);
}
