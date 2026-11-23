# learned-deck-completion Delta

## ADDED Requirements

### Requirement: Training corpus from gated deck evidence

The training pipeline SHALL derive training pairs exclusively from gated deck
evidence: masked elites, substitution deltas, threshold-passing conditioned
decks and pool-slice ablations, and a coverage sweep for unseen identities.
Card features SHALL derive from committed card data only. Holdout splits SHALL
be stratified across strata, and ablation strata SHALL NOT exceed their
pre-committed share of corpus pairs.

#### Scenario: Pairs derive from gated evidence

WHEN the corpus is built
THEN imitation pairs are (seed → deck) subsets of archive, promoted league, or
threshold-passing conditioned decks; substitution pairs carry an arena-measured
leave-one-out delta on paired seeds; restricted decks below the fitness
threshold are excluded; and slice pairs come from searched decks inside the
random pool ablation they condition on.

#### Scenario: Card-data-only features

WHEN features are computed for training or inference
THEN they use only committed card data fields, not tournament or co-occurrence
statistics.

#### Scenario: Stratified holdout

WHEN the corpus is split
THEN train and holdout share no deck, and each stratum is represented in
both.

### Requirement: Quantized model artifact

The trainer SHALL emit a quantized set-model artifact to
`public/data/generator-model.json`, separate from `meta-model.json`, with a
size budget and recorded training evidence (corpus size, hyperparameters,
loss, feature schema version). Training SHALL be seeded and reproducible.

#### Scenario: Deterministic training

WHEN training runs twice with the same seed and corpus
THEN the emitted artifacts are identical.

#### Scenario: Size budget

WHEN the artifact is emitted
THEN its size is within the configured budget and it carries its feature
schema version.

### Requirement: Legality-masked completion

At inference the model SHALL score candidate cards given the current partial
deck, and the candidate set SHALL be masked by the shared rules (ink
declaration, copy limits and exceptions, format) before sampling — legality is
never learned. Completion SHALL be deterministic for the same seed, partial
deck, and model artifact.

#### Scenario: Masked candidate set

WHEN a completion pick is made
THEN every candidate is legal under `src/rules` for the current deck state.

#### Scenario: Deterministic pick

WHEN the same seed and partial deck are completed twice with the same artifact
THEN the resulting deck is identical.

### Requirement: Smart-mode integration with graceful degradation

Smart mode SHALL use the learned completion source when
`public/data/generator-model.json` exists, matches the current feature schema,
and passed its gate; otherwise it SHALL fall back to the existing suggest-fill
behavior without error. A corrupt or schema-mismatched artifact SHALL disable
only the learned completion, never deck generation itself.

#### Scenario: Fallback without model

WHEN the artifact is missing or invalid
THEN smart mode generates decks via the existing suggest-fill loop and reports
the fallback in debug output.

#### Scenario: Chaos unchanged

WHEN chaos mode runs
THEN its behavior is unaffected by the learned completion path.

### Requirement: A/B gate before shipping

The learned completion SHALL ship only if a matched A/B against the shipped
suggest-fill loop shows an uplift win rate whose 95% CI lower bound is above 0,
with the learned decks legal by construction and the seed pool covering both
unrestricted and restricted conditioning. A FAIL verdict SHALL be recorded in
`ROADMAP.md` and the default smart-mode path SHALL remain the shipped behavior.

#### Scenario: Gate pass enables the path

WHEN the A/B uplift 95% CI lower bound is above 0
THEN smart mode may use the learned completion by default and the verdict is
recorded in the run report and ROADMAP.md.

#### Scenario: Gate fail keeps shipped behavior

WHEN the uplift CI includes 0 or the learned decks produce legality failures
THEN the default path remains the shipped suggest-fill behavior and the FAIL
verdict is recorded in ROADMAP.md and the report.

#### Scenario: Restricted conditioning covered

WHEN the A/B seed pool is constructed
THEN it includes restricted-conditioned seeds (declared inks and franchise
filters) alongside unrestricted seeds, and the report states the per-regime
uplift so a model that only wins the easy case does not gate in.

### Requirement: Pool coverage guarantee

Every identity in the self-play pool SHALL appear in at least one training
pair, with a recorded occurrence histogram and pool-coverage percentage.
Restricted pools too thin to search SHALL be widened before rerun. Identities
still unseen after all strata SHALL be covered by a league-evaluated sweep
into a distinct `coverage` stratum whose pairs train at a reduced weight.

#### Scenario: Every pool card seen

WHEN the corpus build completes
THEN the report states the share of pool identities appearing in at least one
pair, and no identity is left unseen while compute budget remains.

#### Scenario: Thin pools widen instead of vanishing

WHEN a restricted pool is below the searchable-size threshold
THEN its cards are re-searched inside a widened pool (recorded original and
widened sizes) rather than silently dropped.

#### Scenario: Coverage stratum is honest

WHEN coverage-sweep decks enter the corpus
THEN each carries its measured league fitness and the corpus records the
stratum's fitness distribution separately from threshold-gated strata.
