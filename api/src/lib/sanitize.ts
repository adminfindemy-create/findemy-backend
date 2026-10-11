import sanitizeHtml from 'sanitize-html';

// Rich-text sanitizer for admin-authored HTML (e.g. Event.description edited in the Ops Console
// WYSIWYG). NEVER trust client HTML — run this on write. The allow-list matches what the student
// app can render with react-native-render-html: headings, emphasis, lists, links, paragraphs.
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4',
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's',
    'ul', 'ol', 'li',
    'blockquote', 'a', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Force safe link behaviour; drop anything not on the allow-list silently.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
  disallowedTagsMode: 'discard',
};

// Sanitize admin rich text. Returns cleaned HTML (plain-text input passes through untouched).
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, RICH_TEXT_OPTIONS).trim();
}
