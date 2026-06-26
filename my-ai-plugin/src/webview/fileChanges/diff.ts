export function splitContentToLines(content: string): string[] {
  if (!content) {
    return [];
  }

  let normalized = content.replace(/\r\n/g, '\n');
  if (normalized.endsWith('\n')) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    return [];
  }

  return normalized.split('\n');
}

export function buildDiffOperationTypes(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length
    && prefixLength < newLines.length
    && oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let oldSuffixIndex = oldLines.length - 1;
  let newSuffixIndex = newLines.length - 1;
  while (
    oldSuffixIndex >= prefixLength
    && newSuffixIndex >= prefixLength
    && oldLines[oldSuffixIndex] === newLines[newSuffixIndex]
  ) {
    oldSuffixIndex -= 1;
    newSuffixIndex -= 1;
  }

  const operations: Array<'context' | 'add' | 'del'> = [];

  for (let index = 0; index < prefixLength; index += 1) {
    operations.push('context');
  }

  const middleOldLines = oldLines.slice(prefixLength, oldSuffixIndex + 1);
  const middleNewLines = newLines.slice(prefixLength, newSuffixIndex + 1);
  operations.push(...buildMiddleDiffOperationTypes(middleOldLines, middleNewLines));

  const suffixLength = oldLines.length - (oldSuffixIndex + 1);
  for (let index = 0; index < suffixLength; index += 1) {
    operations.push('context');
  }

  return operations;
}

function buildMiddleDiffOperationTypes(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  if (oldLines.length === 0) {
    return newLines.map(() => 'add');
  }

  if (newLines.length === 0) {
    return oldLines.map(() => 'del');
  }

  if (oldLines.length * newLines.length <= 120000) {
    return buildMiddleDiffOperationTypesByLcs(oldLines, newLines);
  }

  return buildMiddleDiffOperationTypesByLookahead(oldLines, newLines);
}

function buildMiddleDiffOperationTypesByLcs(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  const rowCount = oldLines.length;
  const columnCount = newLines.length;
  const lcsTable: number[][] = [];

  for (let row = 0; row <= rowCount; row += 1) {
    lcsTable.push(new Array(columnCount + 1).fill(0));
  }

  for (let row = rowCount - 1; row >= 0; row -= 1) {
    for (let column = columnCount - 1; column >= 0; column -= 1) {
      if (oldLines[row] === newLines[column]) {
        lcsTable[row][column] = lcsTable[row + 1][column + 1] + 1;
      } else {
        lcsTable[row][column] = Math.max(lcsTable[row + 1][column], lcsTable[row][column + 1]);
      }
    }
  }

  const operations: Array<'context' | 'add' | 'del'> = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < rowCount && newIndex < columnCount) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push('context');
      oldIndex += 1;
      newIndex += 1;
    } else if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
      operations.push('del');
      oldIndex += 1;
    } else {
      operations.push('add');
      newIndex += 1;
    }
  }

  while (oldIndex < rowCount) {
    operations.push('del');
    oldIndex += 1;
  }

  while (newIndex < columnCount) {
    operations.push('add');
    newIndex += 1;
  }

  return operations;
}

function buildMiddleDiffOperationTypesByLookahead(oldLines: string[], newLines: string[]): Array<'context' | 'add' | 'del'> {
  const operations: Array<'context' | 'add' | 'del'> = [];
  let oldIndex = 0;
  let newIndex = 0;
  const lookaheadSize = 20;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push('context');
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const nextNewMatch = findNextMatchingLine(newLines, newIndex + 1, oldLines[oldIndex], lookaheadSize);
    const nextOldMatch = findNextMatchingLine(oldLines, oldIndex + 1, newLines[newIndex], lookaheadSize);

    if (nextNewMatch !== -1 && (nextOldMatch === -1 || nextNewMatch - newIndex <= nextOldMatch - oldIndex)) {
      while (newIndex < nextNewMatch) {
        operations.push('add');
        newIndex += 1;
      }
      continue;
    }

    if (nextOldMatch !== -1) {
      while (oldIndex < nextOldMatch) {
        operations.push('del');
        oldIndex += 1;
      }
      continue;
    }

    operations.push('del');
    operations.push('add');
    oldIndex += 1;
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    operations.push('del');
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    operations.push('add');
    newIndex += 1;
  }

  return operations;
}

function findNextMatchingLine(lines: string[], startIndex: number, targetLine: string, lookaheadSize: number): number {
  const maxIndex = Math.min(lines.length, startIndex + lookaheadSize);
  for (let index = startIndex; index < maxIndex; index += 1) {
    if (lines[index] === targetLine) {
      return index;
    }
  }
  return -1;
}
