import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import type { SaberConfig, SaberProject, SaberSkillSource } from "./types.js";

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

function asPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new SaberError(`${label} must be a positive integer`, 2);
  }
  return value as number;
}

function parseProject(value: unknown, index: number): SaberProject {
  if (!isRecord(value)) throw new SaberError(`projects[${index}] must be an object`, 2);
  const name = asString(value.name, `projects[${index}].name`);
  const path = asString(value.path, `projects[${index}].path`);
  if (!identifier.test(name)) throw new SaberError(`projects[${index}].name must be a lowercase identifier`, 2);
  if (path !== `projects/${name}`) {
    throw new SaberError(`projects[${index}].path must equal projects/${name}`, 2);
  }
  const repository = value.repository === undefined ? undefined : asString(value.repository, `projects[${index}].repository`);
  return { name, path, repository };
}

function parseSkillSource(value: unknown, index: number): SaberSkillSource {
  if (!isRecord(value)) throw new SaberError(`skills.sources[${index}] must be an object`, 2);
  const id = asString(value.id, `skills.sources[${index}].id`);
  if (!identifier.test(id)) throw new SaberError(`skills.sources[${index}].id must be a lowercase identifier`, 2);
  const repository = asString(value.repository, `skills.sources[${index}].repository`);
  try {
    const url = new URL(repository);
    if (url.protocol !== "https:") throw new Error();
  } catch {
    throw new SaberError(`skills.sources[${index}].repository must be an https URL`, 2);
  }
  const ref = asString(value.ref, `skills.sources[${index}].ref`);
  if (!Array.isArray(value.include) || !value.include.every((item) => typeof item === "string" && identifier.test(item))) {
    throw new SaberError(`skills.sources[${index}].include must contain lowercase skill identifiers`, 2);
  }
  const include = [...value.include];
  if (new Set(include).size !== include.length) {
    throw new SaberError(`skills.sources[${index}].include must not contain duplicates`, 2);
  }
  return { id, repository, ref, include };
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
  if (raw.schemaVersion !== 2) throw new SaberError("saber.yaml schemaVersion must be 2", 2);
  if (!Array.isArray(raw.projects)) throw new SaberError("saber.yaml projects must be an array", 2);
  const projects = raw.projects.map(parseProject);
  if (new Set(projects.map(({ name }) => name)).size !== projects.length) {
    throw new SaberError("saber.yaml project names must be unique", 2);
  }

  if (!isRecord(raw.skills) || !Array.isArray(raw.skills.sources)) {
    throw new SaberError("saber.yaml skills.sources must be an array", 2);
  }
  const sources = raw.skills.sources.map(parseSkillSource);
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    throw new SaberError("saber.yaml skill source ids must be unique", 2);
  }
  const skillIds = sources.flatMap(({ include }) => include);
  if (new Set(skillIds).size !== skillIds.length) {
    throw new SaberError("saber.yaml skill ids must be unique across sources", 2);
  }

  if (!isRecord(raw.loop)) throw new SaberError("saber.yaml loop must be an object", 2);
  const evidenceBranch = asString(raw.loop.evidenceBranch, "saber.yaml loop.evidenceBranch");
  const maxIterations = asPositiveInteger(raw.loop.maxIterations, "saber.yaml loop.maxIterations");
  const maxNoProgressIterations = asPositiveInteger(raw.loop.maxNoProgressIterations, "saber.yaml loop.maxNoProgressIterations");
  const maxMinutes = asPositiveInteger(raw.loop.maxMinutes, "saber.yaml loop.maxMinutes");

  return {
    schemaVersion: 2,
    projects,
    skills: { sources },
    loop: { evidenceBranch, maxIterations, maxNoProgressIterations, maxMinutes },
  };
}
