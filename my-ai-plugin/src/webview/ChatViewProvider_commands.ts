import { buildCommandRequest } from '../commands/handler';
import type { CommandExecutionRequest, CommandType } from '../commands/handler';

const COMMAND_TYPE_MAP: Record<string, CommandType> = {
  'my-ai-plugin.explain': 'explain',
  'my-ai-plugin.fix': 'fix',
  'my-ai-plugin.optimize': 'optimize',
  'my-ai-plugin.test': 'test',
  'my-ai-plugin.complete': 'complete',
};

export function resolveCommandType(command: string): CommandType | null {
  return COMMAND_TYPE_MAP[command] ?? null;
}

export function buildSlashCommandRequest(type: CommandType): CommandExecutionRequest | null {
  return buildCommandRequest(type);
}
