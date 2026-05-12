/**
 * Extract text content from uploaded files for model context.
 */

import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';

// Use CDN worker for pdf.js
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

const TEXT_TYPES = [
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
  'application/json', 'application/xml',
];

const CODE_EXTENSIONS = [
  'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
  'css', 'scss', 'sql', 'sh', 'bash', 'yaml', 'yml', 'toml', 'ini',
  'env', 'md', 'mdx', 'txt', 'log', 'csv', 'json', 'xml', 'html',
];

export interface ExtractedFile {
  filename: string;
  text: string;
  pageCount?: number;
}

export async function extractFileText(file: File): Promise<ExtractedFile | null> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  // PDF
  if (file.type === 'application/pdf' || ext === 'pdf') {
    return extractPDF(file);
  }

  // DOCX — Word documents. Extracted via JSZip (we already use it for chat
  // imports) since .docx is a ZIP of XML. Minimal implementation: pull the
  // text runs out of word/document.xml and newline-join paragraphs.
  if (ext === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(file);
  }

  // EPUB — ebook format. Also a ZIP, containing XHTML chapter files. We walk
  // the OPF manifest to reconstruct reading order, then strip HTML tags
  // from each chapter's body and concatenate.
  if (ext === 'epub' || file.type === 'application/epub+zip') {
    return extractEpub(file);
  }

  // Text / code files
  if (TEXT_TYPES.includes(file.type) || CODE_EXTENSIONS.includes(ext)) {
    const text = await file.text();
    return { filename: file.name, text: text.slice(0, 200000) };
  }

  // Unsupported
  return null;
}

async function extractDocx(file: File): Promise<ExtractedFile> {
  const zip = await JSZip.loadAsync(file);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('docx missing word/document.xml');
  const xml = await doc.async('text');

  const paragraphs: string[] = [];
  const paraRe = /<w:p[\s\S]*?<\/w:p>/g;
  const textRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = paraRe.exec(xml)) !== null) {
    const body = pMatch[0];
    const runs: string[] = [];
    let tMatch: RegExpExecArray | null;
    textRe.lastIndex = 0;
    while ((tMatch = textRe.exec(body)) !== null) {
      runs.push(decodeXmlEntities(tMatch[1]));
    }
    paragraphs.push(runs.join(''));
  }
  return { filename: file.name, text: paragraphs.join('\n').slice(0, 200000) };
}

async function extractEpub(file: File): Promise<ExtractedFile> {
  const zip = await JSZip.loadAsync(file);

  // Find the OPF via META-INF/container.xml. The container points at the
  // package document, whose manifest + spine tell us the chapter order.
  const containerFile = zip.file('META-INF/container.xml');
  let opfPath: string | null = null;
  if (containerFile) {
    const containerXml = await containerFile.async('text');
    const rootfile = containerXml.match(/<rootfile[^>]+full-path=["']([^"']+)["']/);
    if (rootfile) opfPath = rootfile[1];
  }

  // Build the chapter list. If we have the OPF, walk its spine in order;
  // otherwise fall back to every XHTML file in the archive (order not
  // guaranteed — better than nothing).
  let chapterPaths: string[] = [];
  if (opfPath) {
    const opfFile = zip.file(opfPath);
    if (opfFile) {
      const opfXml = await opfFile.async('text');
      const manifest = new Map<string, string>();
      const manifestRe = /<item[^>]+id=["']([^"']+)["'][^>]+href=["']([^"']+)["']/g;
      let mm: RegExpExecArray | null;
      while ((mm = manifestRe.exec(opfXml)) !== null) {
        manifest.set(mm[1], mm[2]);
      }
      const spineRe = /<itemref[^>]+idref=["']([^"']+)["']/g;
      let sm: RegExpExecArray | null;
      const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
      while ((sm = spineRe.exec(opfXml)) !== null) {
        const href = manifest.get(sm[1]);
        if (href) chapterPaths.push(opfDir + href);
      }
    }
  }
  if (chapterPaths.length === 0) {
    chapterPaths = Object.keys(zip.files).filter(n => /\.x?html?$/i.test(n));
  }

  const chunks: string[] = [];
  for (const path of chapterPaths) {
    const f = zip.file(path);
    if (!f) continue;
    const html = await f.async('text');
    const text = stripHtmlTags(html);
    if (text.trim()) chunks.push(text.trim());
  }
  return { filename: file.name, text: chunks.join('\n\n').slice(0, 200000) };
}

function stripHtmlTags(html: string): string {
  // Peel the body first so we skip script/style blocks in the head, then
  // drop remaining tags and collapse whitespace. Good enough for prose.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  return decodeXmlEntities(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

async function extractPDF(file: File): Promise<ExtractedFile> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];

  // Extract up to 30 pages
  const maxPages = Math.min(pdf.numPages, 30);
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    if (text.trim()) pages.push(text);
  }

  return {
    filename: file.name,
    text: pages.join('\n\n--- Page Break ---\n\n').slice(0, 200000),
    pageCount: pdf.numPages,
  };
}

export function isExtractableFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return file.type === 'application/pdf'
    || ext === 'pdf'
    || ext === 'docx'
    || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || ext === 'epub'
    || file.type === 'application/epub+zip'
    || TEXT_TYPES.includes(file.type)
    || CODE_EXTENSIONS.includes(ext);
}
