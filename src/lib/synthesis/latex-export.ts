/**
 * LaTeX document generation from synthesis data.
 * Converts markdown sections → LaTeX, builds a branded document,
 * and optionally compiles to PDF via pdflatex.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Markdown → LaTeX conversion ──

/** Escape LaTeX special characters and normalize Unicode to pdflatex-safe equivalents */
function escapeLatex(text: string): string {
  let result = text;

  // Normalize Unicode characters that pdflatex can't handle with inputenc
  result = result
    .replace(/\u2212/g, "-")           // minus sign → hyphen
    .replace(/\u2013/g, "--")          // en dash
    .replace(/\u2014/g, "---")         // em dash
    .replace(/\u2018/g, "`")           // left single quote
    .replace(/\u2019/g, "'")           // right single quote
    .replace(/\u201C/g, "``")          // left double quote
    .replace(/\u201D/g, "''")          // right double quote
    .replace(/\u2026/g, "...")         // ellipsis
    .replace(/\u00A0/g, "~")           // non-breaking space
    .replace(/\u2002/g, " ")           // en space
    .replace(/\u2003/g, " ")           // em space
    .replace(/\u200B/g, "")            // zero-width space
    .replace(/\u00B7/g, "\\cdot{}")    // middle dot
    .replace(/\u2022/g, "\\textbullet{}") // bullet
    .replace(/\u2192/g, "\\textrightarrow{}") // right arrow
    .replace(/\u2190/g, "\\textleftarrow{}")  // left arrow
    .replace(/\u2264/g, "\\leq{}")     // ≤
    .replace(/\u2265/g, "\\geq{}")     // ≥
    .replace(/\u00D7/g, "\\texttimes{}") // ×
    .replace(/\u00B1/g, "\\textpm{}")  // ±
    .replace(/\u03B1/g, "$\\alpha$")   // α
    .replace(/\u03B2/g, "$\\beta$")    // β
    .replace(/\u03B3/g, "$\\gamma$")   // γ
    .replace(/\u03B4/g, "$\\delta$")   // δ
    .replace(/\u03BB/g, "$\\lambda$")  // λ
    .replace(/\u03C0/g, "$\\pi$")      // π
    .replace(/\u03C3/g, "$\\sigma$")   // σ
    .replace(/\u221E/g, "$\\infty$");  // ∞

  // Strip any remaining non-ASCII that pdflatex can't handle
  // (keep basic Latin-1 supplement range 0x80-0xFF which inputenc handles)
  result = result.replace(/[^\x00-\xFF]/g, "?");

  // Now escape LaTeX special characters
  result = result
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");

  return result;
}

/** Convert a markdown table to LaTeX tabularx (auto-wrapping columns) */
function convertTable(tableBlock: string): string {
  const lines = tableBlock.trim().split("\n").filter((l) => l.trim());
  if (lines.length < 2) return escapeLatex(tableBlock);

  // Parse header
  const headerCells = lines[0]
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  const colCount = headerCells.length;

  // Parse alignment from separator line
  const sepCells = (lines[1] || "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);

  // Build column spec: short columns (< 15 chars in all rows) use l, others use X (auto-wrap)
  const dataLines = lines.slice(2);
  const maxCellLen = headerCells.map((h, ci) => {
    let max = h.length;
    for (const line of dataLines) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells[ci]) max = Math.max(max, cells[ci].length);
    }
    return max;
  });

  const colSpec = maxCellLen.map((len) => (len > 20 ? "X" : "l")).join(" ");
  const hasWrappingCols = maxCellLen.some((len) => len > 20);

  // Use tabularx for tables with long content, regular tabular for short ones
  let tex = "\\begin{table}[h!]\n\\centering\\small\n";
  if (hasWrappingCols) {
    tex += `\\begin{tabularx}{\\textwidth}{${colSpec}}\n\\toprule\n`;
  } else {
    tex += `\\begin{tabular}{${colSpec}}\n\\toprule\n`;
  }
  tex += headerCells.map((c) => `\\textbf{${escapeLatex(c)}}`).join(" & ") + " \\\\\n";
  tex += "\\midrule\n";

  for (const line of dataLines) {
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    tex += cells.map((c) => escapeLatex(c)).join(" & ") + " \\\\\n";
  }

  tex += "\\bottomrule\n";
  if (hasWrappingCols) {
    tex += "\\end{tabularx}\n\\end{table}\n";
  } else {
    tex += "\\end{tabular}\n\\end{table}\n";
  }
  return tex;
}

/** Convert inline markdown formatting to LaTeX */
function convertInline(text: string): string {
  let result = text;

  // Preserve math delimiters — don't escape inside them
  const mathSegments: string[] = [];
  result = result.replace(/(\$\$[\s\S]*?\$\$|\$[^$]+?\$)/g, (match) => {
    mathSegments.push(match);
    return `%%MATH${mathSegments.length - 1}%%`;
  });

  // Inline code
  const codeSegments: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    codeSegments.push(code);
    return `%%CODE${codeSegments.length - 1}%%`;
  });

  // Escape LaTeX specials in the non-math, non-code parts
  result = escapeLatex(result);

  // Bold + italic
  result = result.replace(/\\\*\\\*\\\*(.*?)\\\*\\\*\\\*/g, "\\textbf{\\textit{$1}}");
  // Bold
  result = result.replace(/\\\*\\\*(.*?)\\\*\\\*/g, "\\textbf{$1}");
  // Italic
  result = result.replace(/\\\*(.*?)\\\*/g, "\\textit{$1}");

  // Links [text](url)
  result = result.replace(/\\\[([^\]]*?)\\\]\\\(([^)]*?)\\\)/g, (_, text, url) => {
    return `\\href{${url.replace(/\\/g, "")}}{${text}}`;
  });

  // Restore code segments
  result = result.replace(/%%CODE(\d+)%%/g, (_, i) => {
    return `\\texttt{${escapeLatex(codeSegments[parseInt(i)])}}`;
  });

  // Restore math segments
  result = result.replace(/%%MATH(\d+)%%/g, (_, i) => mathSegments[parseInt(i)]);

  return result;
}

/** Convert markdown content to LaTeX body (not full document) */
export function markdownToLatex(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBuffer: string[] = [];
  let inTable = false;
  let tableBuffer: string[] = [];
  let inList = false;
  let listType: "itemize" | "enumerate" = "itemize";

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      output.push(convertTable(tableBuffer.join("\n")));
      tableBuffer = [];
    }
    inTable = false;
  };

  const flushList = () => {
    if (inList) {
      output.push(`\\end{${listType}}`);
      inList = false;
    }
  };

  for (const line of lines) {
    // Code blocks
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        output.push("\\end{verbatim}\\end{small}");
        inCodeBlock = false;
        codeBuffer = [];
      } else {
        flushTable();
        flushList();
        codeBlockLang = line.trim().slice(3).trim();
        inCodeBlock = true;
        output.push("\\begin{small}\\begin{verbatim}");
      }
      continue;
    }

    if (inCodeBlock) {
      output.push(line);
      continue;
    }

    // Table rows
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      flushList();
      if (!inTable) inTable = true;
      tableBuffer.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    const trimmed = line.trim();

    // Empty line
    if (trimmed === "") {
      flushList();
      output.push("");
      continue;
    }

    // Headers
    if (trimmed.startsWith("# ")) {
      flushList();
      output.push(`\\section*{${convertInline(trimmed.slice(2))}}`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      output.push(`\\subsection*{${convertInline(trimmed.slice(3))}}`);
      continue;
    }
    if (trimmed.startsWith("### ")) {
      flushList();
      output.push(`\\subsubsection*{${convertInline(trimmed.slice(4))}}`);
      continue;
    }
    if (trimmed.startsWith("#### ")) {
      flushList();
      output.push(`\\paragraph{${convertInline(trimmed.slice(5))}}`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushList();
      output.push("\\bigskip\\hrule\\bigskip");
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      flushList();
      output.push(`\\begin{quote}\n${convertInline(trimmed.slice(2))}\n\\end{quote}`);
      continue;
    }

    // Unordered list
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== "itemize") {
        flushList();
        listType = "itemize";
        inList = true;
        output.push("\\begin{itemize}");
      }
      output.push(`  \\item ${convertInline(ulMatch[1])}`);
      continue;
    }

    // Ordered list
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== "enumerate") {
        flushList();
        listType = "enumerate";
        inList = true;
        output.push("\\begin{enumerate}");
      }
      output.push(`  \\item ${convertInline(olMatch[1])}`);
      continue;
    }

    // Regular paragraph text
    flushList();
    output.push(convertInline(trimmed));
  }

  flushList();
  flushTable();

  return output.join("\n");
}

// ── Document builder ──

interface PaperRef {
  id: string;
  title: string;
  year: number | null;
  authors: string | null;
}

interface Section {
  sectionType: string;
  title: string;
  content: string;
}

interface ExportOptions {
  title: string;
  paperCount: number;
  createdAt: string;
  sections: Section[];
  papers: PaperRef[];
}

/** Replace [paperId] with numbered citations */
function numberCitations(
  content: string,
  paperIndex: Map<string, number>
): string {
  return content.replace(/\[([a-f0-9-]{36})\]/g, (match, id) => {
    const num = paperIndex.get(id);
    if (num !== undefined) return `[${num}]`;
    return match;
  });
}

export function buildLatexDocument(opts: ExportOptions): string {
  const { title, paperCount, createdAt, sections, papers } = opts;
  const dateStr = new Date(createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Build paper index for numbered citations
  const paperIndex = new Map<string, number>();
  papers.forEach((p, i) => paperIndex.set(p.id, i + 1));

  // Build bibliography entries
  const bibliography = papers
    .map((p, i) => {
      let authors = "";
      try {
        authors = JSON.parse(p.authors || "[]").join(", ");
      } catch {
        authors = p.authors || "";
      }
      const yearStr = p.year ? ` (${p.year})` : "";
      return `\\bibitem{ref${i + 1}} ${escapeLatex(authors)}${authors ? ". " : ""}\\textit{${escapeLatex(p.title)}}${yearStr}.`;
    })
    .join("\n\n");

  // Convert each section
  const sectionTexts = sections.map((sec) => {
    const cited = numberCitations(sec.content, paperIndex);
    const body = markdownToLatex(cited);
    return `\\section{${escapeLatex(sec.title)}}\n\n${body}`;
  });

  return `\\documentclass[11pt, a4paper]{article}

% ── Packages ──
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=1in]{geometry}
\\usepackage{fancyhdr}
\\usepackage{booktabs}
\\usepackage{tabularx}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage{parskip}
\\usepackage{microtype}
\\usepackage[hyphens,spaces]{url}
\\usepackage[breaklinks=true]{hyperref}

% ── Overflow prevention ──
\\emergencystretch=1.5em
\\tolerance=1000
\\widowpenalty=10000
\\clubpenalty=10000

% ── Colors ──
\\definecolor{arcana}{RGB}{99, 102, 241}
\\definecolor{mutedtext}{RGB}{107, 114, 128}

% ── Hyperlinks ──
\\hypersetup{
  colorlinks=true,
  linkcolor=arcana,
  urlcolor=arcana,
  citecolor=arcana,
}
\\urlstyle{same}

% ── Header/Footer ──
\\pagestyle{fancy}
\\fancyhf{}
\\renewcommand{\\headrulewidth}{0.4pt}
\\fancyhead[L]{\\textcolor{arcana}{\\textbf{\\textsf{ARCANA}}}\\quad{\\small\\textcolor{mutedtext}{Research Synthesis}}}
\\fancyhead[R]{\\small\\textcolor{mutedtext}{${escapeLatex(title.slice(0, 50))}}}
\\fancyfoot[C]{\\small\\thepage}
\\fancyfoot[R]{\\small\\textcolor{mutedtext}{Generated by Arcana}}

% ── Title formatting ──
\\titleformat{\\section}{\\Large\\bfseries\\sffamily}{\\thesection}{1em}{}
\\titleformat{\\subsection}{\\large\\bfseries\\sffamily}{\\thesubsection}{1em}{}
\\titleformat{\\subsubsection}{\\normalsize\\bfseries\\sffamily}{\\thesubsubsection}{1em}{}

\\begin{document}

% ── Title Page ──
\\begin{titlepage}
\\centering
\\vspace*{2cm}

{\\fontsize{42}{50}\\selectfont\\textcolor{arcana}{\\textsf{\\textbf{ARCANA}}}}

\\vspace{0.3cm}
{\\large\\textcolor{mutedtext}{\\textsf{Research Paper Analysis Platform}}}

\\vspace{3cm}

{\\LARGE\\bfseries\\sffamily ${escapeLatex(title)}}

\\vspace{1.5cm}

{\\large ${paperCount} papers synthesized}

\\vspace{0.5cm}

{\\textcolor{mutedtext}{${dateStr}}}

\\vfill

{\\small\\textcolor{mutedtext}{This document was automatically generated by Arcana's synthesis engine.}}

\\end{titlepage}

% ── Table of Contents ──
\\tableofcontents
\\newpage

% ── Sections ──
${sectionTexts.join("\n\n\\bigskip\n\n")}

% ── Bibliography ──
\\begin{raggedright}
\\begin{thebibliography}{${papers.length}}
\\setlength{\\itemsep}{0.5em}
${bibliography}
\\end{thebibliography}
\\end{raggedright}

\\end{document}
`;
}

// ── PDF compilation ──

export async function compileLatexToPdf(
  texContent: string,
  outputDir: string
): Promise<{ pdfPath: string | null; texPath: string; error?: string }> {
  const fs = await import("fs/promises");
  const path = await import("path");

  await fs.mkdir(outputDir, { recursive: true });
  const texPath = path.join(outputDir, "synthesis.tex");
  await fs.writeFile(texPath, texContent, "utf-8");

  // Try to compile with pdflatex (two passes for TOC)
  try {
    // Resolve pdflatex binary — BasicTeX on macOS installs here
    const PDFLATEX_PATHS = [
      "/Library/TeX/texbin/pdflatex",
      "/usr/local/bin/pdflatex",
      "/usr/bin/pdflatex",
      "pdflatex", // fallback to PATH
    ];

    let pdflatexBin = "pdflatex";
    for (const p of PDFLATEX_PATHS) {
      try {
        await fs.access(p);
        pdflatexBin = p;
        break;
      } catch {
        // not at this path
      }
    }

    const pdflatexArgs = [
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-output-directory",
      outputDir,
      texPath,
    ];

    // First pass
    const pass1 = await execFileAsync(pdflatexBin, pdflatexArgs, {
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    // Second pass for TOC/references
    const pass2 = await execFileAsync(pdflatexBin, pdflatexArgs, {
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const pdfPath = path.join(outputDir, "synthesis.pdf");
    try {
      await fs.access(pdfPath);
      return { pdfPath, texPath };
    } catch {
      return { pdfPath: null, texPath, error: "PDF not generated" };
    }
  } catch (err: unknown) {
    // Extract the actual LaTeX error from stdout/stderr
    let detail = "";
    if (err && typeof err === "object") {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = (e.stdout || "") + (e.stderr || "");
      // Find lines with "!" which indicate LaTeX errors
      const errorLines = output
        .split("\n")
        .filter((l) => l.startsWith("!") || l.startsWith("l."))
        .slice(0, 10)
        .join("\n");
      detail = errorLines || e.message || "Unknown error";
    } else {
      detail = String(err);
    }

    // Also try to read the .log file for more detail
    const logPath = path.join(outputDir, "synthesis.log");
    try {
      const log = await fs.readFile(logPath, "utf-8");
      const logErrors = log
        .split("\n")
        .filter((l) => l.startsWith("!") || l.startsWith("l."))
        .slice(0, 10)
        .join("\n");
      if (logErrors) detail = logErrors;
    } catch {
      // no log file
    }

    console.error("[latex-export] pdflatex compilation failed. Errors:\n" + detail);
    console.error("[latex-export] .tex file preserved at:", texPath);
    return {
      pdfPath: null,
      texPath,
      error: `Compilation failed: ${detail}`,
    };
  }
}
