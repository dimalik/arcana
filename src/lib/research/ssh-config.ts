/**
 * Parse ~/.ssh/config to extract host entries.
 * SSH config format: "Host <alias>" followed by indented key-value pairs.
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface SSHConfigEntry {
  host: string; // the Host alias
  hostName: string | null; // HostName (actual hostname/IP)
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyCommand: string | null;
  forwardAgent: boolean;
}

export async function parseSSHConfig(): Promise<SSHConfigEntry[]> {
  const configPath = join(homedir(), ".ssh", "config");

  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return [];
  }

  const entries: SSHConfigEntry[] = [];
  let current: SSHConfigEntry | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Handle commented-out directives like "#  HostName foo"
    // (skip them)

    if (line.toLowerCase().startsWith("host ") && !line.toLowerCase().startsWith("hostname")) {
      // Save previous entry
      if (current) entries.push(current);

      const alias = line.slice(5).trim();
      // Skip wildcard patterns like "*.example.com" or "*"
      if (alias.includes("*")) {
        current = null;
        continue;
      }

      current = {
        host: alias,
        hostName: null,
        user: null,
        port: null,
        identityFile: null,
        proxyCommand: null,
        forwardAgent: false,
      };
      continue;
    }

    if (!current) continue;

    // Parse key-value (supports both "Key Value" and "Key=Value")
    const eqIdx = line.indexOf("=");
    const spaceIdx = line.indexOf(" ");
    let key: string;
    let value: string;

    if (eqIdx > 0 && (spaceIdx < 0 || eqIdx < spaceIdx)) {
      key = line.slice(0, eqIdx).trim().toLowerCase();
      value = line.slice(eqIdx + 1).trim();
    } else if (spaceIdx > 0) {
      key = line.slice(0, spaceIdx).trim().toLowerCase();
      value = line.slice(spaceIdx + 1).trim();
    } else {
      continue;
    }

    switch (key) {
      case "hostname":
        current.hostName = value;
        break;
      case "user":
        current.user = value;
        break;
      case "port":
        current.port = parseInt(value, 10) || null;
        break;
      case "identityfile":
        current.identityFile = value.replace(/^~/, homedir());
        break;
      case "proxycommand":
        current.proxyCommand = value;
        break;
      case "forwardagent":
        current.forwardAgent = value.toLowerCase() === "yes";
        break;
    }
  }

  // Don't forget the last entry
  if (current) entries.push(current);

  return entries;
}
