import type { ReviewComment } from "./types.ts";

const FENCE_LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", lua: "lua", sql: "sql", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", md: "markdown", html: "html", css: "css", scss: "scss", vue: "vue", svelte: "svelte", ex: "elixir", exs: "elixir",
};

function lang(path: string): string {
  return FENCE_LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

export function location(c: ReviewComment): string {
  if (!c.path) return "General";
  if (c.startLine === 0) return c.path;
  const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
  return `${c.path}:${range}`;
}

function renderComment(c: ReviewComment): string {
  const out: string[] = [];
  const flags = [c.side === "old" ? "on removed lines (original version)" : "", c.outdated ? "outdated: these lines have changed since" : ""].filter(Boolean);
  out.push(`### [${c.id}] ${location(c)}${flags.length ? ` (${flags.join("; ")})` : ""}`);
  if (c.snippet.length) {
    const width = String(c.startLine + c.snippet.length - 1).length;
    const fence = c.snippet.some((l) => l.includes("```")) ? "~~~~" : "```";
    out.push(fence + lang(c.path));
    c.snippet.forEach((l, i) => out.push(`${String(c.startLine + i).padStart(width)}  ${l}`));
    out.push(fence);
  }
  if (c.thread.length === 1) {
    out.push(c.thread[0]!.body.trim());
  } else {
    for (const m of c.thread) {
      const who = m.author === "user" ? "Reviewer" : "You (earlier)";
      out.push(`**${who}:** ${m.body.trim()}`);
    }
  }
  return out.join("\n");
}

export function buildPrompt(comments: ReviewComment[], opts: { round: number; label: string }): string {
  const general = comments.filter((c) => !c.path);
  const rest = comments.filter((c) => c.path).sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const n = comments.length;
  const header = [
    `# Code review feedback${opts.round ? ` (round ${opts.round})` : ""}`,
    "",
    `I reviewed the local changes${opts.label ? ` (${opts.label})` : ""} and left ${n} comment${n === 1 ? "" : "s"}. Please address each one.`,
    "Line numbers refer to the current version of the file unless noted otherwise.",
    "",
    "When you've addressed a comment, mark it resolved with a one-line note on what you changed:",
    '    lcr resolve <id> -m "<what you changed>"',
    "If you disagree or need clarification, don't change the code for that one. Reply instead:",
    '    lcr reply <id> -m "<your question or reasoning>"',
    "You can resolve several at once: lcr resolve c1ab c2cd -m \"...\"",
  ];
  return [...header, "", ...[...general, ...rest].map(renderComment).flatMap((s) => [s, ""])].join("\n").trimEnd() + "\n";
}
