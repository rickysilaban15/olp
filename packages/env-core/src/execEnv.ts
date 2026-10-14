import * as path from 'node:path';
import type { Environment } from './types.js';

/**
 * Build a child-process environment from a base env and detection result.
 *
 * Appends {@link Environment.pathExtra} entries to `PATH` without
 * duplicating existing entries. Never mutates the input object.
 *
 * @param base - Base environment (usually `process.env`).
 * @param detected - Detection result from `detect()`.
 * @returns New environment object with extended `PATH`.
 */
export function execEnv(
  base: NodeJS.ProcessEnv,
  detected: Environment,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  if (detected.pathExtra.length === 0) return out;
  const delimiter =
    detected.id === 'windows' ? ';' : detected.id === 'unknown' ? path.delimiter : ':';
  const pathKey = out['PATH'] !== undefined ? 'PATH' : out['Path'] !== undefined ? 'Path' : 'PATH';
  const current = (out[pathKey] ?? '').split(delimiter).filter((d) => d !== '');
  for (const dir of detected.pathExtra) {
    if (dir !== '' && !current.includes(dir)) current.push(dir);
  }
  out[pathKey] = current.join(delimiter);
  return out;
}
