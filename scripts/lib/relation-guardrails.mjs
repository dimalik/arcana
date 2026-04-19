import ts from "typescript";

import { collectRepoSourceFiles } from "./runtime-foundation-guardrails.mjs";

const READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "count"]);
const WRITE_METHODS = new Set(["create", "update", "delete", "deleteMany", "upsert"]);
const PROVENANCE_KEYS = new Set([
  "reference_match",
  "citation_analysis",
  "discovery",
  "llm_semantic",
  "user_manual",
]);

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

function getPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isPaperRelationMethodCall(node, allowedMethods) {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (!allowedMethods.has(node.expression.name.text)) return false;

  const owner = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(owner) &&
    ts.isIdentifier(owner.name) &&
    owner.name.text === "paperRelation"
  );
}

function isLikelyProvenancePriorityLiteral(node) {
  if (!ts.isObjectLiteralExpression(node)) return false;

  const keys = new Set();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = getPropertyName(property.name);
    if (key) keys.add(key);
  }

  if (keys.size < 3) return false;
  if (!keys.has("reference_match")) return false;
  if (!keys.has("llm_semantic")) return false;
  if (!keys.has("user_manual")) return false;

  for (const key of keys) {
    if (!PROVENANCE_KEYS.has(key)) return false;
  }

  return true;
}

function collectPaperRelationMethodCallsFromText(sourceText, filePath, methods) {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (isPaperRelationMethodCall(node, methods)) {
      matches.push({
        method: node.expression.name.text,
        ...getLocation(sourceFile, node.expression.name),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

function collectProvenancePriorityLiteralsFromText(sourceText, filePath) {
  const sourceFile = createSourceFile(sourceText, filePath);
  const matches = [];

  function visit(node) {
    if (isLikelyProvenancePriorityLiteral(node)) {
      matches.push(getLocation(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export async function collectPaperRelationReads(rootDir) {
  const files = await collectRepoSourceFiles(rootDir, ["src"]);
  return files.flatMap((file) =>
    collectPaperRelationMethodCallsFromText(file.text, file.path, READ_METHODS).map((match) => ({
      ...match,
      file: file.path,
    })),
  );
}

export async function collectPaperRelationWrites(rootDir) {
  const files = await collectRepoSourceFiles(rootDir, ["src"]);
  return files.flatMap((file) =>
    collectPaperRelationMethodCallsFromText(file.text, file.path, WRITE_METHODS).map((match) => ({
      ...match,
      file: file.path,
    })),
  );
}

export async function collectProvenancePriorityLiterals(rootDir) {
  const files = await collectRepoSourceFiles(rootDir, ["src"]);
  return files.flatMap((file) =>
    collectProvenancePriorityLiteralsFromText(file.text, file.path).map((match) => ({
      ...match,
      file: file.path,
    })),
  );
}

