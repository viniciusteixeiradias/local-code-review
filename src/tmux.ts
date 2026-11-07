import type { TmuxPane } from "./types.ts";

async function tmux(args: string[], stdin?: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : "pipe" });
    if (stdin !== undefined && p.stdin) {
      p.stdin.write(stdin);
      await p.stdin.end();
    }
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: code === 0, out, err };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

// Native Claude Code installs show up as their version number (e.g. "2.1.318").
const CLAUDE_CMD = /claude|^\d+\.\d+\.\d+$/i;

export async function listPanes(repoRoot: string): Promise<TmuxPane[]> {
  const fmt = ["#{pane_id}", "#{session_name}:#{window_index}.#{pane_index}", "#{pane_current_command}", "#{pane_current_path}", "#{pane_title}"].join("\t");
  const r = await tmux(["list-panes", "-a", "-F", fmt]);
  if (!r.ok) return [];
  const panes = r.out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", name = "", command = "", path = "", title = ""] = line.split("\t");
      return {
        id,
        name,
        command,
        path,
        title,
        isClaude: CLAUDE_CMD.test(command) || /claude/i.test(title),
        sameRepo: path === repoRoot || path.startsWith(repoRoot + "/"),
      };
    });
  const score = (p: TmuxPane) => (p.isClaude ? 2 : 0) + (p.sameRepo ? 1 : 0);
  return panes.sort((a, b) => score(b) - score(a));
}

export async function sendToPane(target: string, text: string): Promise<void> {
  const buf = `lcr-${process.pid}`;
  let r = await tmux(["load-buffer", "-b", buf, "-"], text.trimEnd());
  if (!r.ok) throw new Error(`tmux load-buffer failed: ${r.err.trim()}`);
  // -p = bracketed paste, so the TUI receives it as one paste instead of keystrokes.
  r = await tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", target]);
  if (!r.ok) throw new Error(`tmux paste-buffer failed: ${r.err.trim()}`);
  await Bun.sleep(400);
  r = await tmux(["send-keys", "-t", target, "Enter"]);
  if (!r.ok) throw new Error(`tmux send-keys failed: ${r.err.trim()}`);
}
