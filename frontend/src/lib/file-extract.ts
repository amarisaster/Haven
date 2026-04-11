/**
 * Extract text content from uploaded files for model context.
 */

import * as pdfjsLib from 'pdfjs-dist';

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

  // Text / code files
  if (TEXT_TYPES.includes(file.type) || CODE_EXTENSIONS.includes(ext)) {
    const text = await file.text();
    return { filename: file.name, text: text.slice(0, 50000) };
  }

  // Unsupported
  return null;
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
    text: pages.join('\n\n--- Page Break ---\n\n').slice(0, 50000),
    pageCount: pdf.numPages,
  };
}

export function isExtractableFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return file.type === 'application/pdf'
    || ext === 'pdf'
    || TEXT_TYPES.includes(file.type)
    || CODE_EXTENSIONS.includes(ext);
}
