export type RuntimeDependency =
  | {
      kind: "huggingface_dataset";
      name: string;
      config?: string | null;
      split?: string | null;
      file: string;
      line: number;
    };

function lineNumberAtOffset(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length;
}

function trimTrailingSeparators(value: string) {
  return value.replace(/[\\/]+$/, "") || value;
}

function joinPosixPath(base: string, leaf: string) {
  return `${trimTrailingSeparators(base)}/${leaf}`;
}

function relativeToRoot(rootDir: string, filePath: string) {
  const normalizedRoot = trimTrailingSeparators(rootDir).replace(/\\/g, "/");
  const normalizedFile = filePath.replace(/\\/g, "/");
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;
}

async function collectImportedWorkspaceFiles(workDir: string, entryScript: string): Promise<string[]> {
  const fs = await import("fs/promises");
  const rootDir = trimTrailingSeparators(workDir);
  const queue = [joinPosixPath(rootDir, entryScript.replace(/^[/\\]+/, ""))];
  const seen = new Set<string>();
  const ordered: string[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    ordered.push(next);

    let code = "";
    try {
      const handle = await fs.open(next, "r");
      try {
        code = await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }

    const importPattern = /^\s*(?:from\s+([A-Za-z_]\w*)\s+import|import\s+([A-Za-z_]\w*))/gm;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(code)) !== null) {
      const moduleName = match[1] || match[2];
      if (!moduleName) continue;
      const localModulePath = joinPosixPath(rootDir, `${moduleName}.py`);
      if (seen.has(localModulePath)) continue;
      queue.push(localModulePath);
    }
  }

  return ordered;
}

function parseDatasetCalls(filePath: string, code: string): RuntimeDependency[] {
  const deps: RuntimeDependency[] = [];
  const callPattern = /load_dataset\(([\s\S]{0,600}?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(code)) !== null) {
    const args = match[1];
    const nameMatch = args.match(/^\s*["']([^"']+)["']/);
    if (!nameMatch) continue;

    const dep: RuntimeDependency = {
      kind: "huggingface_dataset",
      name: nameMatch[1],
      file: filePath,
      line: lineNumberAtOffset(code, match.index),
    };

    const afterName = args.slice(nameMatch[0].length);
    const configMatch = afterName.match(/^\s*,\s*["']([^"']+)["']/);
    if (configMatch) {
      dep.config = configMatch[1];
    }

    const splitMatch = args.match(/split\s*=\s*["']([^"']+)["']/);
    if (splitMatch) {
      dep.split = splitMatch[1];
    }

    deps.push(dep);
  }
  return deps;
}

function dedupeDependencies(deps: RuntimeDependency[]): RuntimeDependency[] {
  const seen = new Set<string>();
  const result: RuntimeDependency[] = [];
  for (const dep of deps) {
    const key = JSON.stringify([dep.kind, dep.name, dep.config || "", dep.split || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dep);
  }
  return result;
}

export async function extractRuntimeDependencies(workDir: string, entryScript: string): Promise<RuntimeDependency[]> {
  const fs = await import("fs/promises");
  const files = await collectImportedWorkspaceFiles(workDir, entryScript);
  const deps: RuntimeDependency[] = [];
  const rootDir = trimTrailingSeparators(workDir);

  for (const filePath of files) {
    let code = "";
    try {
      const handle = await fs.open(filePath, "r");
      try {
        code = await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    deps.push(...parseDatasetCalls(relativeToRoot(rootDir, filePath), code));
  }

  return dedupeDependencies(deps);
}
