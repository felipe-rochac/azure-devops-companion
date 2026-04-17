const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*?>/i;

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };

  let result = text.replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (entity) => {
    const key = entity.toLowerCase();
    return named[key] ?? entity;
  });

  result = result.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });

  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });

  return result;
}

export function formatCommentContent(content: string): string {
  if (!content) {
    return '';
  }

  let text = content.replace(/\r\n/g, '\n');
  if (!HTML_TAG_PATTERN.test(text)) {
    return text;
  }

  // Convert links to readable markdown-like text before stripping tags.
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => `${label} (${href})`
  );

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table|details|summary|small|span|td|th|ul|ol)>/gi, '\n');
  text = text.replace(/<(p|div|tr|li|h[1-6]|table|details|summary|small|span|td|th|ul|ol)[^>]*>/gi, '');
  text = text.replace(/<[^>]+>/g, '');

  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
