function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function normalizeMathDelimiters(segment) {
  return segment
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
