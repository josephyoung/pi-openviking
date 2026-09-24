export interface SourceAlignedContent {
  content: string;
  corrected: boolean;
}

function numericEdits(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
        previous[column - 1] + Number(left[row - 1] !== right[column - 1]));
    }
    previous = current;
  }
  return previous[right.length];
}

/** Repair one unique numeric run with at most two edits, using only the user's text. */
export function sourceAlignedContent(sourceTexts: string[], proposed: unknown): SourceAlignedContent | null {
  if (typeof proposed !== 'string') return null;
  const content = proposed.trim().normalize('NFC');
  if (!content) return null;
  const texts = sourceTexts.map(text => text.normalize('NFC'));
  if (texts.some(text => text.includes(content))) return { content, corrected: false };
  if (content.length < 12 || content.length > 512) return null;

  const matches = new Set<string>();
  for (const number of content.matchAll(/[0-9]+/g)) {
    if (number[0].length > 16) continue;
    const before = content.slice(0, number.index);
    const after = content.slice(number.index + number[0].length);
    if (before.length < 6 && after.length < 6) continue;
    for (const text of texts) {
      let start = text.indexOf(before);
      while (start !== -1) {
        const numberStart = start + before.length;
        let numberEnd = numberStart;
        while (/[0-9]/.test(text[numberEnd] ?? '') && numberEnd - numberStart <= 16) numberEnd++;
        const sourceNumber = text.slice(numberStart, numberEnd);
        const edits = numericEdits(number[0], sourceNumber);
        if (sourceNumber.length > 0 && sourceNumber.length <= 16
          && edits >= 1 && edits <= 2 && text.startsWith(after, numberEnd)) {
          matches.add(text.slice(start, numberEnd + after.length));
          if (matches.size > 1) return null;
        }
        start = text.indexOf(before, start + 1);
      }
    }
  }
  return matches.size === 1 ? { content: [...matches][0], corrected: true } : null;
}
