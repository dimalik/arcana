import fs from "fs/promises";
import path from "path";
import ts from "typescript";

export const TRACKED_STATUS_FIELDS = [
  "processingStatus",
  "processingStep",
  "processingStartedAt",
];

const DEFAULT_SCAN_DIRS = ["src", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isIgnoredFile(relativePath) {
  return (
    relativePath.startsWith("src/generated/") ||
    relativePath.includes("/__tests__/") ||
    relativePath.includes("/node_modules/")
  );
}

function getPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function getScriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createSourceFile(sourceText, filePath) {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
}

function getLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function findObjectProperty(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (getPropertyName(property.name) === propertyName) {
      return property;
    }
  }
  return null;
}

function hasDataAncestor(node) {
  let current = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && getPropertyName(current.name) === "data") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isInsideZodObject(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "z" &&
      current.expression.name.text === "object"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isSetLlmContextCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setLlmContext";
}

function isPromptResultCreateCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "create") return false;
  return (
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === "promptResult"
  );
}

export function collectPromptResultWriterTypesFromText(sourceText, filePath = "<inline>") {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (isPromptResultCreateCall(node)) {
      const [arg] = node.arguments;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const dataProp = findObjectProperty(arg, "data");
        if (dataProp && ts.isObjectLiteralExpression(dataProp.initializer)) {
          const promptTypeProp = findObjectProperty(dataProp.initializer, "promptType");
          if (
            promptTypeProp &&
            (ts.isStringLiteral(promptTypeProp.initializer) ||
              ts.isNoSubstitutionTemplateLiteral(promptTypeProp.initializer))
          ) {
            matches.push({
              promptType: promptTypeProp.initializer.text,
              ...getLocation(sourceFile, promptTypeProp.initializer),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export function collectPromptResultManifestTypesFromText(
  sourceText,
  filePath = "<inline>",
) {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "promptResultSchemaManifest" ||
        node.name.text === "PROMPT_RESULT_SCHEMA_MANIFEST") &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        ts.forEachChild(node, visit);
        return;
      }
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const propertyName = getPropertyName(property.name);
        if (propertyName) {
          matches.push({
            promptType: propertyName,
            ...getLocation(sourceFile, property.name),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export function collectStatusDataWritesFromText(sourceText, filePath = "<inline>") {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const propertyName = getPropertyName(node.name);
      if (propertyName && TRACKED_STATUS_FIELDS.includes(propertyName) && hasDataAncestor(node)) {
        matches.push({
          field: propertyName,
          ...getLocation(sourceFile, node.name),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export function collectTrackedSchemaFieldsFromText(sourceText, filePath = "<inline>") {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const propertyName = getPropertyName(node.name);
      if (
        propertyName &&
        TRACKED_STATUS_FIELDS.includes(propertyName) &&
        isInsideZodObject(node)
      ) {
        matches.push({
          field: propertyName,
          ...getLocation(sourceFile, node.name),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export function collectSetLlmContextCallsFromText(sourceText, filePath = "<inline>") {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (isSetLlmContextCall(node)) {
      matches.push(getLocation(sourceFile, node.expression));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export async function collectRepoSourceFiles(rootDir, dirs = DEFAULT_SCAN_DIRS) {
  const files = [];

  async function visitDir(absoluteDir) {
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const nextAbsolutePath = path.join(absoluteDir, entry.name);
      const relativePath = toPosixPath(path.relative(rootDir, nextAbsolutePath));
      if (entry.isDirectory()) {
        if (isIgnoredFile(`${relativePath}/`)) continue;
        await visitDir(nextAbsolutePath);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (isIgnoredFile(relativePath)) continue;
      files.push({
        path: relativePath,
        absolutePath: nextAbsolutePath,
        text: await fs.readFile(nextAbsolutePath, "utf8"),
      });
    }
  }

  for (const dir of dirs) {
    const absoluteDir = path.join(rootDir, dir);
    try {
      const stat = await fs.stat(absoluteDir);
      if (stat.isDirectory()) {
        await visitDir(absoluteDir);
      }
    } catch {
      // Ignore missing dirs.
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function collectPromptResultWriterTypes(rootDir) {
  const files = await collectRepoSourceFiles(rootDir, ["src"]);
  return files.flatMap((file) =>
    collectPromptResultWriterTypesFromText(file.text, file.path).map((match) => ({
      ...match,
      file: file.path,
    })),
  );
}

export async function collectStatusDataWrites(rootDir) {
  const files = await collectRepoSourceFiles(rootDir);
  return files.flatMap((file) =>
    collectStatusDataWritesFromText(file.text, file.path).map((match) => ({
      ...match,
      file: file.path,
    })),
  );
}

export async function collectTrackedSchemaFields(rootDir) {
  const files = await collectRepoSourceFiles(rootDir, ["src"]);
  return files
    .filter((file) => file.path.startsWith("src/app/api/"))
    .flatMap((file) =>
      collectTrackedSchemaFieldsFromText(file.text, file.path).map((match) => ({
        ...match,
        file: file.path,
      })),
    );
}

export async function collectSetLlmContextCalls(rootDir, relativeRoots) {
  const files = await collectRepoSourceFiles(rootDir, ["src"]);
  return files
    .filter((file) => relativeRoots.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`)))
    .flatMap((file) =>
      collectSetLlmContextCallsFromText(file.text, file.path).map((match) => ({
        ...match,
        file: file.path,
      })),
    );
}
