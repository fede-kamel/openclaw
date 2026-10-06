// CLI media model input checks shared by execution, config validation, and Doctor.
// Kept dependency-light so config validation can import it without pulling in the
// media runtime.
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";

type MediaCliModelUnavailableReason = "cli-missing-command" | "cli-missing-attachment-arg";

class MediaCliModelUnavailableError extends Error {
  constructor(
    readonly reason: MediaCliModelUnavailableReason,
    readonly detail: string,
  ) {
    super(`${reason}; ${detail}`);
  }
}

/** Resolve executable CLI inputs without making invalid media config startup-fatal. */
export function resolveCliModelEntry(
  entry: MediaUnderstandingModelConfig,
): Result<{ command: string; args: string[] }, MediaCliModelUnavailableError> {
  const command = normalizeOptionalString(entry.command);
  if (!command) {
    return err(
      new MediaCliModelUnavailableError(
        "cli-missing-command",
        'Set command to the media executable and args to pass the attachment, for example ["{{AttachmentPath}}"].',
      ),
    );
  }
  const args = entry.args;
  // No stdin is supplied, so empty args cannot carry the attachment. Nonempty
  // literal/custom argv is a shipped command contract; interpolation is optional.
  if (!Array.isArray(args) || args.length === 0) {
    return err(
      new MediaCliModelUnavailableError(
        "cli-missing-attachment-arg",
        'Set args to pass the attachment, for example ["{{AttachmentPath}}"]. CLI stdin is not supplied.',
      ),
    );
  }
  return ok({ command, args });
}

export type MediaCliModelIssue = {
  index: number;
  field: "command" | "args";
  /** Dotted config path, matching config validation issue paths. */
  path: string;
  /** Operator-facing explanation and fix, shared by config validation and Doctor. */
  message: string;
};

/**
 * Lists configured media model entries that resolve to CLI execution but cannot
 * run. Type inference reads the raw `command`, as the runner does, so a
 * whitespace-only command still counts as a CLI entry.
 */
export function collectMediaCliModelIssues(cfg: OpenClawConfig): MediaCliModelIssue[] {
  const models = cfg.tools?.media?.models;
  if (!Array.isArray(models)) {
    return [];
  }
  const issues: MediaCliModelIssue[] = [];
  models.forEach((entry, index) => {
    if (!entry || (entry.type ?? (entry.command ? "cli" : "provider")) !== "cli") {
      return;
    }
    const resolved = resolveCliModelEntry(entry);
    if (resolved.ok) {
      return;
    }
    const field = resolved.error.reason === "cli-missing-command" ? "command" : "args";
    issues.push({
      index,
      field,
      path: `tools.media.models.${index}.${field}`,
      message: `Invalid CLI media model; it is skipped without running. ${resolved.error.detail}`,
    });
  });
  return issues;
}
