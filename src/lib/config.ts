import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import type { SaberConfig, SaberProject } from "./types.js";

const identifier = /^[a-z][a-z0-9-]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SaberError(`${label} must be a non-empty string`, 2);
  }
  return value;
}

function parseProject(value: unknown, index: number): SaberProject {
  if (!isRecord(value)) throw new SaberError(`projects[${index}] must be an object`, 2);
  const name = asString(value.name, `projects[${index}].name`);
  const path = asString(value.path, `projects[${index}].path`);
  if (!identifier.test(name)) throw new SaberError(`projects[${index}].name must be a lowercase identifier`, 2);
  if (path !== `projects/${name}`) {
    throw new SaberError(`projects[${index}].path must equal projects/${name}`, 2);
  }
  return { name, path };
}

/** Load the intentionally small, shared Saber configuration. */
export async function loadSaberConfig(root: string): Promise<SaberConfig> {
  let raw: unknown;
  try {
    raw = parse(await readFile(join(root, "saber.yaml"), "utf8"));
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    throw new SaberError("saber setup must run from a Saber root containing saber.yaml", 2);
  }

  if (!isRecord(raw)) throw new SaberError("saber.yaml must be an object", 2);
  if (raw.schemaVersion !== 1) throw new SaberError("saber.yaml schemaVersion must be 1", 2);
  if (!Array.isArray(raw.projects)) throw new SaberError("saber.yaml projects must be an array", 2);
  const projects = raw.projects.map(parseProject);
  if (new Set(projects.map(({ name }) => name)).size !== projects.length) {
    throw new SaberError("saber.yaml project names must be unique", 2);
  }

  if (!isRecord(raw.skills)) throw new SaberError("saber.yaml skills must be an object", 2);
  const source = asString(raw.skills.source, "saber.yaml skills.source");
  try {
    const url = new URL(source);
    if (url.protocol !== "https:") throw new Error();
  } catch {
    throw new SaberError("saber.yaml skills.source must be an https URL", 2);
  }
  if (!Array.isArray(raw.skills.include) || !raw.skills.include.every((item) => typeof item === "string" && identifier.test(item))) {
    throw new SaberError("saber.yaml skills.include must contain lowercase skill identifiers", 2);
  }
  const include = [...raw.skills.include];
  if (new Set(include).size !== include.length) throw new SaberError("saber.yaml skills.include must not contain duplicates", 2);

  return { schemaVersion: 1, projects, skills: { source, include } };
}
