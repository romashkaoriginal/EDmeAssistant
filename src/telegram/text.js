function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
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

module.exports = { escapeHtml, richMarkdownToPlainText };
