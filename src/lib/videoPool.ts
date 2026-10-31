/**
 * Which `<video>` element shows which item. The Edit preview keeps a small pool
 * of elements rather than one per item, so a cut swaps to an element that is
 * already loaded and seeked, and two items cut from the same file reuse one
 * element with a seek rather than a reload.
 */

export interface PoolSlot {
  /** The item this element is showing or preparing; null when free. */
  itemId: string | null;
  /** The file it has loaded, kept while free so it can be reused. */
  path: string | null;
}

export interface PoolWant {
  itemId: string;
  path: string;
}

export const MIN_POOL = 3;

/**
 * The pool after `wanted` (visible items, then ones to preload). An item keeps
 * its element; a new one takes a free element, preferring one that already
 * holds its file; the pool only grows when every element is busy.
 */
export function assignSlots(prev: PoolSlot[], wanted: PoolWant[], minSize = MIN_POOL): PoolSlot[] {
  const want = new Map(wanted.map((w) => [w.itemId, w]));
  const slots: PoolSlot[] = prev.map((s) =>
    s.itemId !== null && want.has(s.itemId) ? s : { itemId: null, path: s.path },
  );
  while (slots.length < minSize) slots.push({ itemId: null, path: null });

  const placed = new Set(slots.map((s) => s.itemId).filter((id): id is string => id !== null));
  for (const w of wanted) {
    if (placed.has(w.itemId)) continue;
    let index = slots.findIndex((s) => s.itemId === null && s.path === w.path);
    if (index < 0) index = slots.findIndex((s) => s.itemId === null && s.path === null);
    if (index < 0) index = slots.findIndex((s) => s.itemId === null);
    if (index < 0) {
      slots.push({ itemId: null, path: null });
      index = slots.length - 1;
    }
    slots[index] = { itemId: w.itemId, path: w.path };
    placed.add(w.itemId);
  }
  return slots;
}
