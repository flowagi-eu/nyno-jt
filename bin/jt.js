#!/usr/bin/env node

import { register } from "node:module";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";

const [script, ...args] = process.argv.slice(2);

if (!script) {
  console.error("Usage: jstf <file.ts> [args...]");
  process.exit(1);
}

const scriptPath = resolve(script);
const scriptDir = dirname(scriptPath);

const envFile = resolve(scriptDir, ".env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

process.argv = [
  process.argv[0],
  scriptPath,
  ...args,
];
process.env.JT_SCRIPT_DIR = scriptDir;

register("./loader.js", {
  parentURL: import.meta.url,
});

await import(pathToFileURL(scriptPath).href);

