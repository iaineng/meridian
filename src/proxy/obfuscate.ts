/**
 * System-message obfuscation strategies.
 *
 * Three modes are available, selected by the MERIDIAN_OBFUSCATION env var:
 *   - "camelcase" (default): capitalize + strip inter-word spaces, isolate single-letter words
 *   - "homoglyph": replace Latin chars with Cyrillic/Greek lookalikes
 *   - "urlencode": encode ASCII chars using application/x-www-form-urlencoded (space → "+")
 *   - "cr": insert \r before every ASCII/fullwidth symbol and space
 */

/**
 * Homoglyph substitution map: replaces Latin characters with visually
 * identical Cyrillic/Greek counterparts to prevent regex/keyword matching
 * while keeping content human-readable.
 */
export const HOMOGLYPH_MAP: Record<string, string> = {
  // Lowercase: exact Cyrillic/Greek matches
  'a': '\u0430', 'c': '\u0441', 'e': '\u0435', 'i': '\u0456',
  'j': '\u0458', 'o': '\u043e', 'p': '\u0440', 's': '\u0455',
  'x': '\u0445', 'y': '\u0443',
  // Uppercase: exact Cyrillic/Greek matches
  'A': '\u0410', 'B': '\u0412', 'C': '\u0421', 'E': '\u0415',
  'H': '\u041d', 'I': '\u0406', 'J': '\u0408', 'K': '\u041a',
  'M': '\u041c', 'N': '\u039d', 'O': '\u041e', 'P': '\u0420',
  'S': '\u0405', 'T': '\u0422', 'X': '\u0425', 'Z': '\u0396',
  // Lowercase: high-similarity approximations
  'd': '\u0501', 'g': '\u0261', 'h': '\u04bb', 'q': '\u051b',
  'v': '\u03bd', 'w': '\u051d',
  // Uppercase: high-similarity approximations
  'V': '\u0474', 'W': '\u051c',
  // Punctuation/symbols
  ' ': '\u3000', ':': '\uff1a',
}

export function homoglyphEncode(content: string): string {
  let result = ''
  for (const ch of content) {
    result += HOMOGLYPH_MAP[ch] ?? ch
  }
  return result
}

/**
 * CamelCase obfuscation: capitalize first letter of each word, remove spaces
 * between words, and isolate single-letter words with surrounding spaces.
 *
 * Rules:
 *   - A "word" is a run of letters (a-zA-Z). Numbers are not considered word characters.
 *   - Spaces between word↔word or word↔symbol boundaries are removed;
 *     the next word's first letter is capitalized.
 *   - Spaces between symbol↔symbol (including punctuation, digits, etc.) are preserved.
 *   - Single-letter words get a space on each side: " A ".
 *
 * Example: "you are a financial advisor" → "YouAre A FinancialAdvisor"
 */
export function camelCaseEncode(content: string): string {
  // Split on escape characters (\n, \r, \t, etc.) — process each segment
  // independently so escape characters are preserved as-is.
  const segments = content.split(/(\r\n|\n|\r|\t)/)
  return segments.map(seg => {
    // Odd-indexed segments are the captured delimiters — pass through
    if (/^(\r\n|\n|\r|\t)$/.test(seg)) return seg
    return camelCaseSegment(seg)
  }).join('')
}

/** CamelCase-encode a single line/segment (no escape characters). */
function camelCaseSegment(content: string): string {
  // Tokenize into words (letter runs) and non-word segments
  const tokens: { type: 'word' | 'other', value: string }[] = []
  let i = 0
  while (i < content.length) {
    const ch = content.charAt(i)
    if (/[a-zA-Z]/.test(ch)) {
      const start = i
      while (i < content.length && /[a-zA-Z]/.test(content.charAt(i))) i++
      tokens.push({ type: 'word', value: content.slice(start, i) })
    } else {
      const start = i
      while (i < content.length && !/[a-zA-Z]/.test(content.charAt(i))) i++
      tokens.push({ type: 'other', value: content.slice(start, i) })
    }
  }

  let result = ''
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!

    if (token.type === 'word') {
      const capitalized = token.value.charAt(0).toUpperCase() + token.value.slice(1)
      const isSingleLetter = token.value.length === 1

      if (isSingleLetter) {
        // Single-letter word: surround with spaces
        // Avoid double-space at start of string
        if (result.length > 0 && !result.endsWith(' ')) {
          result += ' '
        }
        result += capitalized + ' '
      } else {
        result += capitalized
      }
    } else {
      // Non-word segment — strip spaces that are adjacent to words on both sides
      const prevIsWord = t > 0 && tokens[t - 1]!.type === 'word'
      const nextIsWord = t + 1 < tokens.length && tokens[t + 1]!.type === 'word'

      if (prevIsWord || nextIsWord) {
        // At least one side is a word — strip spaces from this gap
        result += token.value.replace(/ /g, '')
      } else {
        // Both sides are non-word (or edge) — preserve spaces
        result += token.value
      }
    }
  }

  return result.trimEnd()
}

/**
 * URL-encode obfuscation using the application/x-www-form-urlencoded convention.
 *
 * Per spec, the following ASCII characters are left as-is:
 *   - Letters (a-z, A-Z), digits (0-9), and `*`, `-`, `.`, `_`
 * Space → "+", all other ASCII → %XX hex.
 * Non-ASCII characters pass through unchanged.
 */
export function urlEncode(content: string): string {
  let result = ''
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i)
    const ch = content.charAt(i)
    if (code > 0x7f) {
      result += ch
    } else if (code === 0x20) {
      result += '+'
    } else if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      ch === '*' || ch === '-' || ch === '.' || ch === '_'
    ) {
      result += ch
    } else {
      result += '%' + code.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return result
}

/**
 * CR-insertion obfuscation: insert \r before every ASCII symbol (including
 * space) and their fullwidth counterparts.
 *
 * Targeted character ranges:
 *   - ASCII symbols + space: \x20-\x2f  \x3a-\x40  \x5b-\x60  \x7b-\x7e
 *   - Fullwidth space: \u3000
 *   - Fullwidth symbols (excluding letters/digits):
 *       \uff01-\uff0f  \uff1a-\uff20  \uff3b-\uff40  \uff5b-\uff5e
 */
export function crEncode(content: string): string {
  return content.replace(
    /[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e\u3000\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff5e]/g,
    '\r$&',
  )
}

/**
 * Obfuscate a system message using the mode selected by MERIDIAN_OBFUSCATION.
 * Defaults to "camelcase" if unset.
 */
export function obfuscateSystemMessage(content: string): string {
  const mode = process.env.MERIDIAN_OBFUSCATION || 'camelcase'
  switch (mode) {
    case 'homoglyph':
      return homoglyphEncode(content)
    case 'urlencode':
      return urlEncode(content)
    case 'cr':
      return crEncode(content)
    case 'camelcase':
    default:
      return camelCaseEncode(content)
  }
}
