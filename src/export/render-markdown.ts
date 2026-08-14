/** Minimal safe Markdown renderer for Packrat's own generated Markdown subset. */
export function renderMarkdownHtml(markdown: string, remoteImages: boolean): string {
  const escaped = escapeHtml(markdown);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let inCode = false;
  let list: 'ul' | 'ol' | null = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) {
      closeList();
      if (inCode) out.push('</code></pre>'); else out.push('<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(line + '\n'); continue; }
    if (!line.trim()) { closeList(); continue; }

    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? '')) {
      closeList();
      const header = parseTableRow(line);
      index += 2; // consume header, separator, then zero or more body rows
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(parseTableRow(lines[index]));
        index++;
      }
      index--;
      const width = Math.max(header.length, ...rows.map((row) => row.length));
      const cells = (row: string[]) => Array.from({ length: width }, (_, cell) => row[cell] ?? '');
      out.push('<div class="table-scroll"><table><thead><tr>' + cells(header).map((cell) => `<th>${inline(cell, remoteImages)}</th>`).join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + cells(row).map((cell) => `<td>${inline(cell, remoteImages)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); const n = heading[1].length; out.push(`<h${n}>${inline(heading[2], remoteImages)}</h${n}>`); continue; }
    const unordered = line.match(/^[-*]\s+(.*)$/);
    if (unordered) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(unordered[1], remoteImages)}</li>`); continue; }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ordered[1], remoteImages)}</li>`); continue; }
    if (line.startsWith('&gt; ')) { closeList(); out.push(`<blockquote>${inline(line.slice(5), remoteImages)}</blockquote>`); continue; }
    closeList();
    out.push(`<p>${inline(line, remoteImages)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char === '|' ? '|' : `\\${char}`;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  cells.push(current.trim());
  return cells;
}

function inline(text: string, remoteImages: boolean): string {
  let value = text;
  value = value.replace(/!\[([^\]]*)\]\((?:&lt;(https?:\/\/.*?)&gt;|(https?:\/\/[^\s)]+))(?:\s+&quot;((?:(?!&quot;).)*)&quot;)?\)/g,
    (_m, alt, bracketedUrl, plainUrl, title) => {
      const url = bracketedUrl || plainUrl;
      return remoteImages
        ? `<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="image-placeholder" role="img" aria-label="Image omitted">${alt || `Image from ${new URL(decodeHtmlEntities(url)).hostname}`}</span>`;
    });
  value = value.replace(/\[([^\]]+)\]\((?:&lt;(https?:\/\/.*?)&gt;|(https?:\/\/[^)]+))\)/g,
    (_m, text, bracketedUrl, plainUrl) => `<a href="${bracketedUrl || plainUrl}" rel="noopener noreferrer">${text}</a>`);
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(?<!\*)\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  return value;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
