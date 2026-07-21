function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

const UNSUPPORTED_LATEX_ENVIRONMENT_NAMES = "array|cases|aligned|align\\*?|matrix|pmatrix|bmatrix|vmatrix|Vmatrix";
const UNSUPPORTED_LATEX_ENVIRONMENT_PATTERN = new RegExp(
  String.raw`\\begin\{(${UNSUPPORTED_LATEX_ENVIRONMENT_NAMES})\}(\{[^{}]*\})?([\s\S]*?)\\end\{\1\}`,
  "g",
);

function normalizeUnsupportedLatex(segment) {
  return String(segment ?? "")
    .replace(UNSUPPORTED_LATEX_ENVIRONMENT_PATTERN, (_, _environment, _columnSpec, body) => {
      const rows = String(body)
        .split(/\\\\(?:\[[^\]]*\])?/)
        .map((row) => {
          const notes = [];
          const formula = row
            .replace(/\\text\{([^{}]*)\}/g, (_, text) => {
              const note = String(text).trim();
              if (note) notes.push(note);
              return "";
            })
            .replace(/&/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (!formula) return notes.length ? `- ${notes.join(" ")}` : "";
          return `- $${formula}$${notes.length ? ` — ${notes.join(" ")}` : ""}`;
        })
        .filter(Boolean);
      return rows.join("\n");
    })
    .replace(/\${1,2}\s*\\left\s*(?:\\\{|\{)\s*(?=-\s*\$)/g, "")
    .replace(/\\right(?:\\[}\]])?\.?\s*\${1,2}/g, "")
    // Telegram's math renderer does not reliably support \text. Unicode text
    // inside a formula is understood, whereas the raw command leaks to users.
    .replace(/\\text\{([^{}]*)\}/g, "$1");
}

function normalizeMathDelimiters(segment) {
  return normalizeUnsupportedLatex(segment)
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_, formula) => `$$${String(formula).trim()}$$`)
    .replace(/(^|[^\$])\$\s*([^\n$]+?)\s*\$(?!\$)/g, (_, prefix, formula) => `${prefix}$${String(formula).trim()}$`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_, formula) => `\\(${String(formula).trim()}\\)`)
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, formula) => `\\[${String(formula).trim()}\\]`);
}

// Telegram Rich Markdown supports LaTeX, but model output often inserts spaces
// right after `$` and before `$`, which causes raw delimiters to leak in UI.
// We normalize only non-code segments so formulas become parseable consistently.
function normalizeRichMarkdown(value) {
  const input = String(value ?? "");
  const parts = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part) => {
      if (!part) return part;
      if (part.startsWith("```") || (part.startsWith("`") && part.endsWith("`"))) return part;
      return normalizeMathDelimiters(part);
    })
    .join("");
}

// Used only as a graceful fallback when Telegram rejects malformed Rich
// Markdown returned by the model. It intentionally covers the common school
// formulas instead of trying to be a full LaTeX parser.
function richMarkdownToPlainText(value) {
  return String(value ?? "")
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, "√($1)")
    .replace(/\\(?:cdot|times)\b/g, "×")
    .replace(/\\(?:leq?|geq?)\b/g, (operator) => operator.startsWith("\\l") ? "≤" : "≥")
    .replace(/\\neq\b/g, "≠")
    .replace(/\\pm\b/g, "±")
    .replace(/\${1,2}/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[{}]/g, "");
}

module.exports = { escapeHtml, normalizeRichMarkdown, richMarkdownToPlainText };
