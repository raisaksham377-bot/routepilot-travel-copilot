/**
 * Redaction applied before any text leaves the device.
 *
 * Deliberately CONSERVATIVE. Travel text is full of short alphanumeric tokens
 * that look like identifiers but are not -- airport codes (LHR), flight numbers
 * (BA117), cabin names, fare classes. Over-aggressive redaction would mangle
 * exactly the content the model needs to read, so each rule below targets a
 * shape that cannot be confused with legitimate itinerary vocabulary.
 *
 * This reduces what is transmitted; it is not a guarantee of anonymity, and the
 * UI says so. The stronger protection is structural: the payload builder sends
 * only the utterance and constraint keys, never the profile or trip state.
 */

export interface RedactionResult {
  text: string;
  /** What was removed, by category, for display back to the user. */
  removed: string[];
}

interface Rule {
  label: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  {
    label: 'email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[email removed]',
  },
  {
    // A label followed by an identifier. Catches the explicit cases without
    // touching bare codes, because the keyword has to be present.
    label: 'booking or document reference',
    pattern:
      /\b(?:pnr|booking(?:\s+(?:ref|reference|code|number))?|confirmation(?:\s+(?:code|number))?|record\s+locator|passport|visa\s+number|frequent\s+flyer|loyalty(?:\s+number)?|membership(?:\s+number)?)\s*(?:#|no\.?|number|:|=)?\s*[A-Z0-9][A-Z0-9-]{4,}\b/gi,
    replacement: '[reference removed]',
  },
  {
    // 13-19 digits, optionally grouped. Payment-card shaped.
    label: 'long number (card-like)',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    replacement: '[number removed]',
  },
  {
    // International or separated phone numbers. Requires a + or separators so
    // it cannot swallow a bare price or a points balance.
    label: 'phone number',
    pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g,
    replacement: '[phone removed]',
  },
];

export function redactForModel(input: string): RedactionResult {
  let text = input;
  const removed: string[] = [];

  for (const rule of RULES) {
    // Fresh lastIndex each pass: these are /g regexes and are module-level.
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replacement);
      removed.push(rule.label);
    }
  }

  return { text, removed };
}
