import fs from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveHomeDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";
import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
  type SystemdUserLingerStatus,
} from "./systemd-linger.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignment,
  parseSystemdExecStart,
} from "./systemd-unit.js";

function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

export function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPath(env);
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export type { SystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const unitPath = resolveSystemdUnitPath(env);
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let execStart = "";
    let workingDirectory = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (line.startsWith("Environment=")) {
        const raw = line.slice("Environment=".length).trim();
        const parsed = parseSystemdEnvAssignment(raw);
        if (parsed) {
          environment[parsed.key] = parsed.value;
        }
      }
    }
    if (!execStart) {
      return null;
    }
    const programArguments = parseSystemdExecStart(execStart);
    return {
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

export type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) {
    info.activeState = activeState;
  }
  const subState = entries.substate;
  if (subState) {
    info.subState = subState;
  }
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = Number.parseInt(mainPidValue, 10);
    if (Number.isFinite(pid) && pid > 0) {
      info.mainPid = pid;
    }
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = Number.parseInt(execMainStatusValue, 10);
    if (Number.isFinite(status)) {
      info.execMainStatus = status;
    }
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) {
    info.execMainCode = execMainCode;
  }
  return info;
}

async function execSystemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileUtf8("systemctl", args);
}

/**
 * Returns `["--user"]` when running in user-session scope, or `[]` when running
 * in system scope (e.g. a system-level service without access to the user bus).
 *
 * Detection order:
 * 1. `OPENCLAW_SYSTEMD_SCOPE=system` env var \u2192 system scope (no `--user`)
 * 2. `OPENCLAW_SYSTEMD_SCOPE=user` env var \u2192 user scope (`--user`)
 * 3. Auto-detect: try `systemctl --user status`; if it fails with a bus
 *    connection error, fall back to system scope.
 *
 * The result is cached for the lifetime of the process.
 */
let _cachedScopeArgs: string[] | undefined;

export async function resolveSystemctlScopeArgs(): Promise<string[]> {
  if (_cachedScopeArgs !== undefined) {
    return _cachedScopeArgs;
  }

  const explicit = process.env.OPENCLAW_SYSTEMD_SCOPE?.trim().toLowerCase();
  if (explicit === "system") {
    _cachedScopeArgs = [];
    return _cachedScopeArgs;
  }
  if (explicit === "user") {
    _cachedScopeArgs = ["--user"];
    return _cachedScopeArgs;
  }

  // Auto-detect: try --user first.
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) {
    _cachedScopeArgs = ["--user"];
    return _cachedScopeArgs;
  }
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  const busFailure =
    detail.includes("failed to connect") ||
    detail.includes("not been booted") ||
    detail.includes("no such file or directory") ||
    detail.includes("not supported");
  _cachedScopeArgs = busFailure ? [] : ["--user"];
  return _cachedScopeArgs;
}

/** Helper: prepend the correct scope args to a systemctl command. */
async function scopedSystemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scope = await resolveSystemctlScopeArgs();
  return await execSystemctl([...scope, ...args]);
}

export async function isSystemdUserServiceAvailable(): Promise<boolean> {
  const res = await scopedSystemctl(["status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (!detail) {
    return false;
  }
  if (detail.includes("not found")) {
    return false;
  }
  if (detail.includes("failed to connect")) {
    return false;
  }
  if (detail.includes("not been booted")) {
    return false;
  }
  if (detail.includes("no such file or directory")) {
    return false;
  }
  if (detail.includes("not supported")) {
    return false;
  }
  return false;
}

async function assertSystemdAvailable() {
  const scope = await resolveSystemctlScopeArgs();
  const scopeLabel = scope.length > 0 ? "user" : "system";
  const res = await scopedSystemctl(["status"]);
  if (res.code === 0) {
    return;
  }
  const detail = res.stderr || res.stdout;
  if (detail.toLowerCase().includes("not found")) {
    throw new Error("systemctl not available; systemd services are required on Linux.");
  }
  throw new Error(`systemctl (${scopeLabel}) unavailable: ${detail || "unknown error"}`.trim());
}

export async function installSystemdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: GatewayServiceInstallArgs): Promise<{ unitPath: string }> {
  await assertSystemdAvailable();

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });

  // Preserve user customizations: back up existing unit file before overwriting.
  let backedUp = false;
  try {
    await fs.access(unitPath);
    const backupPath = `${unitPath}.bak`;
    await fs.copyFile(unitPath, backupPath);
    backedUp = true;
  } catch {
    // File does not exist yet — nothing to back up.
  }

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const unit = buildSystemdUnit({
    description: serviceDescription,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(unitPath, unit, "utf8");

  const serviceName = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
  const unitName = `${serviceName}.service`;
  const reload = await scopedSystemctl(["daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
  }

  const enable = await scopedSystemctl(["enable", unitName]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
  }

  const restart = await scopedSystemctl(["restart", unitName]);
  if (restart.code !== 0) {
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
  }

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    stdout,
    [
      {
        label: "Installed systemd service",
        value: unitPath,
      },
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSystemdAvailable();
  const serviceName = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
  const unitName = `${serviceName}.service`;
  await scopedSystemctl(["disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

async function runSystemdServiceAction(params: {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  action: "stop" | "restart";
  label: string;
}) {
  await assertSystemdAvailable();
  const serviceName = resolveSystemdServiceName(params.env ?? {});
  const unitName = `${serviceName}.service`;
  const res = await scopedSystemctl([params.action, unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
  }
  params.stdout.write(`${formatLine(params.label, unitName)}\n`);
}

export async function stopSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "stop",
    label: "Stopped systemd service",
  });
}

export async function restartSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "restart",
    label: "Restarted systemd service",
  });
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  await assertSystemdAvailable();
  const serviceName = resolveSystemdServiceName(args.env ?? {});
  const unitName = `${serviceName}.service`;
  const res = await scopedSystemctl(["is-enabled", unitName]);
  return res.code === 0;
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSystemdAvailable();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await scopedSystemctl([
    "show",
    unitName,
    "--no-page",
    "--property",
    "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
  ]);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = detail.toLowerCase().includes("not found");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const activeState = parsed.activeState?.toLowerCase();
  const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
  return {
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
  };
}
export type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isSystemctlAvailable(): Promise<boolean> {
  const res = await scopedSystemctl(["status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = (res.stderr || res.stdout).toLowerCase();
  return !detail.includes("not found");
}

export async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable();
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await scopedSystemctl(["is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isSystemctlAvailable();
  for (const unit of units) {
    if (systemctlAvailable) {
      await scopedSystemctl(["disable", "--now", `${unit.name}.service`]);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
