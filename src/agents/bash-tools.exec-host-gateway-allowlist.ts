/**
 * Gateway-host exec allowlist evaluation, including skill bins for autoAllowSkills.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  evaluateShellAllowlistWithAuthorization,
  isSegmentAuthorizedBySkillBins,
  type ExecAllowlistEntry,
  type ExecCommandSegment,
  type ExecSegmentSatisfiedBy,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import { resolveSkillBinTrustEntries } from "../node-host/runtime-skill-bins.js";
import { collectSkillBins } from "../skills/discovery/bins.js";
import { resolveWorkspaceSkillPromptEntries } from "../skills/loading/workspace-skill-loader.js";
import { getSkillsSourceVersion } from "../skills/runtime/refresh-state.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";
import type { ExecSkillScope } from "./bash-tools.exec-types.js";

type ResolvedGatewaySkillBins = {
  skillBins: SkillBinTrustEntry[];
  pathEnv: string;
  /** Skill source revision read before discovery; absent when no skill could be resolved. */
  source?: { workspaceDir: string; sourceVersion: number };
};

/**
 * Skill bins for gateway-host autoAllowSkills: only the skills eligible for the admitted run (the
 * set its prompt sees: enabled, allowed, requirements met, then narrowed by the session's own skill
 * filter and overrides), never every installed skill, resolved on the PATH the command itself
 * resolves on, as the node host resolves `skills.bins`. That PATH is the Gateway's plus operator
 * `pathPrepend`: host exec rejects a requested PATH, so a tool call cannot point a skill bin name at
 * another binary. A session that excludes a skill therefore cannot borrow its binaries. Fails closed
 * to no bins.
 */
async function resolveGatewaySkillBins(params: {
  config?: OpenClawConfig;
  agentId?: string;
  skillScope?: ExecSkillScope;
  env: Record<string, string>;
}): Promise<ResolvedGatewaySkillBins> {
  const pathEnv = params.env.PATH ?? process.env.PATH ?? "";
  if (!params.config) {
    return { skillBins: [], pathEnv };
  }
  try {
    const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
    const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId);
    // Read before discovery: a skill change that lands while discovery runs then leaves the
    // revision ahead of what was verified, and the final initiation check denies.
    const sourceVersion = getSkillsSourceVersion(workspaceDir);
    const { eligible } = await resolveWorkspaceSkillPromptEntries(workspaceDir, {
      config: params.config,
      agentId,
      // The run's admitted scope, not a fresh agent-config-only projection: the session's
      // filter and overrides must bound which skills can authorize a host binary.
      ...(params.skillScope?.skillFilter ? { skillFilter: params.skillScope.skillFilter } : {}),
      ...(params.skillScope?.skillOverrides
        ? { skillOverrides: params.skillScope.skillOverrides }
        : {}),
    });
    return {
      skillBins: resolveSkillBinTrustEntries(collectSkillBins(eligible), pathEnv),
      pathEnv,
      source: { workspaceDir, sourceVersion },
    };
  } catch {
    return { skillBins: [], pathEnv };
  }
}

/** Evaluates a gateway-host command against the approvals allowlist, safe bins and skill bins. */
export async function evaluateGatewayShellAllowlist(
  params: ProcessGatewayAllowlistParams,
  allowlist: ExecAllowlistEntry[],
  autoAllowSkills: boolean,
) {
  const skillBins = autoAllowSkills
    ? (
        await resolveGatewaySkillBins({
          config: params.config,
          agentId: params.agentId,
          skillScope: params.skillScope,
          env: params.env,
        })
      ).skillBins
    : [];
  return evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.workdir,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins,
    autoAllowSkills,
  });
}

/**
 * Skill-bin authority as the last async re-resolution verified it, held so native initiation can
 * recheck it synchronously: the skill source revision discovery read, and the bins that authorized
 * the command with the PATH they resolve on.
 */
export type HeldGatewaySkillBinAuthority = {
  workspaceDir: string;
  sourceVersion: number;
  pathEnv: string;
  bins: string[];
};

type GatewaySkillBinSegments = {
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy: readonly ExecSegmentSatisfiedBy[];
};

function listSkillAdmittedSegments(params: GatewaySkillBinSegments): ExecCommandSegment[] {
  return params.segments.filter((_segment, index) => params.segmentSatisfiedBy[index] === "skills");
}

/**
 * Re-resolves skill-bin authority after the policy commit and reports the first segment that skill
 * trust no longer covers. The approvals file records only the `autoAllowSkills` flag, never which
 * skill or executable authorized the command, so the committed `requireAutoAllowSkills` recheck
 * cannot see the trusted name being repointed at a different executable while approval settles.
 * Re-resolving closes that window before the process can perform any I/O. Fails closed: a scope
 * that no longer resolves yields no bins, which denies. While trust holds, also returns the
 * authority to hold through native initiation.
 */
export async function verifyGatewaySkillBinAuthority(
  params: GatewaySkillBinSegments & {
    allowlistParams: ProcessGatewayAllowlistParams;
    autoAllowSkills: boolean;
  },
): Promise<{ revoked?: ExecCommandSegment; held?: HeldGatewaySkillBinAuthority }> {
  const skillSegments = listSkillAdmittedSegments(params);
  const firstSkillSegment = skillSegments[0];
  if (!firstSkillSegment) {
    return {};
  }
  if (!params.autoAllowSkills) {
    return { revoked: firstSkillSegment };
  }
  const { skillBins, pathEnv, source } = await resolveGatewaySkillBins({
    config: params.allowlistParams.config,
    agentId: params.allowlistParams.agentId,
    skillScope: params.allowlistParams.skillScope,
    env: params.allowlistParams.env,
  });
  const revoked = skillSegments.find(
    (segment) => !isSegmentAuthorizedBySkillBins({ segment, skillBins }),
  );
  if (revoked || !source) {
    return { revoked: revoked ?? firstSkillSegment };
  }
  // Hold only the bins that authorized a segment, so native initiation re-resolves just those.
  const bins = skillBins
    .filter((entry) =>
      skillSegments.some((segment) =>
        isSegmentAuthorizedBySkillBins({ segment, skillBins: [entry] }),
      ),
    )
    .map((entry) => entry.name);
  return { held: { ...source, pathEnv, bins: [...new Set(bins)] } };
}

/**
 * Synchronous recheck of held skill authority for the final native-initiation boundary, where no
 * await may separate the check from the spawn. Denies when nothing was verified, when the skill
 * source revision moved since verification (a skill installed, removed or reconfigured), or when an
 * authorizing bin now resolves to a different executable. Uses the same identity comparison as
 * allowlist evaluation, so the two cannot drift.
 */
export function findStaleHeldGatewaySkillBinSegment(
  params: GatewaySkillBinSegments & { held?: HeldGatewaySkillBinAuthority },
): ExecCommandSegment | undefined {
  const skillSegments = listSkillAdmittedSegments(params);
  const held = params.held;
  if (!held || getSkillsSourceVersion(held.workspaceDir) !== held.sourceVersion) {
    return skillSegments[0];
  }
  const skillBins = resolveSkillBinTrustEntries(held.bins, held.pathEnv);
  return skillSegments.find((segment) => !isSegmentAuthorizedBySkillBins({ segment, skillBins }));
}
