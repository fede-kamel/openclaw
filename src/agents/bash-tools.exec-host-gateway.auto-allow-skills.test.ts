import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecSkillScope } from "./bash-tools.exec-types.js";
import { callGatewayTool } from "./tools/gateway.js";

const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe.skipIf(process.platform === "win32")("gateway-host exec autoAllowSkills", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let root: string;
  let binDir: string;
  let workspace: string;

  beforeEach(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "PATH",
      "SHELL",
    ]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-skill-bins-"));
    binDir = path.join(root, "bin");
    workspace = path.join(root, "workspace");
    fs.mkdirSync(binDir);
    for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
      setTestEnvValue(name, root);
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin`);
    setTestEnvValue("SHELL", "/bin/sh");
    for (const bin of ["skill-tool", "other-tool", "undeclared-tool"]) {
      fs.copyFileSync("/usr/bin/true", path.join(binDir, bin));
    }
    await writeSkill({
      dir: path.join(workspace, "skills", "skill-tool"),
      name: "skill-tool",
      description: "Runs the skill tool",
      metadata: '{"openclaw":{"requires":{"bins":["skill-tool"]}}}',
    });
    await writeSkill({
      dir: path.join(workspace, "skills", "disabled-skill"),
      name: "disabled-skill",
      description: "A skill turned off in config",
      metadata: '{"openclaw":{"requires":{"bins":["other-tool"]}}}',
    });
    resetProcessRegistryForTests();
    vi.mocked(callGatewayTool).mockReset();
    spawn.mockReset().mockImplementation(async () => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: "skill-bins-spawn",
      startedAtMs: Date.now(),
      cancel: () => {},
      wait: async () => ({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    }));
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function saveApprovals(autoAllowSkills: boolean) {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: { main: { autoAllowSkills, allowlist: [] } },
    });
  }

  function buildConfig() {
    return {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace } } },
      skills: { entries: { "disabled-skill": { enabled: false } } },
    } satisfies OpenClawConfig;
  }

  function run(
    autoAllowSkills: boolean,
    command: string,
    options?: { env?: Record<string, string>; skillScope?: ExecSkillScope },
  ) {
    saveApprovals(autoAllowSkills);
    const tool = createExecTool({
      agentId: "main",
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      config: buildConfig(),
      cwd: root,
      pathPrepend: [binDir, "/usr/bin", "/bin"],
      runId: "skill-bins-run",
      messageProvider: "webchat",
      ...(options?.skillScope ? { skillScope: options.skillScope } : {}),
    });
    return tool.execute(
      "skill-bins-call",
      options?.env ? { command, env: options.env } : { command },
    );
  }

  it("runs a workspace skill's declared bin when autoAllowSkills is on", async () => {
    const result = await run(true, "skill-tool");
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(spawn).toHaveBeenCalledOnce();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("still denies the skill bin when autoAllowSkills is off", async () => {
    await expect(run(false, "skill-tool")).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still denies a bin only a disabled skill declares", async () => {
    await expect(run(true, "other-tool")).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still denies a bin no skill declares when autoAllowSkills is on", async () => {
    await expect(run(true, "undeclared-tool")).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  // A reply can narrow its skills below the agent's config through the session filter or an
  // override. Bin trust must follow that narrower set, or an excluded skill still authorizes exec.
  it("still denies a skill bin the session filter excludes", async () => {
    await expect(
      run(true, "skill-tool", { skillScope: { skillFilter: ["disabled-skill"] } }),
    ).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still denies a skill bin a session override turns off", async () => {
    await expect(
      run(true, "skill-tool", { skillScope: { skillOverrides: { "skill-tool": false } } }),
    ).rejects.toThrow("exec denied: allowlist miss");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the skill bin when the session filter keeps its skill", async () => {
    const result = await run(true, "skill-tool", { skillScope: { skillFilter: ["skill-tool"] } });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(spawn).toHaveBeenCalledOnce();
  });

  // Skill bins resolve by executable identity, and the approvals file records none, so the
  // committed-policy recheck cannot see the authorizing binary being swapped while approval
  // settles. The spawn boundary must, before the process can do any I/O.
  it("denies at the spawn boundary when the authorizing skill bin is swapped", async () => {
    saveApprovals(true);
    const result = await processGatewayAllowlist({
      command: "skill-tool",
      workdir: root,
      env: { PATH: `${binDir}:/usr/bin:/bin` },
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      agentId: "main",
      config: buildConfig(),
    });
    expect(result.deniedResult).toBeUndefined();
    expect(result.revalidateBeforeExecution).toBeTypeOf("function");

    // Repoint the trusted name at a different executable, as a skill upgrade or a planted
    // replacement would between authorization and spawn.
    const swapped = path.join(root, "swapped-tool");
    fs.copyFileSync("/usr/bin/true", swapped);
    fs.rmSync(path.join(binDir, "skill-tool"));
    fs.symlinkSync(swapped, path.join(binDir, "skill-tool"));

    const denied = await result.revalidateBeforeExecution?.();
    expect(denied?.details).toMatchObject({ status: "failed", exitCode: null });
    expect(denied?.details?.aggregated).toContain(
      "SYSTEM_RUN_DENIED: skill bin authorization changed before execution",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  // Skill bins resolve on the command's PATH, which is safe only because host exec refuses a
  // requested PATH; this pins that invariant.
  it("refuses a requested PATH that would reach a planted skill-named binary", async () => {
    const planted = path.join(root, "planted");
    fs.mkdirSync(planted);
    fs.copyFileSync("/usr/bin/true", path.join(planted, "skill-tool"));
    await expect(
      run(true, "skill-tool", { env: { PATH: `${planted}:/usr/bin:/bin` } }),
    ).rejects.toThrow("Custom 'PATH' variable is forbidden during host execution");
    expect(spawn).not.toHaveBeenCalled();
  });
});
