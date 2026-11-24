import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Card, DeckState } from '../data/types';
import type { MetaModel } from '../meta/infer';
import { BASIS_FUSED, BASIS_TEXT, suggestCards } from '../meta/infer';
import { resolveEntries } from '../rules/engine';
import type { AddResult } from '../state';
import type { Fingerprint } from '../stats/fingerprint';
import { AXIS_FORMULAS } from '../stats/fingerprint';
import { OPPONENT_PROFILES } from '../stats/profiles';
import {
  deckSignature,
  estimateWinrate,
  type WinrateEstimate,
} from '../stats/winrate-estimate';
import { shiftCoverage } from '../text/refs';
import { payoffHint, SuggestionRow, useRowRefusal } from './SuggestionRow';
import { panelHeadingCls } from './styles';

const ViabilityRadar = lazy(() =>
  import('./charts/analysis-charts').then((m) => ({
    default: m.ViabilityRadar,
  })),
);
const LoreRaceLines = lazy(() =>
  import('./charts/analysis-charts').then((m) => ({
    default: m.LoreRaceLines,
  })),
);

const SIMPLIFICATIONS =
  'Estimates from seeded simulations with greedy policies and scripted opponent profiles — no interactive play. They compare pace and consistency, not real matchups.';

export interface MetaState {
  model: MetaModel | null;
}

/** shared "no artifact" note — the same unavailable state for every meta surface */
function MetaUnavailableNote(): ReactNode {
  return (
    <p
      className="text-[11px] mt-3 text-parchment-muted"
      data-testid="meta-unavailable"
    >
      Meta model unavailable — deterministic metrics only. Train and ship{' '}
      <code>data/meta-model.json</code> to enable suggestions.
    </p>
  );
}

/** viability profile + matchup bars for a valid deck (does not render otherwise) */
export function AnalysisPanel({
  fingerprint,
  deck,
  byId,
}: {
  fingerprint: Fingerprint | null;
  deck: DeckState;
  byId: Map<number, Card>;
}): ReactNode {
  if (!fingerprint) return null;

  return (
    <section className="panel" data-testid="analysis-panel">
      <h3 className={panelHeadingCls}>Deck analysis</h3>
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <div>
          <h4 className="m-0 mb-1.5 text-xs uppercase text-parchment-muted">
            Viability profile
          </h4>
          <Suspense fallback={<p className="text-parchment-muted">—</p>}>
            <ViabilityRadar axes={fingerprint.axes} />
          </Suspense>
          <div className="flex flex-wrap gap-2">
            {(
              Object.entries(fingerprint.axes) as [
                keyof typeof fingerprint.axes,
                number,
              ][]
            ).map(([axis, value]) => (
              <span
                key={axis}
                className="bg-panel-2 border border-line rounded-xl py-0.5 px-2.5 text-xs text-parchment-muted"
                title={`${AXIS_FORMULAS[axis]}. ${SIMPLIFICATIONS}`}
              >
                {value} {axis.toLowerCase()}
              </span>
            ))}
          </div>
        </div>

        <div>
          <h4 className="m-0 mb-1.5 text-xs uppercase text-parchment-muted">
            Lore race vs baselines
          </h4>
          {fingerprint.matchups.map((m) => {
            const profile = OPPONENT_PROFILES.find(
              (p) => p.id === m.profileId,
            )!;
            return (
              <div
                key={m.profileId}
                className="grid grid-cols-[minmax(0,90px)_minmax(0,1fr)_minmax(0,120px)] gap-2 items-center my-[3px]"
                title={`${profile.description} Pace, challenge and removal simplified — ${SIMPLIFICATIONS.toLowerCase()}`}
              >
                <span className="text-xs text-parchment-muted whitespace-nowrap overflow-hidden text-ellipsis">
                  {profile.id}
                </span>
                <span className="relative h-3.5 bg-panel-2 rounded-md overflow-hidden">
                  <span
                    className="absolute left-0 top-0 bottom-0 bg-gold"
                    style={{ width: `${Math.round(m.winRate * 100)}%` }}
                  />
                </span>
                <span className="text-xs text-right">
                  {Math.round(m.winRate * 100)}% ·{' '}
                  {m.medianFinish ? `win t${m.medianFinish}` : 'no wins'}
                </span>
              </div>
            );
          })}
          <Suspense fallback={null}>
            <LoreRaceLines matchups={fingerprint.matchups} />
          </Suspense>
          <p className="text-[11px] mt-1 text-parchment-muted">
            Opening hands keepable:{' '}
            {Math.round(fingerprint.openingHand.keepableRate * 100)}% · on curve
            through turn {Math.floor(fingerprint.curve.onCurveThrough)} · seed{' '}
            {fingerprint.curve.seed ?? 'fixed'} · {SIMPLIFICATIONS}
          </p>
        </div>
      </div>

      <PayoffCoverageLine deck={deck} byId={byId} />
      <WinrateSection deck={deck} byId={byId} />
    </section>
  );
}

/** informational payoff coverage — never a validation violation (card-payoffs) */
function PayoffCoverageLine({
  deck,
  byId,
}: {
  deck: DeckState;
  byId: Map<number, Card>;
}): ReactNode {
  const coverage = useMemo(
    () => shiftCoverage(resolveEntries(deck, byId)),
    [deck, byId],
  );
  if (coverage.shiftCards === 0) return null;
  const wildcard = coverage.advancedWildcard
    ? ' · advanced mimicry wildcard'
    : coverage.wildcard
      ? ' · mimicry wildcard'
      : '';
  const text =
    coverage.covered === coverage.shiftCards
      ? `shift target present for all ${coverage.shiftCards}`
      : coverage.covered === 0
        ? `no shift target in deck (${coverage.shiftCards} shift ${coverage.shiftCards === 1 ? 'card' : 'cards'} — playable without one)`
        : `shift target present for ${coverage.covered} of ${coverage.shiftCards}`;
  return (
    <p className="my-1 text-[13px]" data-testid="payoff-coverage">
      Payoffs: {text}
      {wildcard}. Informational — payoffs never gate legality.
    </p>
  );
}

function WinrateSection({
  deck,
  byId,
}: {
  deck: DeckState;
  byId: Map<number, Card>;
}): ReactNode {
  // the estimate is keyed by the deck signature (content identity): a deck
  // change flips the run token, the in-flight run is abandoned and never
  // rendered. The latest deck object is read through a ref so a new object
  // with identical cards (title-only edit) does not restart the run.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const signature = useMemo(() => deckSignature(deck), [deck]);
  const [estimate, setEstimate] = useState<WinrateEstimate | null>(null);
  const [estimating, setEstimating] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect is keyed by the deck signature — content identity, not deck object identity
  useEffect(() => {
    let aborted = false;
    setEstimating(true);
    setEstimate(null);
    estimateWinrate(deckRef.current, byId, { shouldAbort: () => aborted }).then(
      (result) => {
        if (aborted) return; // an abandoned run's chunks are discarded
        setEstimating(false);
        setEstimate(result); // null when no deck card resolves to the catalog
      },
    );
    return () => {
      aborted = true;
    };
  }, [byId, signature]);

  const profile = estimate
    ? OPPONENT_PROFILES.find((p) => p.id === estimate.profileId)
    : undefined;

  return (
    <div
      className="mt-3.5 border-t border-line pt-2.5"
      data-testid="winrate-section"
    >
      <h4 className="m-0 mb-1.5 text-xs uppercase text-parchment-muted">
        Winrate
      </h4>
      {estimating && (
        <p className="my-1 text-[13px]" data-testid="winrate-estimating">
          Estimating winrate…
        </p>
      )}
      {estimate && profile && (
        <p className="my-1 text-[13px]" data-testid="winrate-estimate">
          Simulated winrate vs {profile.name.toLowerCase()}:{' '}
          <strong>{Math.round(estimate.winRate * 100)}%</strong> · 95% CI{' '}
          {Math.round(estimate.ci.low * 100)}–
          {Math.round(estimate.ci.high * 100)}% · {estimate.trials} simulated
          games
        </p>
      )}
      <p className="text-[11px] mt-1 text-parchment-muted">
        Seeded goldfish races against the scripted baseline — deterministic per
        deck, chunked so the page stays responsive. {SIMPLIFICATIONS}
      </p>
    </div>
  );
}

/**
 * "Suggested additions" for the building phase (D5): top-8 fused-similarity
 * candidates with visible affinity basis and add-on-click. Rendered while the
 * deck is not yet a legal complete deck — additions only make sense while
 * building; a finished deck gets the full analysis panel instead. Hidden when
 * the artifact lacks relation embeddings; quiet empty state when the legal
 * candidate pool exhausts (narrow ink pairs).
 */
export function SuggestionsPanel({
  meta,
  deck,
  byId,
  onAddCard,
}: {
  meta: MetaState;
  deck: DeckState;
  byId: Map<number, Card>;
  /** existing deck handler, wired to the single gated add path */
  onAddCard?: (cardId: number) => AddResult | undefined;
}): ReactNode {
  const model = meta.model;
  const relationsReady = model?.capabilities.relations && model.relations;
  return (
    <section className="panel" data-testid="suggestions-panel">
      <h3 className={panelHeadingCls}>Suggested additions</h3>
      {!relationsReady ? (
        <MetaUnavailableNote />
      ) : (
        <SuggestionsBody
          deck={deck}
          byId={byId}
          model={model}
          onAddCard={onAddCard}
        />
      )}
      <p className="text-[11px] mt-1 text-parchment-muted">
        Suggestions show while your deck is incomplete and hide once it is
        legal.
      </p>
    </section>
  );
}

function SuggestionsBody({
  deck,
  byId,
  model,
  onAddCard,
}: {
  deck: DeckState;
  byId: Map<number, Card>;
  model: MetaModel;
  onAddCard?: (cardId: number) => AddResult | undefined;
}): ReactNode {
  const { refusals, handleResult } = useRowRefusal();
  const suggestions = useMemo(
    () => suggestCards(deck, [...byId.values()], model),
    [deck, byId, model],
  );
  return (
    <div className="mt-3" data-testid="suggestions-section">
      {suggestions.length === 0 ? (
        <p
          className="text-[11px] mt-1 text-parchment-muted"
          data-testid="suggestions-empty"
        >
          No legal additions found — the candidate pool for these inks and this
          format is exhausted.
        </p>
      ) : (
        suggestions.map((s) => (
          <SuggestionRow
            key={s.card.id}
            card={s.card}
            score={s.score}
            basis={s.basis}
            hint={payoffHint(s.card, deck, byId)}
            refusal={refusals[s.card.id]}
            onAdd={(cardId) => handleResult(cardId, onAddCard?.(cardId))}
          />
        ))
      )}
      <p className="text-[11px] mt-1 text-parchment-muted">
        Fused ranking: 60% tournament co-occurrence + 40% card-content
        similarity, filtered to this deck's inks, format and copy limits. Basis:
        “{BASIS_FUSED}” or “{BASIS_TEXT}” for cards outside the tournament
        space.
      </p>
    </div>
  );
}
