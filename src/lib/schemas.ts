import { z, type ZodError } from "zod";

const workitemId = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u, "must be a short Jira key or descriptive title");
const entryId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u, "must be a lowercase knowledge identifier");
const nonEmptyText = z.string().trim().min(1).max(4_000);
const sourceKinds = ["chat", "jira", "document", "manual"] as const;

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const timestampSchema = z.string().refine(isIsoTimestamp, "must be an ISO timestamp");
const dateSchema = z.string().refine(isIsoDate, "must be an ISO date");

const sourceSchema = z.object({
  kind: z.enum(sourceKinds),
  origin: nonEmptyText.max(1_000).optional(),
  capturedAt: timestampSchema,
  references: z.array(nonEmptyText.max(1_000)).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.references).size !== value.references.length) {
    context.addIssue({ code: "custom", path: ["references"], message: "must not contain duplicates" });
  }
});

const repositoryReferenceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  path: z.string().min(1).max(512).refine(
    (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
    "must be a safe relative path",
  ),
  repository: z.string().url().optional(),
}).strict();

const dependencyRequirementSchema = z.object({
  type: z.enum(["workitem", "knowledge", "external"]),
  id: z.string().min(1).max(160),
  reason: nonEmptyText.max(1_000),
}).strict();

const dependencySetSchema = z.object({
  requires: z.array(dependencyRequirementSchema).default([]),
  blockedBy: z.array(z.string().min(1).max(160)).default([]),
}).strict().superRefine((value, context) => {
  const ids = value.requires.map((dependency) => `${dependency.type}:${dependency.id}`);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["requires"], message: "must not contain duplicate dependency targets" });
  }
  if (new Set(value.blockedBy).size !== value.blockedBy.length) {
    context.addIssue({ code: "custom", path: ["blockedBy"], message: "must not contain duplicates" });
  }
});

const decisionSchema = z.object({
  id: z.string().regex(/^DEC-[0-9]{3,}$/u),
  summary: nonEmptyText.max(2_000),
  owner: nonEmptyText.max(240),
  decidedAt: dateSchema,
}).strict();

const knowledgeImpactSchema = z.object({
  conclusion: z.enum(["updated", "no-change", "pending-user-decision"]),
  entries: z.array(z.object({
    id: entryId,
    action: z.enum(["updated", "verified-no-change", "pending-user-decision"]),
    evidence: nonEmptyText.max(1_000),
  }).strict()).default([]),
}).strict();

const riskSchema = z.object({
  id: z.string().regex(/^RISK-[0-9]{3,}$/u),
  summary: nonEmptyText.max(2_000),
  status: z.enum(["open", "accepted", "resolved"]),
}).strict();

export const workitemFrontMatterSchema = z.object({
  schemaVersion: z.literal(1),
  id: workitemId,
  title: nonEmptyText.max(240),
  source: sourceSchema,
  repositories: z.array(repositoryReferenceSchema).default([]),
  dependencies: dependencySetSchema.default({ requires: [], blockedBy: [] }),
  decisions: z.array(decisionSchema).default([]),
  knowledgeImpact: knowledgeImpactSchema,
  risks: z.array(riskSchema).default([]),
}).strict().superRefine((value, context) => {
  const repositories = value.repositories.map((repository) => repository.id);
  if (new Set(repositories).size !== repositories.length) {
    context.addIssue({ code: "custom", path: ["repositories"], message: "must not contain duplicate repository ids" });
  }
});

const appliesToSchema = z.object({
  repositories: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).min(1),
  modules: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).min(1),
}).strict();

const knowledgeSourceSchema = z.object({
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  path: z.string().min(1).max(512).refine(
    (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
    "must be a safe relative path",
  ),
  revision: z.string().regex(/^[0-9a-f]{7,64}$/u, "must be a Git revision"),
}).strict();

export const knowledgeEntrySchema = z.object({
  id: entryId,
  layer: z.literal("project"),
  kind: z.enum(["module", "business-rule", "design", "interface", "data-model", "dependency"]),
  assertion: z.enum(["implemented", "accepted-design", "assumption", "superseded"]),
  appliesTo: appliesToSchema,
  subjects: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u)).min(1),
  dependsOn: z.array(entryId).default([]),
  sources: z.array(knowledgeSourceSchema).default([]),
  verifiedAt: dateSchema,
}).strict();

export const teamContractSchema = z.object({
  id: z.string().regex(/^tc-[a-z][a-z0-9-]{0,79}$/u, "must be a lowercase team contract identifier"),
  layer: z.literal("team"),
  kind: z.enum(["engineering-practice", "quality-rule", "architecture-principle"]),
  subjects: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u)).min(1),
  verifiedAt: dateSchema,
}).strict();

const customerSourceSchema = z.object({
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  path: z.string().min(1).max(512).refine(
    (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
    "must be a safe relative path",
  ),
  appliesTo: appliesToSchema,
  revision: z.string().regex(/^[0-9a-f]{7,64}$/u, "must be a Git revision"),
}).strict();

export const customerSourceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(customerSourceSchema).default([]),
}).strict();

export type WorkitemFrontMatter = z.infer<typeof workitemFrontMatterSchema>;
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;
export type TeamContract = z.infer<typeof teamContractSchema>;
export type CustomerSourceIndex = z.infer<typeof customerSourceIndexSchema>;

/** Format Zod issues without including source text or other untrusted content. */
export function formatSchemaIssues(error: ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const location = issue.path.length === 0 ? "front matter" : issue.path.join(".");
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${location}.${key}: is not allowed`);
    }
    return [`${location}: ${issue.message}`];
  });
}
