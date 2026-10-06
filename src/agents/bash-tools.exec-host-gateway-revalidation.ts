// Spawn-boundary rechecks for gateway-host exec: approval-binding drift and skill-bin authority,
// each turned into the denial the launch reports instead of spawning.
import type { ExecCommandSegment, ExecSegmentSatisfiedBy } from "../infra/exec-approvals.js";
import {
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../infra/system-run-approval-binding.js";
import {
  APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
  type ApprovedCwdSnapshot,
  revalidateApprovedCwdSnapshot,
} from "../infra/system-run-cwd-binding.js";
import { findRevokedGatewaySkillBinSegment } from "./bash-tools.exec-host-gateway-allowlist.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Builds the failed tool result for a gateway exec denied before or at launch. */
export function buildGatewayExecApprovalDeniedToolResult(params: {
  approvalId?: string;
  deniedReason: string;
  command: string;
  cwd: string;
}): AgentToolResult<ExecToolDetails> {
  const denialContext = params.approvalId
    ? `gateway id=${params.approvalId}, ${params.deniedReason}`
    : params.deniedReason;
  const text = `Exec denied (${denialContext}): ${params.command}`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "failed",
      exitCode: null,
      durationMs: 0,
      aggregated: text,
      timedOut: params.deniedReason.includes("timeout"),
      cwd: params.cwd,
    },
  };
}

/** Returns why an approved cwd or mutable-file binding no longer holds, if it changed. */
export async function resolveGatewayExecApprovalDrift(params: {
  binding?: SystemRunMutableFileBinding;
  cwdSnapshot?: ApprovedCwdSnapshot;
  cwd: string;
}): Promise<string | undefined> {
  if (params.binding) {
    const current = await revalidateSystemRunMutableFileBinding({
      binding: params.binding,
      cwd: params.cwd,
    });
    if (!current.ok) {
      return current.message;
    }
  }
  if (params.cwdSnapshot && !revalidateApprovedCwdSnapshot(params.cwdSnapshot)) {
    return APPROVAL_CWD_DRIFT_DENIED_MESSAGE;
  }
  return undefined;
}

/** Rechecks a gateway approval binding at the caller's final spawn boundary. */
export async function revalidateGatewayExecApprovalBinding(params: {
  binding?: SystemRunMutableFileBinding;
  cwdSnapshot?: ApprovedCwdSnapshot;
  command: string;
  cwd: string;
}): Promise<AgentToolResult<ExecToolDetails> | undefined> {
  const deniedReason = await resolveGatewayExecApprovalDrift(params);
  return deniedReason
    ? buildGatewayExecApprovalDeniedToolResult({
        deniedReason,
        command: params.command,
        cwd: params.cwd,
      })
    : undefined;
}

const SKILL_BIN_AUTHORITY_REVOKED_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: skill bin authorization changed before execution";

/** Runs spawn-boundary rechecks in order and returns the first denial. */
export function chainRevalidations(
  revalidations: Array<(() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined>,
): (() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined {
  const active = revalidations.filter(
    (revalidate): revalidate is () => Promise<AgentToolResult<ExecToolDetails> | undefined> =>
      Boolean(revalidate),
  );
  if (active.length === 0) {
    return undefined;
  }
  return async () => {
    for (const revalidate of active) {
      const denied = await revalidate();
      if (denied) {
        return denied;
      }
    }
    return undefined;
  };
}

/**
 * Spawn-boundary recheck of skill-bin authority. The approvals file records the autoAllowSkills
 * flag but never the executable a skill authorized, so the committed-policy recheck cannot see
 * that binary change while approval settles; this re-resolves the authorizing skill bins instead.
 * Both members are undefined when no segment was admitted on skill trust.
 */
export function createGatewaySkillBinAuthorityRecheck(params: {
  allowlistParams: ProcessGatewayAllowlistParams;
  analysisOk: boolean;
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy: readonly ExecSegmentSatisfiedBy[];
  autoAllowSkills: boolean;
}) {
  // Only a command that analyzed cleanly can have segments admitted on skill trust.
  if (!params.analysisOk || !params.segmentSatisfiedBy.includes("skills")) {
    return { resolveSkillBinAuthorityDrift: undefined, revalidateSkillBinAuthority: undefined };
  }
  const resolveSkillBinAuthorityDrift = async (): Promise<string | undefined> =>
    (await findRevokedGatewaySkillBinSegment(params))
      ? SKILL_BIN_AUTHORITY_REVOKED_DENIED_MESSAGE
      : undefined;
  const revalidateSkillBinAuthority = async (): Promise<
    AgentToolResult<ExecToolDetails> | undefined
  > => {
    const deniedReason = await resolveSkillBinAuthorityDrift();
    return deniedReason
      ? buildGatewayExecApprovalDeniedToolResult({
          deniedReason,
          command: params.allowlistParams.command,
          cwd: params.allowlistParams.workdir,
        })
      : undefined;
  };
  return { resolveSkillBinAuthorityDrift, revalidateSkillBinAuthority };
}
