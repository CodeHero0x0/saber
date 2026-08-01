import { SaberError } from "../lib/errors.js";
import { setupWorkspace, type SetupDependencies, type SetupResult } from "../lib/setup.js";

export type SetupCommandDependencies = SetupDependencies;
export type SetupCommandResult = { exitCode: number; stdout: string; stderr: string };

function format(result: SetupResult): string {
  const lines = ["Saber setup complete"];
  if (result.initialized) lines.push("- workspace: initialized");
  lines.push(`- skills: ${result.skills.join(", ")}`);
  for (const project of result.projects) {
    if (project.status === "skipped") {
      lines.push(`- ${project.name}: skipped (${project.reason})`);
      continue;
    }
    const tools = project.tools.length === 0 ? "no supported tool directory" : project.tools.join(", ");
    lines.push(`- ${project.name}: ${project.cloned ? "cloned; " : ""}${project.installed} managed links; ${tools}`);
    if (project.removed > 0) lines.push(`  - removed: ${project.removed}`);
    for (const conflict of project.conflicts) lines.push(`  - conflict preserved: ${conflict}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runSetupCommand(
  argv: readonly string[],
  { cwd, dependencies }: { cwd: string; dependencies?: SetupCommandDependencies },
): Promise<SetupCommandResult> {
  if (argv.length > 0) return { exitCode: 2, stdout: "", stderr: "saber setup does not accept arguments\n" };
  try {
    return { exitCode: 0, stdout: format(await setupWorkspace(cwd, dependencies)), stderr: "" };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "saber setup failed";
    return { exitCode: error instanceof SaberError ? error.exitCode : 1, stdout: "", stderr: `${message}\n` };
  }
}
