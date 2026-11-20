import { type ReactNode, useRef, useState } from 'react';
import type { Card, DeckState } from '../data/types';
import { deckFromText, deckToText, encodeDeck } from '../deck/codec';
import {
  btnCls,
  btnPrimaryCls,
  noteCls,
  panelCls,
  panelHeadingCls,
} from './styles';

/** plain-text import/export and the clipboard share link */
export function IoPanel({
  deck,
  byId,
  replaceDeck,
}: {
  deck: DeckState;
  byId: Map<number, Card>;
  replaceDeck: (deck: DeckState) => void;
}): ReactNode {
  const [io, setIo] = useState<'none' | 'import' | 'export'>('none');
  const [ioText, setIoText] = useState('');
  const [ioNote, setIoNote] = useState<string>();
  const fileRef = useRef<HTMLTextAreaElement>(null);

  const exportText = (): void => {
    setIo('export');
    setIoText(deckToText(deck, byId));
    setIoNote(undefined);
  };

  const importText = (): void => {
    const result = deckFromText(ioText, byId, {
      title: deck.title,
      inks: deck.inks,
      format: deck.format,
    });
    replaceDeck(result.deck);
    setIoNote(
      result.unmatched.length > 0
        ? `Imported with ${result.unmatched.length} unmatched line(s): ${result.unmatched.join(' | ')}`
        : 'Imported.',
    );
  };

  const share = async (): Promise<void> => {
    const url = `${window.location.origin}${window.location.pathname}?d=${encodeDeck(deck)}#/deck`;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      setIoNote('Share link copied to clipboard.');
    } catch {
      // clipboard can be unavailable (non-secure origin) or denied — show the
      // link instead of claiming it was copied
      setIo('export');
      setIoText(url);
      setIoNote('Clipboard unavailable — copy the share link below.');
    }
  };

  return (
    <section className={panelCls}>
      <h3 className={panelHeadingCls}>Import / Export / Share</h3>
      <div className="flex gap-2 mb-2">
        <button type="button" className={btnCls} onClick={exportText}>
          Export
        </button>
        <button
          type="button"
          className={btnCls}
          onClick={() => setIo('import')}
        >
          Import
        </button>
        <button type="button" className={btnCls} onClick={() => void share()}>
          Copy share link
        </button>
      </div>
      {io !== 'none' && (
        <>
          <textarea
            ref={fileRef}
            rows={8}
            className="w-full bg-panel-2 text-parchment border border-line rounded-lg p-2 my-2 font-mono text-xs leading-normal"
            placeholder={
              '4x Aladdin - Heroic Outlaw\n3x Elsa - Spirit of Winter'
            }
            value={ioText}
            onChange={(e) => setIoText(e.target.value)}
          />
          {io === 'import' && (
            <button
              type="button"
              className={btnPrimaryCls}
              onClick={importText}
            >
              Import text
            </button>
          )}
        </>
      )}
      {ioNote && <p className={noteCls}>{ioNote}</p>}
    </section>
  );
}
