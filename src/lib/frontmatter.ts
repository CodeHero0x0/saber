import { parse, stringify } from "yaml";

import { SaberError } from "./errors.js";

export type ParsedMarkdown = {
  attributes: unknown;
  body: string;
};

const openingBoundary = "---\n";
const closingBoundary = "\n---\n";

/** Split exactly one leading YAML front matter block without altering the Markdown body. */
export function parseMarkdownFrontMatter(content: string): ParsedMarkdown {
  if (!content.startsWith(openingBoundary)) {
    throw new SaberError("Markdown front matter must start on the first line", 2);
  }

  const closingIndex = content.indexOf(closingBoundary, openingBoundary.length);
  if (closingIndex < 0) {
    throw new SaberError("Markdown front matter is not closed", 2);
  }

  try {
    return {
      attributes: parse(content.slice(openingBoundary.length, closingIndex)),
      body: content.slice(closingIndex + closingBoundary.length),
    };
  } catch {
    throw new SaberError("could not parse Markdown front matter", 2);
  }
}

/** Render a new front matter block while preserving the supplied Markdown body verbatim. */
export function renderMarkdownFrontMatter(attributes: unknown, body: string): string {
  return `---\n${stringify(attributes)}---\n${body}`;
}
