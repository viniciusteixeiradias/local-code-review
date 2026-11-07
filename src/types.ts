// Shared between server, CLI and UI.

export type Side = "old" | "new";
export type LineType = "ctx" | "add" | "del";

export interface DiffLine {
  type: LineType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  noNewline?: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  tooLarge?: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** Hash of the changed lines only (independent of context size). Drives "viewed". */
  hash: string;
  /** True when the full file is shown instead of just hunks. */
  expanded: boolean;
}

export interface DiffOptions {
  context: number;
  ignoreWhitespace: boolean;
  expanded: string[];
}

export interface DiffTarget {
  kind: "worktree" | "staged" | "base";
  ref?: string;
  includeUntracked: boolean;
}

export interface DiffSnapshot {
  files: FileDiff[];
  baseRev: string;
  label: string;
  branch: string;
  repoName: string;
  options: DiffOptions;
  generatedAt: number;
  error?: string;
}

export type Author = "user" | "agent";

export interface ThreadMessage {
  author: Author;
  body: string;
  at: string;
}

/** draft = not sent yet, pending = sent to the agent, resolved = done. */
export type CommentStatus = "draft" | "pending" | "resolved";

export interface ReviewComment {
  id: string;
  /** "" = general comment not tied to a file. */
  path: string;
  side: Side;
  /** 0 = file-level comment. */
  startLine: number;
  endLine: number;
  /** Text of the commented lines, used to re-anchor the comment when code moves. */
  snippet: string[];
  status: CommentStatus;
  /** Who resolved it. Agent-resolved comments stay open until the user confirms. */
  resolvedBy?: Author;
  /** The commented lines no longer exist in the current version of the file. */
  outdated: boolean;
  thread: ThreadMessage[];
  round: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewStore {
  version: 1;
  round: number;
  comments: ReviewComment[];
  /** path -> FileDiff.hash at the time it was marked viewed. */
  viewed: Record<string, string>;
  lastTmuxTarget: string | null;
  label: string;
}

export interface TmuxPane {
  id: string;
  name: string;
  command: string;
  path: string;
  title: string;
  isClaude: boolean;
  sameRepo: boolean;
}

export type Delivery =
  | { kind: "tmux"; target: string }
  | { kind: "clipboard" }
  | { kind: "queue" };

export type ServerEvent =
  | { type: "diff"; data: DiffSnapshot }
  | { type: "store"; data: ReviewStore };
