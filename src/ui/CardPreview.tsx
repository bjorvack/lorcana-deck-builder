import { type ReactNode, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../data/types';

/**
 * Cursor-following card preview. A module-level store keeps the machinery out
 * of prop plumbing: any row (deck list, suggestions, browse) spreads
 * `useCardPreview(card)` onto its element and mounts <CardPreviewHost /> once
 * per view tree (App does it globally). The host portals a fixed-position
 * card image to the document body so row layout (grids, overflow) can't clip
 * or shift it, and flips to the other side of the cursor near screen edges.
 */

type Preview = { card: Card; x: number; y: number } | null;

let current: Preview = null;
const listeners = new Set<() => void>();

const emit = (): void =>
  listeners.forEach((l) => {
    l();
  });

export function showCardPreview(card: Card, x: number, y: number): void {
  current = { card, x, y };
  emit();
}

export function moveCardPreview(x: number, y: number): void {
  if (current) {
    current = { ...current, x, y };
    emit();
  }
}

export function hideCardPreview(): void {
  if (current) {
    current = null;
    emit();
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** mouse handlers to spread onto the row element that should show the preview */
export function cardPreviewHandlers(card: Card | undefined): {
  onMouseEnter: (e: { clientX: number; clientY: number }) => void;
  onMouseMove: (e: { clientX: number; clientY: number }) => void;
  onMouseLeave: () => void;
} {
  return {
    onMouseEnter: (e) => card && showCardPreview(card, e.clientX, e.clientY),
    onMouseMove: (e) => moveCardPreview(e.clientX, e.clientY),
    onMouseLeave: hideCardPreview,
  };
}

const PREVIEW_WIDTH = 206; // image 190 + padding, matches the CSS
const PREVIEW_HEIGHT = 300; // thumb aspect + caption, generous on purpose
const CURSOR_OFFSET = 16;

export function CardPreviewHost(): ReactNode {
  const preview = useSyncExternalStore(subscribe, () => current);
  if (!preview?.card.images.thumb) return null;
  const flipX = preview.x + CURSOR_OFFSET + PREVIEW_WIDTH > window.innerWidth;
  const flipY = preview.y + CURSOR_OFFSET + PREVIEW_HEIGHT > window.innerHeight;
  return createPortal(
    <span
      className="fixed z-[1000] w-[190px] bg-panel-2 border border-line rounded-[10px] p-2 shadow-[0_8px_24px_rgba(0,0,0,0.6)] pointer-events-none"
      aria-hidden
      style={{
        left: flipX
          ? preview.x - CURSOR_OFFSET - PREVIEW_WIDTH
          : preview.x + CURSOR_OFFSET,
        top: flipY
          ? preview.y - CURSOR_OFFSET - PREVIEW_HEIGHT
          : preview.y + CURSOR_OFFSET,
      }}
    >
      <img
        src={preview.card.images.thumb}
        alt=""
        className="w-full rounded-md block bg-kelp-deep"
      />
      <span className="block text-[11px] text-parchment-muted mt-1 whitespace-nowrap overflow-hidden text-ellipsis">
        {preview.card.fullName}
      </span>
    </span>,
    document.body,
  );
}
