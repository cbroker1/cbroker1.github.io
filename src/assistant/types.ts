/** Shared corpus contract between the build-time indexer and the browser client. */

export type SourceType = 'project' | 'article' | 'experience' | 'about' | 'profile' | 'links';

export interface SourceLink {
  label: string;
  href: string;
}

export interface CorpusDoc {
  /** Stable id, e.g. `project:ask-veno`. */
  id: string;
  title: string;
  type: SourceType;
  /** Canonical on-site URL, or null for curated knowledge with no page of its own. */
  url: string | null;
  tags: string[];
  /** ISO date, when the source has one. */
  date?: string;
  /** Deterministic links rendered under an answer. First entry is the primary. */
  links: SourceLink[];
}

export interface CorpusChunk {
  /** Index into `Corpus.docs`. */
  d: number;
  /** Heading path within the document, e.g. "Overview" or "Retrieval > Hybrid". */
  h: string;
  /** Plain text, markdown already stripped. */
  t: string;
}

export interface Corpus {
  version: number;
  docs: CorpusDoc[];
  chunks: CorpusChunk[];
}
