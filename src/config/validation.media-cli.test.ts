import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

const MISSING_COMMAND =
  'Invalid CLI media model; it is skipped without running. Set command to the media executable and args to pass the attachment, for example ["{{AttachmentPath}}"].';
const MISSING_ARGS =
  'Invalid CLI media model; it is skipped without running. Set args to pass the attachment, for example ["{{AttachmentPath}}"]. CLI stdin is not supplied.';

const mediaCliWarnings = (models: unknown[]) => {
  const result = validateConfigObjectWithPlugins(
    { tools: { media: { audio: { enabled: true }, models } } },
    { pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } } },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected valid config");
  }
  return result.warnings.filter((warning) => warning.path.startsWith("tools.media.models."));
};

describe("media CLI entry config warnings", () => {
  it("warns when a cli entry has no command", () => {
    expect(mediaCliWarnings([{ type: "cli", capabilities: ["audio"] }])).toEqual([
      {
        path: "tools.media.models.0.command",
        message: MISSING_COMMAND,
      },
    ]);
  });

  it("warns when a cli entry runs its command with no args", () => {
    expect(
      mediaCliWarnings([
        { type: "cli", command: "/usr/local/bin/oc-transcribe", capabilities: ["audio"] },
      ]),
    ).toEqual([
      {
        path: "tools.media.models.0.args",
        message: MISSING_ARGS,
      },
    ]);
  });

  it("warns for an inferred cli entry whose command is only whitespace", () => {
    // The runner infers "cli" from the raw command, so this entry reaches CLI
    // execution and is refused there. Trimming before inferring would hide it.
    expect(mediaCliWarnings([{ command: "   ", capabilities: ["audio"] }])).toEqual([
      {
        path: "tools.media.models.0.command",
        message: MISSING_COMMAND,
      },
    ]);
  });

  it("reports the failing index for the entry that is incomplete", () => {
    expect(
      mediaCliWarnings([
        { type: "cli", command: "whisper-cli", args: ["{{AttachmentPath}}"] },
        { type: "cli", command: "oc-transcribe", args: [] },
      ]).map((warning) => warning.path),
    ).toEqual(["tools.media.models.1.args"]);
  });

  it.each([
    {
      name: "complete cli entry",
      entry: { type: "cli", command: "w", args: ["{{AttachmentPath}}"] },
    },
    { name: "inferred cli entry with args", entry: { command: "w", args: ["{{AttachmentPath}}"] } },
    { name: "cli entry with a literal input path", entry: { command: "w", args: ["/tmp/in.wav"] } },
    { name: "provider entry", entry: { provider: "openai", model: "gpt-6-astra" } },
  ])("stays quiet for a $name", ({ entry }) => {
    expect(mediaCliWarnings([entry])).toEqual([]);
  });
});
