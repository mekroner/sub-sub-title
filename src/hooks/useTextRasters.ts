import { useEffect, useMemo, useState } from "react";
import type { Edit, TextItem } from "../types";
import { rasterKey, rasterText, releaseRasters, type DrawnText } from "../lib/textRaster";

/**
 * Every text item in the edit, drawn to a PNG: for the preview to show and the
 * bake to overlay. `ready` is false while a drawing is still on its way, so a
 * bake never goes out with text missing.
 */
export function useTextRasters(edit: Edit | undefined) {
  const texts = useMemo(
    () => (edit?.items.filter((i): i is TextItem => i.kind === "text") ?? []),
    [edit],
  );
  // Only the words and look matter; moving an item does not redraw it.
  const wanted = useMemo(
    () => texts.map((t) => ({ id: t.id, key: rasterKey(t.text, t.style), text: t.text, style: t.style })),
    [texts],
  );
  const signature = wanted.map((w) => `${w.id}:${w.key}`).join("|");

  const [drawn, setDrawn] = useState<{ signature: string; byItem: Map<string, DrawnText> }>({
    signature: "",
    byItem: new Map(),
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all(wanted.map((w) => rasterText(w.text, w.style))).then((results) => {
      if (cancelled) return;
      const byItem = new Map<string, DrawnText>();
      results.forEach((result, i) => {
        if (result) byItem.set(wanted[i].id, result);
      });
      setDrawn({ signature, byItem });
      releaseRasters(new Set(wanted.map((w) => w.key)));
    });
    return () => {
      cancelled = true;
    };
    // `signature` captures everything in `wanted` that changes the drawings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { byItem: drawn.byItem, ready: drawn.signature === signature };
}
