import { filterAndSort, useCatalog } from '@/state/catalog';

/**
 * Filtered + sorted photo ids for the Library — the shared `filterAndSort()` (same semantics as
 * `useVisibleIds()`), with two performance fixes for very large catalogs:
 *
 *  1. The shared comparator breaks ties with `order.indexOf()` (O(n) per comparison → O(n² log n)
 *     when many photos tie, e.g. sorting 20k photos by rating). We hand it an `order` array whose
 *     `indexOf` is an O(1) Map lookup.
 *  2. The result keeps its previous identity when the ids didn't actually change (e.g. after a
 *     rating change that doesn't affect filter/sort), so the grid and filmstrip don't re-render.
 */

type CatalogSnapshot = ReturnType<typeof useCatalog.getState>;

let fast: { order: string[]; patched: string[] } | null = null;

function fastOrder(order: string[]): string[] {
  if (fast?.order === order) return fast.patched;
  const index = new Map<string, number>();
  for (let i = 0; i < order.length; i++) index.set(order[i], i);
  const patched = order.slice();
  Object.defineProperty(patched, 'indexOf', { value: (id: string) => index.get(id) ?? -1, enumerable: false });
  fast = { order, patched };
  return patched;
}

let memo: { key: unknown[]; value: string[] } | null = null;

function sameIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function computeLibraryIds(s: CatalogSnapshot): string[] {
  const key = [s.photos, s.order, s.filter, s.sort, s.sortDesc, s.collections];
  if (memo && memo.key.every((k, i) => k === key[i])) return memo.value;
  let value = filterAndSort({ photos: s.photos, order: fastOrder(s.order), filter: s.filter, sort: s.sort, sortDesc: s.sortDesc, collections: s.collections });
  if (memo && sameIds(memo.value, value)) value = memo.value;
  memo = { key, value };
  return value;
}

/** Hook: the ids shown in the grid / filmstrip. */
export const useLibraryIds = () => useCatalog(computeLibraryIds);

/** Non-reactive read of the visible ids (for event handlers). */
export const getLibraryIds = () => computeLibraryIds(useCatalog.getState());
