import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from "shiki";

/**
 * Syntax highlighting with Shiki: the same TextMate grammars and themes as VS Code.
 * Whole files are tokenized (not diff hunks) so multi-line strings/comments are right,
 * then the diff looks lines up by line number.
 */

const THEMES = { light: "light-plus", dark: "dark-plus" } as const;
const MAX_LINES = 20_000;

let hl: Promise<Highlighter> | null = null;
const getHighlighter = () => (hl ??= createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [] }));

const SPECIAL: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  justfile: "just",
  ".bashrc": "bash",
  ".zshrc": "zsh",
  ".env": "dotenv",
  "go.mod": "go",
  "go.sum": "txt",
};
const EXT_ALIAS: Record<string, string> = { mts: "ts", cts: "ts", mjs: "js", cjs: "js", h: "c", hpp: "cpp", cc: "cpp", yml: "yaml", jsonc: "jsonc", kts: "kotlin", mdx: "mdx", tf: "terraform" };

export function langFor(path: string): BundledLanguage | null {
  const base = path.split("/").pop()!.toLowerCase();
  const special = SPECIAL[base];
  if (special) return special in bundledLanguages ? (special as BundledLanguage) : null;
  if (!base.includes(".")) return null;
  const ext = base.split(".").pop()!;
  const id = EXT_ALIAS[ext] ?? ext;
  return id in bundledLanguages ? (id as BundledLanguage) : null;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function style(t: ThemedToken): string {
  const s = t.htmlStyle;
  if (!s) return "";
  return typeof s === "string" ? s : Object.entries(s).map(([k, v]) => `${k}:${v}`).join(";");
}

// Cache by content so collapsing/expanding a file or re-renders don't re-tokenize.
const cache = new Map<string, Promise<string[]>>();

/** HTML for each line of `lines` (same length), or null if the language is unknown / file too big. */
export function highlightLines(lines: string[], lang: BundledLanguage | null): Promise<string[]> | null {
  if (!lang || lines.length > MAX_LINES) return null;
  const text = lines.join("\n");
  const key = `${lang}\0${text}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const h = await getHighlighter();
      if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
      const { tokens } = h.codeToTokens(text, { lang, themes: THEMES, defaultColor: false });
      return tokens.map((line) => line.map((t) => `<span style="${style(t)}">${escapeHtml(t.content)}</span>`).join(""));
    })();
    p.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(key, p);
  }
  return p;
}
