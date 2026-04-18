import type {
  AstEditRequest,
  AstLanguageAdapter,
  AstRouteResult,
} from './astEditorTypes';

const astLanguageAdapters: AstLanguageAdapter[] = [];

export function registerAdapter(adapter: AstLanguageAdapter): void {
  const existingIndex = astLanguageAdapters.findIndex((item) => item.id === adapter.id);
  if (existingIndex !== -1) {
    astLanguageAdapters[existingIndex]?.dispose?.();
    astLanguageAdapters[existingIndex] = adapter;
    return;
  }

  astLanguageAdapters.push(adapter);
}

export function unregisterAdapter(adapterId: string): void {
  const existingIndex = astLanguageAdapters.findIndex((item) => item.id === adapterId);
  if (existingIndex === -1) {
    return;
  }

  const [removedAdapter] = astLanguageAdapters.splice(existingIndex, 1);
  removedAdapter.dispose?.();
}

export async function routeAstEdit(
  request: AstEditRequest,
  fileContent: string,
): Promise<AstRouteResult> {
  for (const adapter of astLanguageAdapters) {
    if (!adapter.supportsFile(request.filePath)) {
      continue;
    }

    return adapter.execute(request, fileContent);
  }

  return { supported: false };
}

export function listRegisteredAdapters(): string[] {
  return astLanguageAdapters.map((adapter) => adapter.id);
}

export function disposeAll(): void {
  while (astLanguageAdapters.length > 0) {
    const adapter = astLanguageAdapters.pop();
    adapter?.dispose?.();
  }
}
