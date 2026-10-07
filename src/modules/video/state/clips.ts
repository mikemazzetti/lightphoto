/** Small helpers for updating clips immutably within the project. */
import type { Clip, Project, Sequence } from '../model/types';

export function mapClips(p: Project, ids: Set<string> | string, fn: (c: Clip) => Clip): Project {
  const set = typeof ids === 'string' ? new Set([ids]) : ids;
  let changed = false;
  const clips = p.seq.clips.map((c) => {
    if (!set.has(c.id)) return c;
    const n = fn(c);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...p, seq: { ...p.seq, clips } } : p;
}

export const withSeq = (p: Project, seq: Sequence | null): Project => (seq && seq !== p.seq ? { ...p, seq } : p);

export function updateSeq(p: Project, patch: Partial<Sequence>): Project {
  return { ...p, seq: { ...p.seq, ...patch } };
}
