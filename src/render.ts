// Markdown → HTML für die Webview. Jeder Text trägt seinen Datei-Offset (data-s), unteilbare
// Stellen ihren Bereich (data-a="start,end"), Marker ihre Position (data-m) und Blöcke ihren Bereich.

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { Marker, scanMarkers, scanCode, countMarkers, Stats, isSuggestion, DEFAULT_COLORS } from './criticmarkup';
import { createMd, layoutInline, OffsetMap, stripFrontmatter, walkBlocks } from './mapping';

export interface RenderOptions {
  defaultColor: string;
  /** konfigurierte Farbnamen (für Marker in Codeblöcken) */
  colors?: string[];
  /** relative Bildpfade → Webview-URI */
  resolveImage?: (src: string) => string;
}

export interface MarkerView {
  id: number;
  kind: Marker['kind'];
  start: number;
  end: number;
  color?: string;
  author?: string;
  comment?: string;
  page?: string;
  ink?: string;
  obsidian?: boolean;
  suggestion: boolean;
}

export interface RenderResult {
  html: string;
  markers: MarkerView[];
  stats: Stats;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let sharedMd: MarkdownIt | null = null;
function getMd(): MarkdownIt {
  if (sharedMd) return sharedMd;
  const md = createMd();
  const wrapRo = (name: string) => {
    const orig = md.renderer.rules[name]!;
    md.renderer.rules[name] = (tokens, idx, opts, env, self) =>
      `<div class="ro" contenteditable="false">${tokens[idx].meta?.html ?? orig(tokens, idx, opts, env, self)}</div>`;
  };
  wrapRo('fence');
  wrapRo('code_block');
  md.renderer.rules.table_open = () => '<div class="ro" contenteditable="false"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  md.renderer.rules.html_block = (tokens, idx) => {
    const c = tokens[idx].content;
    const page = /^<!--\s*page\s+(\d+)\s*-->\s*$/i.exec(c.trim());
    if (page) return `<div class="page-mark" contenteditable="false" data-page="${page[1]}">S. ${page[1]}</div>\n`;
    if (/^<!--[\s\S]*-->\s*$/.test(c.trim())) return '';
    return `<div class="ro" contenteditable="false">${c}</div>`;
  };
  md.renderer.rules.mapped = (tokens, idx) => tokens[idx].content;
  // Marker in nicht zuordenbaren Stellen: als Text zeigen statt zu verschlucken
  md.renderer.rules.critic = (tokens, idx) => esc(tokens[idx].content);
  const imageRule = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src');
    if (src && env?.resolveImage) t.attrSet('src', env.resolveImage(src));
    return imageRule(tokens, idx, opts, env, self);
  };
  sharedMd = md;
  return md;
}

interface Ctx {
  md: MarkdownIt;
  env: { resolveImage?: (s: string) => string };
  opts: RenderOptions;
  markers: MarkerView[];
}

function renderToken(ctx: Ctx, t: Token): string {
  return ctx.md.renderer.renderInline([t], ctx.md.options, ctx.env);
}

/** Inline-Inhalt mit Offsets rendern. `map` bildet Offsets in `src` auf Datei-Offsets ab. */
function renderInlineMapped(ctx: Ctx, children: Token[], src: string, map: OffsetMap): string {
  const lay = layoutInline(children, src);
  let html = '';
  let inAutolink = false;
  for (let i = 0; i < lay.items.length; i++) {
    const { token: t, start, end } = lay.items[i];
    const ok = start >= 0;
    switch (t.type) {
      case 'text':
        if (inAutolink) html += esc(t.content);
        else html += ok ? `<span data-s="${map(start)}">${esc(t.content)}</span>` : `<span>${esc(t.content)}</span>`;
        break;
      case 'text_special':
        html += ok ? `<span data-a="${map(start)},${map(end)}">${esc(t.content)}</span>` : esc(t.content);
        break;
      case 'softbreak':
        html += ok ? `<span data-a="${map(start)},${map(end)}">\n</span>` : '\n';
        break;
      case 'hardbreak':
        html += ok ? `<br data-a="${map(start)},${map(end)}">` : '<br>';
        break;
      case 'code_inline':
        html += ok ? `<code data-a="${map(start)},${map(end)}">${esc(t.content)}</code>` : renderToken(ctx, t);
        break;
      case 'image':
        html += ok
          ? `<span class="img" data-a="${map(start)},${map(end)}" contenteditable="false">${renderToken(ctx, t)}</span>`
          : renderToken(ctx, t);
        break;
      case 'html_inline':
        html += ok ? `<span data-a="${map(start)},${map(end)}">${t.content}</span>` : t.content;
        break;
      case 'link_open':
        if (t.markup === 'autolink') {
          inAutolink = true;
          html += renderToken(ctx, t).replace('<a ', `<a data-a="${ok ? map(start) : ''},${findAutolinkEnd(lay, i, map)}" `);
        } else html += renderToken(ctx, t);
        break;
      case 'link_close':
        inAutolink = false;
        html += renderToken(ctx, t);
        break;
      case 'critic':
        html += renderMarker(ctx, t.meta as Marker, src, map);
        break;
      default:
        html += renderToken(ctx, t);
    }
  }
  return html;
}

function findAutolinkEnd(lay: ReturnType<typeof layoutInline>, i: number, map: OffsetMap): string {
  for (let k = i + 1; k < lay.items.length; k++)
    if (lay.items[k].token.type === 'link_close') return lay.items[k].end >= 0 ? String(map(lay.items[k].end)) : '';
  return '';
}

function renderPartMd(ctx: Ctx, src: string, s: number, e: number, map: OffsetMap): string {
  const inner = src.slice(s, e);
  if (!inner) return `<span data-s="${map(s)}"></span>`;
  const children = ctx.md.parseInline(inner, ctx.env)[0]?.children ?? [];
  return renderInlineMapped(ctx, children, inner, (i) => map(s + i));
}

/** Text ohne Markdown (Code): eine Zeile pro Span, Zeilenumbrüche als unteilbare Stellen. */
function renderPlain(src: string, s: number, e: number, map: OffsetMap): string {
  if (s >= e) return `<span data-s="${map(s)}"></span>`;
  let html = '';
  let i = s;
  while (i < e) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl < 0 || nl >= e ? e : nl;
    if (lineEnd > i) html += `<span data-s="${map(i)}">${esc(src.slice(i, lineEnd))}</span>`;
    if (lineEnd < e) html += `<span data-a="${map(lineEnd)},${map(lineEnd + 1)}">\n</span>`;
    i = lineEnd + 1;
  }
  return html;
}

function renderMarker(ctx: Ctx, m: Marker, src: string, map: OffsetMap, plain = false): string {
  const renderPart = plain
    ? (_c: Ctx, sr: string, a: number, b: number, mp: OffsetMap) => renderPlain(sr, a, b, mp)
    : renderPartMd;
  const start = map(m.start);
  const end = map(m.end);
  const c = m.comment;
  const color = c?.color || ctx.opts.defaultColor;
  const view: MarkerView = {
    id: start,
    kind: m.kind,
    start,
    end,
    suggestion: isSuggestion(m),
    obsidian: m.obsidian,
  };
  if (m.kind === 'highlight' || m.kind === 'comment') {
    view.color = color;
    if (c) {
      view.author = c.author;
      view.comment = c.text;
      view.page = c.page;
      view.ink = c.ink;
    }
  }
  ctx.markers.push(view);
  const attrs = `data-m="${start}" data-kind="${m.kind}" data-from="${start}" data-to="${end}"`;
  switch (m.kind) {
    case 'insert':
      return `<ins class="cm cm-ins" ${attrs}>${renderPart(ctx, src, m.textStart, m.textEnd, map)}</ins>`;
    case 'delete':
      return `<del class="cm cm-del" ${attrs}>${renderPart(ctx, src, m.textStart, m.textEnd, map)}</del>`;
    case 'subst':
      return (
        `<span class="cm cm-sub" ${attrs}><del>${renderPart(ctx, src, m.textStart, m.textEnd, map)}</del>` +
        `<ins>${renderPart(ctx, src, m.newStart!, m.newEnd!, map)}</ins></span>`
      );
    case 'highlight': {
      const hasText = !!c?.text.trim() || !!c?.ink;
      return (
        `<mark class="cm cm-hl${hasText ? ' has-comment' : ''}" ${attrs} data-color="${esc(color)}" style="--hl: var(--c-${esc(color)}, var(--c-${esc(ctx.opts.defaultColor)}))">` +
        `${renderPart(ctx, src, m.textStart, m.textEnd, map)}</mark>`
      );
    }
    case 'comment':
      return `<span class="cm cm-com" ${attrs} data-color="${esc(color)}" style="--hl: var(--c-${esc(color)}, var(--c-${esc(ctx.opts.defaultColor)}))" contenteditable="false" title="${esc(c?.text ?? '')}">${c?.ink ? '✍︎' : '💬'}</span>`;
  }
}

/** Codeblock mit Offsets und Code-Markern (nur Hervorhebungen/Kommentare). */
function renderCode(ctx: Ctx, tok: Token, content: string, map: OffsetMap, id: number): string {
  const markers = scanCode(content, 0, content.length, ctx.opts.colors ?? DEFAULT_COLORS);
  let html = '';
  let pos = 0;
  for (const m of markers) {
    html += renderPlain(content, pos, m.start, map);
    html += renderMarker(ctx, m, content, map, true);
    pos = m.end;
  }
  html += renderPlain(content, pos, content.length, map);
  const lang = tok.type === 'fence' ? tok.info.trim().split(/\s+/)[0] : '';
  const cls = lang ? ` class="language-${esc(lang)}"` : '';
  return (
    `<pre><code${cls}><span class="blk code" data-b="${id}" data-from="${map(0)}" data-to="${map(content.length)}">` +
    `${html}\n</span></code></pre>\n`
  );
}

export function renderDocument(text: string, opts: RenderOptions): RenderResult {
  const md = getMd();
  const { body, frontmatter } = stripFrontmatter(text);
  const env = { resolveImage: opts.resolveImage };
  const tokens = md.parse(body, env);
  const ctx: Ctx = { md, env, opts, markers: [] };
  let blockId = 0;
  walkBlocks(
    text,
    tokens,
    (tok, map, kind) => {
      let inner: string;
      if (!map) {
        inner = `<span class="blk ro-inline">${md.renderer.renderInline(tok.children ?? [], md.options, env)}</span>`;
      } else {
        const from = map(0);
        const to = map(tok.content.length);
        inner =
          `<span class="blk${kind === 'table' ? ' tbl' : ''}" data-b="${blockId++}" data-from="${from}" data-to="${to}">` +
          renderInlineMapped(ctx, tok.children ?? [], tok.content, map) +
          `</span>`;
      }
      tok.children = [{ type: 'mapped', content: inner } as unknown as Token];
    },
    (tok, code) => {
      if (code) tok.meta = { ...(tok.meta ?? {}), html: renderCode(ctx, tok, code.content, code.map, blockId++) };
    },
  );
  for (const tok of tokens) if (tok.map && tok.nesting >= 0 && tok.type !== 'inline') tok.attrSet('data-line', String(tok.map[0]));
  let html = md.renderer.render(tokens, md.options, env);
  if (frontmatter !== null) {
    html = `<div class="frontmatter ro" contenteditable="false"><pre>${esc(frontmatter)}</pre></div>\n` + html;
  }
  // Statistik über den Scanner (gleiche Regeln wie Accept/Reject all)
  const stats = countMarkers(scanMarkers(text, { colors: opts.colors }));
  return { html, markers: ctx.markers, stats };
}
