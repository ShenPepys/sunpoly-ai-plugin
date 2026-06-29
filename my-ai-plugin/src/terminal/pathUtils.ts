import * as path from 'node:path';

/** 比较两条路径是否指向同一位置（Windows 忽略大小写） */
export function arePathsEqual(pathA: string, pathB: string): boolean {
  const normalizedA = path.normalize(pathA);
  const normalizedB = path.normalize(pathB);

  if (process.platform === 'win32') {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }

  return normalizedA === normalizedB;
}
