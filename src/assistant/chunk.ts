/**
 * Markdown -> retrieval chunks. Build-time only.
 *
 * Chunks are cut on heading boundaries first (headings are strong topical
 * signals in these documents) then packed to a target word count so a handful
 * of them fit comfortably in a 360M model's context window.
 */

const TARGET_WORDS = 110;
const MAX_WORDS = 190;
const MIN_WORDS = 25;

/** Strips markdown to readable prose, keeping only what is useful to retrieve on. */
function stripMarkdown(markdown: string): string {
  return markdown
    // Fenced code blocks: commands and JSON add noise, not evidence.
    .replace(/```[\s\S]*?```/g, ' ')
    // Images: keep the alt text, which is written as descriptive prose on this site.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links: keep the label, drop the target (URLs are rendered from metadata, never prose).
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Raw HTML tags (the about page embeds an image collage).
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/^\s*\|/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^\s*[-:| ]{5,}\s*$/gm, ' ')
    // Horizontal rules (`---`, `***`) otherwise survive into the middle of prose.
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    // Emphasis only: a bare `_` sweep would turn `word_timestamps` into an
    // unsearchable blob, and these documents are full of snake_case identifiers.
    .replace(/(^|[\s([])_([^_\n]+)_(?=[\s).,;:!?\]]|$)/g, '$1$2')
    .replace(/[*`]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Section {
  heading: string;
  body: string;
}

function splitSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ heading, body });
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence && /^(#{2,4})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function packParagraphs(paragraphs: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join(' ').trim());
    current = [];
    words = 0;
  };

  for (const paragraph of paragraphs) {
    const count = paragraph.split(/\s+/).length;
    if (count > MAX_WORDS) {
      flush();
      // Oversized paragraph: cut on sentence boundaries rather than mid-thought.
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      let piece: string[] = [];
      let pieceWords = 0;
      for (const sentence of sentences) {
        piece.push(sentence);
        pieceWords += sentence.split(/\s+/).length;
        if (pieceWords >= TARGET_WORDS) {
          chunks.push(piece.join(' ').trim());
          piece = [];
          pieceWords = 0;
        }
      }
      if (piece.length) chunks.push(piece.join(' ').trim());
      continue;
    }
    if (words + count > MAX_WORDS) flush();
    current.push(paragraph);
    words += count;
    if (words >= TARGET_WORDS) flush();
  }
  flush();

  // Fold runt chunks back into their neighbour so no chunk is too small to stand alone.
  return chunks.reduce<string[]>((acc, chunk) => {
    const short = chunk.split(/\s+/).length < MIN_WORDS;
    if (short && acc.length) acc[acc.length - 1] = `${acc[acc.length - 1]} ${chunk}`;
    else acc.push(chunk);
    return acc;
  }, []);
}

export interface TextChunk {
  heading: string;
  text: string;
}

export function chunkMarkdown(markdown: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const section of splitSections(markdown)) {
    const prose = stripMarkdown(section.body);
    if (!prose) continue;
    const paragraphs = prose
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, ' ').trim())
      .filter(Boolean);
    for (const text of packParagraphs(paragraphs)) {
      if (text.split(/\s+/).length < 8) continue;
      chunks.push({ heading: section.heading, text });
    }
  }
  return chunks;
}
