export const CHAT_ARTIFACT_LANG_EXT: Record<string, string> = {
  latex: ".tex",
  tex: ".tex",
  python: ".py",
  py: ".py",
  javascript: ".js",
  js: ".js",
  typescript: ".ts",
  ts: ".ts",
  json: ".json",
  yaml: ".yaml",
  yml: ".yaml",
  markdown: ".md",
  md: ".md",
  bash: ".sh",
  sh: ".sh",
  sql: ".sql",
  csv: ".csv",
  html: ".html",
  css: ".css",
  r: ".R",
  julia: ".jl",
  bibtex: ".bib",
  bib: ".bib",
};

export interface FencedArtifact {
  language: string;
  code: string;
  filename: string | null;
  lineCount: number;
}

export function extractFencedArtifacts(
  content: string,
  minLines: number = 1,
): { prose: string; artifacts: FencedArtifact[] } {
  const artifacts: FencedArtifact[] = [];
  const fencePattern = /```(\w+)?\s*\n([\s\S]*?)```/g;

  const prose = content.replace(fencePattern, (match, lang, code) => {
    const trimmed = code.trimEnd();
    const lines = trimmed.split("\n").length;
    const language = (lang || "").toLowerCase();

    if (lines < minLines) {
      return match;
    }

    let filename: string | null = null;
    const firstLine = trimmed.split("\n")[0];
    const commentFile = firstLine.match(/^(?:#|\/\/|%|--)\s*(\S+\.\w+)/);
    if (commentFile) {
      filename = commentFile[1];
    }

    if (!filename && language) {
      const ext = CHAT_ARTIFACT_LANG_EXT[language] || `.${language}`;
      const dateStr = new Date().toISOString().slice(0, 10);
      filename = `artifact-${dateStr}${ext}`;
    }

    artifacts.push({ language, code: trimmed, filename, lineCount: lines });
    return "";
  });

  return { prose: prose.trim(), artifacts };
}
