import fs from "node:fs";
import path from "node:path";

// Default required files — constants, extensible to config later
const DEFAULT_REQUIRED_READS: Array<string | RegExp> = [
  "WORKFLOW_AUTO.md",
  /memory\/\d{4}-\d{2}-\d{2}\.md/, // daily memory files
];

/**
 * Check if any files matching the pattern exist in the workspace directory.
 * Uses a shallow scan of common memory subdirectories to avoid expensive
 * recursive walks.
 */
function findMatchingFiles(workspaceDir: string, pattern: RegExp): boolean {
  // Check common locations: workspace root and memory/ subdirectory.
  const dirs = [workspaceDir, path.join(workspaceDir, "memory")];
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const rel = path.relative(workspaceDir, path.join(dir, entry));
        const normalizedRel = rel.split(path.sep).join("/");
        if (pattern.test(normalizedRel)) {
          return true;
        }
      }
    } catch {
      // Directory doesn't exist — skip.
    }
  }
  return false;
}

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
 */
export function auditPostCompactionReads(
  readFilePaths: string[],
  workspaceDir: string,
  requiredReads: Array<string | RegExp> = DEFAULT_REQUIRED_READS,
): { passed: boolean; missingPatterns: string[] } {
  const normalizedReads = readFilePaths.map((p) => path.resolve(workspaceDir, p));
  const missingPatterns: string[] = [];

  for (const required of requiredReads) {
    if (typeof required === "string") {
      const requiredResolved = path.resolve(workspaceDir, required);
      // Skip files that don't exist in the workspace — agents shouldn't be
      // asked to read files that were never created (#29243).
      if (!fs.existsSync(requiredResolved)) {
        continue;
      }
      const found = normalizedReads.some((r) => r === requiredResolved);
      if (!found) {
        missingPatterns.push(required);
      }
    } else {
      // RegExp — match against relative paths from workspace.
      // First check if any matching files exist on disk before flagging as missing.
      const matchingFilesExist = findMatchingFiles(workspaceDir, required);
      if (!matchingFilesExist) {
        continue;
      }
      const found = readFilePaths.some((p) => {
        const rel = path.relative(workspaceDir, path.resolve(workspaceDir, p));
        // Normalize to forward slashes for cross-platform RegExp matching
        const normalizedRel = rel.split(path.sep).join("/");
        return required.test(normalizedRel);
      });
      if (!found) {
        missingPatterns.push(required.source);
      }
    }
  }

  return { passed: missingPatterns.length === 0, missingPatterns };
}

/**
 * Read messages from a session JSONL file.
 * Returns messages from the last N lines (default 100).
 */
export function readSessionMessages(
  sessionFile: string,
  maxLines = 100,
): Array<{ role?: string; content?: unknown }> {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }

  try {
    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n");
    const recentLines = lines.slice(-maxLines);

    const messages: Array<{ role?: string; content?: unknown }> = [];
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Extract file paths from Read tool calls in agent messages.
 * Looks for tool_use blocks with name="read" and extracts path/file_path args.
 */
export function extractReadPaths(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "read") {
        const filePath = block.input?.file_path ?? block.input?.path;
        if (typeof filePath === "string") {
          paths.push(filePath);
        }
      }
    }
  }
  return paths;
}

/** Format the audit warning message */
export function formatAuditWarning(missingPatterns: string[]): string {
  const fileList = missingPatterns.map((p) => `  - ${p}`).join("\n");
  return (
    "⚠️ Post-Compaction Audit: The following required startup files were not read after context reset:\n" +
    fileList +
    "\n\nPlease read them now using the Read tool before continuing. " +
    "This ensures your operating protocols are restored after memory compaction."
  );
}
