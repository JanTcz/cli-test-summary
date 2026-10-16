// Just enough XML for JUnit and TRX reports: elements by name, their attributes and text.
// Report formats are flat and machine-written, so a full parser would buy nothing.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

export function attributes(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

/** Every `<tag …>` in the document, with its attributes and inner XML (null when self-closing). */
export function elements(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  return [...xml.matchAll(re)].map((m) => ({ attrs: attributes(m[1] ?? ''), body: m[2] ?? null }));
}

export function first(xml, tag) {
  return xml ? (elements(xml, tag)[0] ?? null) : null;
}

/** The text of an element body: CDATA kept as is, everything else decoded. */
export function text(body) {
  if (!body) return '';
  return body
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith('<![CDATA[') ? part.slice(9, -3) : decode(part.replace(/<[^>]+>/g, ''))))
    .join('');
}
