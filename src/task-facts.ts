import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { Owner } from './types.js';

type ToolResult = Extract<SessionMessageEntry['message'], { role: 'toolResult' }>;
export interface TaskFactProjection {
  toolName: string;
  policyVersion: string;
}
/** Installed host code only; run locally without model/network extraction. Return necessary verified business facts, never
 * stringify the result, its arguments, or its private details wholesale. */
export type TaskFactProjector = (result: Readonly<ToolResult>, context: {
  owner: Readonly<Owner>; scope: string | null; signal?: AbortSignal;
}) => string | undefined | Promise<string | undefined>;
export interface TaskFactPolicy {
  /** Must match the user's separate collection grant. Changes require a new grant. */
  policyVersion: string;
  tools: ReadonlyMap<string, TaskFactProjector>;
}
export function isTaskFactProjection(value: unknown): value is TaskFactProjection {
  if (!value || typeof value !== 'object') return false;
  const projection = value as TaskFactProjection;
  return typeof projection.toolName === 'string' && !!projection.toolName.trim()
    && typeof projection.policyVersion === 'string' && !!projection.policyVersion.trim();
}
