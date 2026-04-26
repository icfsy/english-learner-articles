// Daily scraper: pulls RSS feeds, extracts readable content, writes articles.json.
//
// Output shape (articles.json):
// {
//   "version": 1,
//   "generated_at": <unix ms>,
//   "articles": [
//     {
//       "id": "<sha256(url)[:12]>",
//       "title": "...",
//       "author": "...",
//       "source": "Paul Graham",
//       "url": "...",
//       "content": "<plaintext>",
//       "word_count": 1234,
//       "published_at": <unix ms | null>
//     }
//   ]
// }
//
// Dedupe: if articles.json already exists, prior entries are kept and merged by id.
// New articles go to the front (sorted by published_at desc within each run).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';
import sanitizeHtml from 'sanitize-html';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'articles.json');
const SOURCES_FILE = path.join(ROOT, 'sources.json');

const HEADERS = {
  'User-Agent':
    'english-learner-articles-bot/1.0 (+https://github.com/icfsy/english-learner-articles)',
};

function idFor(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

function htmlToPlainText(html) {
  if (!html) return '';
  // Sanitize: strip everything but text + paragraph breaks.
  const cleaned = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'li', 'ul', 'ol', 'blockquote'],
    allowedAttributes: {},
  });
  // Convert block tags to newlines.
  return cleaned
    .replace(/<\/(p|h[1-4]|li|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

async function fetchAndExtract(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  if (!parsed) throw new Error('Readability failed');
  return {
    title: parsed.title,
    byline: parsed.byline,
    content: htmlToPlainText(parsed.content),
  };
}

async function loadExisting() {
  if (!existsSync(OUT_FILE)) return new Map();
  try {
    const raw = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    const map = new Map();
    for (const a of raw.articles ?? []) map.set(a.id, a);
    return map;
  } catch {
    return new Map();
  }
}

async function processSource(parser, source, existing) {
  console.log(`\n[${source.name}] fetching ${source.rss}`);
  const feed = await parser.parseURL(source.rss);
  const items = (feed.items ?? []).slice(0, source.max ?? 10);
  const out = [];
  for (const item of items) {
    const url = item.link;
    if (!url) continue;
    const id = idFor(url);
    if (existing.has(id)) {
      console.log(`  - skip (already have): ${item.title}`);
      continue;
    }
    try {
      let title = item.title?.trim() ?? '';
      let author = item.creator || item.author || feed.title || source.name;
      let contentHtml =
        item['content:encoded'] || item.content || item.summary || '';
      let content = htmlToPlainText(contentHtml);

      if (source.fetchFullContent || wordCount(content) < 200) {
        try {
          const ext = await fetchAndExtract(url);
          if (ext.content && wordCount(ext.content) > wordCount(content)) {
            content = ext.content;
            if (ext.title) title = ext.title;
            if (ext.byline) author = ext.byline;
          }
        } catch (e) {
          console.warn(`  ! readability failed for ${url}: ${e.message}`);
        }
      }

      if (wordCount(content) < 100) {
        console.log(`  - skip (too short): ${title}`);
        continue;
      }

      const published_at = item.isoDate
        ? new Date(item.isoDate).getTime()
        : item.pubDate
        ? new Date(item.pubDate).getTime()
        : null;

      const article = {
        id,
        title,
        author: author?.trim() || null,
        source: source.name,
        url,
        content,
        word_count: wordCount(content),
        published_at,
      };
      console.log(`  + new: ${title} (${article.word_count} words)`);
      out.push(article);
    } catch (e) {
      console.warn(`  ! error on ${url}: ${e.message}`);
    }
  }
  return out;
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_FILE, 'utf8')).sources;
  const existing = await loadExisting();
  const parser = new Parser({ headers: HEADERS, timeout: 20000 });

  let added = 0;
  for (const source of sources) {
    try {
      const newItems = await processSource(parser, source, existing);
      for (const a of newItems) {
        existing.set(a.id, a);
        added++;
      }
    } catch (e) {
      console.error(`[${source.name}] failed: ${e.message}`);
    }
  }

  // Sort: newest published_at first; null published_at goes to the end.
  const all = [...existing.values()].sort((a, b) => {
    const ap = a.published_at ?? 0;
    const bp = b.published_at ?? 0;
    return bp - ap;
  });

  const output = {
    version: 1,
    generated_at: Date.now(),
    article_count: all.length,
    articles: all,
  };

  await writeFile(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nDone. Added ${added} new, total ${all.length} articles.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
