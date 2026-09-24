export interface SourceAlignedContent {
  content: string;
  corrected: boolean;
}

/** Only a unique, one-digit transcription error may be repaired from user text. */
export function sourceAlignedContent(sourceTexts: string[], proposed: unknown): SourceAlignedContent | null {
  if (typeof proposed !== 'string') return null;
  const content = proposed.trim().normalize('NFC');
  if (!content) return null;
  const texts = sourceTexts.map(text => text.normalize('NFC'));
  if (texts.some(text => text.includes(content))) return { content, corrected: false };
  if (content.length < 12 || content.length > 512) return null;

  const matches = new Set<string>();
  for (let index = 0; index < content.length; index++) {
    if (!/[0-9]/.test(content[index])) continue;
    const before = content.slice(0, index);
    const after = content.slice(index + 1);
    if (before.length < 6 && after.length < 6) continue;
    for (const text of texts) {
      let start = text.indexOf(before);
      while (start !== -1) {
        const sourceDigitIndex = start + before.length;
        const sourceDigit = text[sourceDigitIndex];
        if (sourceDigit !== content[index] && /[0-9]/.test(sourceDigit ?? '')
          && text.startsWith(after, sourceDigitIndex + 1)) {
          matches.add(text.slice(start, sourceDigitIndex + 1 + after.length));
          if (matches.size > 1) return null;
        }
        start = text.indexOf(before, start + 1);
      }
    }
  }
  return matches.size === 1 ? { content: [...matches][0], corrected: true } : null;
}
