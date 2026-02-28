import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  auditPostCompactionReads,
  extractReadPaths,
  formatAuditWarning,
} from "./post-compaction-audit.js";

describe("extractReadPaths", () => {
  it("extracts file paths from Read tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file_path: "WORKFLOW_AUTO.md" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file_path: "memory/2026-02-16.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual(["WORKFLOW_AUTO.md", "memory/2026-02-16.md"]);
  });

  it("handles path parameter (alternative to file_path)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { path: "AGENTS.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual(["AGENTS.md"]);
  });

  it("ignores non-assistant messages", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file_path: "should_be_ignored.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual([]);
  });

  it("ignores non-read tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "exec",
            input: { command: "cat WORKFLOW_AUTO.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual([]);
  });

  it("handles empty messages array", () => {
    const paths = extractReadPaths([]);
    expect(paths).toEqual([]);
  });

  it("handles messages with non-array content", () => {
    const messages = [
      {
        role: "assistant",
        content: "text only",
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual([]);
  });
});

describe("auditPostCompactionReads", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-audit-test-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("passes when all required files are read", () => {
    // Create the files on disk so the audit considers them required
    fs.writeFileSync(path.join(workspaceDir, "WORKFLOW_AUTO.md"), "test");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory", "2026-02-16.md"), "test");

    const readPaths = ["WORKFLOW_AUTO.md", "memory/2026-02-16.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("skips non-existent files — no false warnings", () => {
    // Neither WORKFLOW_AUTO.md nor memory/ exist → audit should pass
    const result = auditPostCompactionReads([], workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("fails when existing required files are not read", () => {
    fs.writeFileSync(path.join(workspaceDir, "WORKFLOW_AUTO.md"), "test");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory", "2026-02-16.md"), "test");

    const result = auditPostCompactionReads([], workspaceDir);

    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toContain("WORKFLOW_AUTO.md");
    expect(result.missingPatterns.some((p) => p.includes("memory"))).toBe(true);
  });

  it("reports only missing files", () => {
    fs.writeFileSync(path.join(workspaceDir, "WORKFLOW_AUTO.md"), "test");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory", "2026-02-16.md"), "test");

    const readPaths = ["WORKFLOW_AUTO.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(false);
    expect(result.missingPatterns).not.toContain("WORKFLOW_AUTO.md");
    expect(result.missingPatterns.some((p) => p.includes("memory"))).toBe(true);
  });

  it("matches RegExp patterns against relative paths", () => {
    fs.writeFileSync(path.join(workspaceDir, "WORKFLOW_AUTO.md"), "test");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory", "2026-02-16.md"), "test");

    const readPaths = ["memory/2026-02-16.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toContain("WORKFLOW_AUTO.md");
    expect(result.missingPatterns.length).toBe(1);
  });

  it("normalizes relative paths when matching", () => {
    fs.writeFileSync(path.join(workspaceDir, "WORKFLOW_AUTO.md"), "test");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory", "2026-02-16.md"), "test");

    const readPaths = ["./WORKFLOW_AUTO.md", "memory/2026-02-16.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("normalizes absolute paths when matching", () => {
    fs.writeFileSync(path.join(workspaceDir, "WORKFLOW_AUTO.md"), "test");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory", "2026-02-16.md"), "test");

    const readPaths = [
      path.join(workspaceDir, "WORKFLOW_AUTO.md"),
      path.join(workspaceDir, "memory", "2026-02-16.md"),
    ];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("accepts custom required reads list", () => {
    fs.writeFileSync(path.join(workspaceDir, "custom.md"), "test");

    const readPaths = ["custom.md"];
    const customRequired = ["custom.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });
});

describe("formatAuditWarning", () => {
  it("formats warning message with missing patterns", () => {
    const missingPatterns = ["WORKFLOW_AUTO.md", "memory\\/\\d{4}-\\d{2}-\\d{2}\\.md"];
    const message = formatAuditWarning(missingPatterns);

    expect(message).toContain("⚠️ Post-Compaction Audit");
    expect(message).toContain("WORKFLOW_AUTO.md");
    expect(message).toContain("memory");
    expect(message).toContain("Please read them now");
  });

  it("formats single missing pattern", () => {
    const missingPatterns = ["WORKFLOW_AUTO.md"];
    const message = formatAuditWarning(missingPatterns);

    expect(message).toContain("WORKFLOW_AUTO.md");
    // Check that the missing patterns list only contains WORKFLOW_AUTO.md
    const lines = message.split("\n");
    const patternLines = lines.filter((l) => l.trim().startsWith("- "));
    expect(patternLines).toHaveLength(1);
    expect(patternLines[0]).toContain("WORKFLOW_AUTO.md");
  });
});
