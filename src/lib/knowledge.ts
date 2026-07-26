import { lstat, readdir } from "node:fs/promises";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import { readTextWithinRoot, resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import { parseMarkdownFrontMatter } from "./frontmatter.js";
import { gitCommand, runSafeProcess, type SafeProcessRunner } from "./git.js";
import {
  customerSourceIndexSchema,
  formatSchemaIssues,
  knowledgeEntrySchema,
  teamContractSchema,
  type CustomerSourceIndex,
  type KnowledgeEntry,
  type TeamContract,
} from "./schemas.js";

export type KnowledgeEntryMetadata = KnowledgeEntry & { path: string };
export type TeamContractMetadata = TeamContract & { path: string };

export type KnowledgeCatalog = {
  entries: ReadonlyMap<string, KnowledgeEntryMetadata>;
  teamContracts: ReadonlyMap<string, TeamContractMetadata>;
  customerSources: CustomerSourceIndex;
};

export type RepositoryLocation = { id: string; path: string };

export type KnowledgeRisk = {
  code: "possible-stale" | "source-unavailable";
  entryId: string;
  source: string;
};

export type KnowledgeRequest = {
  repositories: readonly string[];
  modules: readonly string[];
  subjects: readonly string[];
  ids: readonly string[];
  limit: number;
  repositoryPaths: readonly RepositoryLocation[];
};

export type KnowledgeResolution = {
  entries: Array<{ id: string; path: string; reason: "explicit-id" | "scope-match" | "dependency" | "fallback" | "team-contract" }>;
  customerSources: Array<{ repository: string; path: string; reason: "repository-scope" | "module-scope" }>;
  risks: KnowledgeRisk[];
  uncovered: string[];
};

type CatalogLoad = KnowledgeCatalog & { errors: string[] };

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

async function requireDirectory(repositoryRoot: string, path: string, errors: string[]): Promise<boolean> {
  try {
    const target = await resolveExistingPathWithinRoot(repositoryRoot, path);
    const status = await lstat(target);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      errors.push(`${path} must be a directory without symbolic links`);
      return false;
    }
    return true;
  } catch (error: unknown) {
    if (isMissing(error) || error instanceof SaberError) {
      errors.push(`missing knowledge directory ${path}`);
      return false;
    }
    errors.push(`could not inspect knowledge directory ${path}`);
    return false;
  }
}

async function listKnowledgeMarkdownPaths(repositoryRoot: string, relativeDirectory: string, errors: string[]): Promise<string[]> {
  if (!(await requireDirectory(repositoryRoot, relativeDirectory, errors))) return [];

  const paths: string[] = [];
  const pending = [relativeDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    try {
      const entries = await readdir(await resolveExistingPathWithinRoot(repositoryRoot, current), { withFileTypes: true });
      for (const entry of entries) {
        const path = `${current}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          errors.push(`${path} must not be a symbolic link`);
        } else if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
          paths.push(path);
        }
      }
    } catch {
      errors.push(`could not inspect knowledge directory ${current}`);
    }
  }
  return paths.sort();
}

async function readCustomerSourceIndex(repositoryRoot: string, errors: string[]): Promise<CustomerSourceIndex> {
  const path = "customer-sources/index.yaml";
  try {
    const source = parse(await readTextWithinRoot(repositoryRoot, path));
    const result = customerSourceIndexSchema.safeParse(source);
    if (result.success) return result.data;
    errors.push(...formatSchemaIssues(result.error).map((issue) => `${path}: ${issue}`));
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      errors.push(`${path}: ${error.message}`);
    } else {
      errors.push(`could not read ${path}`);
    }
  }
  return { schemaVersion: 1, sources: [] };
}

function validateDependencies(entries: ReadonlyMap<string, KnowledgeEntryMetadata>, errors: string[]): void {
  for (const entry of entries.values()) {
    for (const dependency of entry.dependsOn) {
      if (!entries.has(dependency)) {
        errors.push(`${entry.path} depends on missing knowledge entry ${dependency}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, trail: readonly string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`knowledge dependency cycle ${[...trail, id].join(" -> ")}`);
      return;
    }
    const entry = entries.get(id);
    if (entry === undefined) return;
    visiting.add(id);
    for (const dependency of entry.dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of entries.keys()) visit(id, []);
}

async function loadCatalog(repositoryRoot: string): Promise<CatalogLoad> {
  const errors: string[] = [];
  const teamPaths = await listKnowledgeMarkdownPaths(repositoryRoot, "team-contracts", errors);
  const paths = await listKnowledgeMarkdownPaths(repositoryRoot, "project-knowledge", errors);
  await requireDirectory(repositoryRoot, "customer-sources", errors);
  const customerSources = await readCustomerSourceIndex(repositoryRoot, errors);
  const entries = new Map<string, KnowledgeEntryMetadata>();
  const teamContracts = new Map<string, TeamContractMetadata>();

  for (const path of teamPaths) {
    try {
      const parsed = parseMarkdownFrontMatter(await readTextWithinRoot(repositoryRoot, path));
      const result = teamContractSchema.safeParse(parsed.attributes);
      if (!result.success) {
        errors.push(...formatSchemaIssues(result.error).map((issue) => `${path}: ${issue}`));
        continue;
      }
      if (teamContracts.has(result.data.id)) {
        errors.push(`duplicate team contract ${result.data.id}`);
        continue;
      }
      teamContracts.set(result.data.id, { ...result.data, path });
    } catch (error: unknown) {
      if (error instanceof SaberError) errors.push(`${path}: ${error.message}`);
      else errors.push(`could not read team contract ${path}`);
    }
  }

  for (const path of paths) {
    try {
      const parsed = parseMarkdownFrontMatter(await readTextWithinRoot(repositoryRoot, path));
      const result = knowledgeEntrySchema.safeParse(parsed.attributes);
      if (!result.success) {
        errors.push(...formatSchemaIssues(result.error).map((issue) => `${path}: ${issue}`));
        continue;
      }
      if (entries.has(result.data.id)) {
        errors.push(`duplicate knowledge entry ${result.data.id}`);
        continue;
      }
      entries.set(result.data.id, { ...result.data, path });
    } catch (error: unknown) {
      if (error instanceof SaberError) errors.push(`${path}: ${error.message}`);
      else errors.push(`could not read knowledge entry ${path}`);
    }
  }

  validateDependencies(entries, errors);
  return { entries, teamContracts, customerSources, errors };
}

/** Return every metadata record after checking that the knowledge tree is internally consistent. */
export async function collectKnowledgeCatalog(repositoryRoot: string): Promise<KnowledgeCatalog> {
  const catalog = await loadCatalog(repositoryRoot);
  if (catalog.errors.length > 0) throw new SaberError(catalog.errors[0]!, 2);
  return { entries: catalog.entries, teamContracts: catalog.teamContracts, customerSources: catalog.customerSources };
}

/** Validate only structure, IDs and dependency references; knowledge bodies are never returned to callers. */
export async function validateKnowledgeAssets(repositoryRoot: string): Promise<string[]> {
  return (await loadCatalog(repositoryRoot)).errors;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  const candidates = new Set(right.map(normalize));
  return left.some((value) => candidates.has(normalize(value)));
}

function subjectMatches(subjects: readonly string[], terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  return terms.some((term) => subjects.some((subject) => {
    const normalizedTerm = normalize(term);
    const normalizedSubject = normalize(subject);
    return normalizedSubject.includes(normalizedTerm) || normalizedTerm.includes(normalizedSubject);
  }));
}

function matchesScope(entry: KnowledgeEntryMetadata, request: KnowledgeRequest): boolean {
  const repositoryMatch = request.repositories.length === 0 || overlaps(entry.appliesTo.repositories, request.repositories);
  const moduleMatch = request.modules.length === 0 || overlaps(entry.appliesTo.modules, request.modules);
  return repositoryMatch && moduleMatch && subjectMatches(entry.subjects, request.subjects);
}

function toResolutionEntry(
  entry: KnowledgeEntryMetadata,
  reason: "explicit-id" | "scope-match" | "dependency" | "fallback",
): KnowledgeResolution["entries"][number] {
  return { id: entry.id, path: entry.path, reason };
}

function toTeamContractResolutionEntry(entry: TeamContractMetadata): KnowledgeResolution["entries"][number] {
  return { id: entry.id, path: entry.path, reason: "team-contract" };
}

function selectDirectMatches(catalog: KnowledgeCatalog, request: KnowledgeRequest): KnowledgeResolution["entries"] {
  const selected: KnowledgeResolution["entries"] = [];
  const selectedIds = new Set<string>();
  for (const id of request.ids) {
    const entry = catalog.entries.get(id);
    if (entry !== undefined && !selectedIds.has(id)) {
      selected.push(toResolutionEntry(entry, "explicit-id"));
      selectedIds.add(id);
    }
  }
  for (const entry of [...catalog.entries.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (selected.length >= request.limit) break;
    if (!selectedIds.has(entry.id) && matchesScope(entry, request)) {
      selected.push(toResolutionEntry(entry, "scope-match"));
      selectedIds.add(entry.id);
    }
  }
  return selected.slice(0, request.limit);
}

function expandOneDependencyHop(catalog: KnowledgeCatalog, selected: KnowledgeResolution["entries"], limit: number): KnowledgeResolution["entries"] {
  const result = [...selected];
  const selectedIds = new Set(result.map((entry) => entry.id));
  for (const entry of selected) {
    const source = catalog.entries.get(entry.id);
    if (source === undefined) continue;
    for (const dependencyId of source.dependsOn) {
      if (result.length >= limit) return result;
      const dependency = catalog.entries.get(dependencyId);
      if (dependency !== undefined && !selectedIds.has(dependencyId)) {
        result.push(toResolutionEntry(dependency, "dependency"));
        selectedIds.add(dependencyId);
      }
    }
  }
  return result;
}

function fallbackScore(entry: KnowledgeEntryMetadata, terms: readonly string[]): number {
  const values = [...entry.subjects, entry.kind, ...entry.appliesTo.modules].map(normalize);
  return terms.reduce((score, term) => score + (values.some((value) => value.includes(normalize(term))) ? 1 : 0), 0);
}

function selectFallbackMatches(catalog: KnowledgeCatalog, request: KnowledgeRequest): KnowledgeResolution["entries"] {
  return [...catalog.entries.values()]
    .map((entry) => ({ entry, score: fallbackScore(entry, request.subjects) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
    .slice(0, request.limit)
    .map(({ entry }) => toResolutionEntry(entry, "fallback"));
}

function selectTeamContracts(catalog: KnowledgeCatalog, request: KnowledgeRequest, remaining: number): KnowledgeResolution["entries"] {
  if (remaining <= 0 || request.subjects.length === 0) return [];
  return [...catalog.teamContracts.values()]
    .filter((entry) => subjectMatches(entry.subjects, request.subjects))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, Math.min(2, remaining))
    .map(toTeamContractResolutionEntry);
}

function matchingCustomerSourceRecords(catalog: KnowledgeCatalog, request: KnowledgeRequest): CustomerSourceIndex["sources"] {
  return catalog.customerSources.sources.filter((source) => {
    if (request.repositories.length > 0 && !request.repositories.map(normalize).includes(normalize(source.repository))) {
      return false;
    }
    if (request.modules.length > 0 && !overlaps(source.appliesTo.modules, request.modules)) {
      return false;
    }
    return true;
  });
}

function renderCustomerSources(
  records: readonly CustomerSourceIndex["sources"][number][],
  request: KnowledgeRequest,
): KnowledgeResolution["customerSources"] {
  return records.map((source) => {
    const reason = request.modules.length > 0 && overlaps(source.appliesTo.modules, request.modules)
      ? "module-scope"
      : "repository-scope";
    return { repository: source.repository, path: source.path, reason };
  });
}

/** Inspect Git evidence for selected knowledge sources without exposing source contents. */
export async function checkKnowledgeSources(
  repositoryRoot: string,
  entries: readonly KnowledgeEntryMetadata[],
  repositories: readonly RepositoryLocation[],
  runner: SafeProcessRunner = runSafeProcess,
): Promise<KnowledgeRisk[]> {
  const paths = new Map(repositories.map((repository) => [repository.id, repository.path]));
  const risks: KnowledgeRisk[] = [];
  for (const entry of entries) {
    for (const source of entry.sources) {
      const label = `${source.repository}:${source.path}`;
      const projectPath = paths.get(source.repository);
      if (projectPath === undefined) {
        risks.push({ code: "source-unavailable", entryId: entry.id, source: label });
        continue;
      }
      let projectRoot: string;
      try {
        projectRoot = resolveWithinRoot(repositoryRoot, projectPath);
      } catch {
        risks.push({ code: "source-unavailable", entryId: entry.id, source: label });
        continue;
      }
      try {
        const revision = await runner(gitCommand(["cat-file", "-e", `${source.revision}^{commit}`], projectRoot));
        if (revision.exitCode !== 0) {
          risks.push({ code: "source-unavailable", entryId: entry.id, source: label });
          continue;
        }
        const comparisons = [
          ["diff", "--quiet", `${source.revision}..HEAD`, "--", source.path],
          ["diff", "--quiet", "--", source.path],
          ["diff", "--cached", "--quiet", "--", source.path],
        ];
        let stale = false;
        let unavailable = false;
        for (const args of comparisons) {
          const changed = await runner(gitCommand(args, projectRoot));
          if (changed.exitCode === 1) stale = true;
          else if (changed.exitCode !== 0) {
            unavailable = true;
            break;
          }
        }
        if (unavailable) risks.push({ code: "source-unavailable", entryId: entry.id, source: label });
        else if (stale) risks.push({ code: "possible-stale", entryId: entry.id, source: label });
      } catch {
        risks.push({ code: "source-unavailable", entryId: entry.id, source: label });
      }
    }
  }
  return risks;
}

/** Select only metadata paths and reasons. Callers decide whether to read the chosen Markdown bodies. */
export async function resolveKnowledge(
  repositoryRoot: string,
  request: KnowledgeRequest,
  runner: SafeProcessRunner = runSafeProcess,
): Promise<KnowledgeResolution> {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 20) {
    throw new SaberError("knowledge limit must be between 1 and 20", 2);
  }
  const catalog = await collectKnowledgeCatalog(repositoryRoot);
  const matchingCustomerSources = matchingCustomerSourceRecords(catalog, request);
  const selectedCustomerSources = matchingCustomerSources.slice(0, request.limit);
  const remainingLimit = request.limit - selectedCustomerSources.length;
  const knowledgeRequest = { ...request, limit: remainingLimit };
  const direct = selectDirectMatches(catalog, knowledgeRequest);
  const projectEntries = direct.length > 0
    ? expandOneDependencyHop(catalog, direct, remainingLimit)
    : selectFallbackMatches(catalog, knowledgeRequest);
  const entries = [...projectEntries, ...selectTeamContracts(catalog, request, remainingLimit - projectEntries.length)];
  const entryMetadata = projectEntries.map((entry) => catalog.entries.get(entry.id)!).filter((entry): entry is KnowledgeEntryMetadata => entry !== undefined);
  const customerEntries: KnowledgeEntryMetadata[] = selectedCustomerSources.map((source) => ({
    id: `customer-rule:${source.repository}:${source.path}`,
    path: "customer-sources/index.yaml",
    layer: "project",
    kind: "business-rule",
    assertion: "implemented",
    appliesTo: source.appliesTo,
    subjects: [],
    dependsOn: [],
    sources: [{ repository: source.repository, path: source.path, revision: source.revision }],
    verifiedAt: "1970-01-01",
  }));
  const selectedIds = new Set(entries.map((entry) => entry.id));
  const uncovered = [
    ...request.ids.filter((id) => !selectedIds.has(id)),
    ...request.subjects.filter((subject) => !entryMetadata.some((entry) => subjectMatches(entry.subjects, [subject]))),
    ...matchingCustomerSources.slice(request.limit).map((source) => `customer-rule:${source.repository}:${source.path}`),
  ];
  return {
    entries,
    customerSources: renderCustomerSources(selectedCustomerSources, request),
    risks: await checkKnowledgeSources(repositoryRoot, [...entryMetadata, ...customerEntries], request.repositoryPaths, runner),
    uncovered: [...new Set(uncovered)],
  };
}
