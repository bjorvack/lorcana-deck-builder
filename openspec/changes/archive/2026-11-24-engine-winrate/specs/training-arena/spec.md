# training-arena Delta

## ADDED Requirements

### Requirement: Browser simulation bundle

A training script SHALL bundle the pinned vendored engine checkout together
with the shipped heuristic bot strategy into a lazy-loadable ES module under
`public/data/`, and `src/` sources SHALL load the shipped bundle artifact
rather than importing vendored engine sources.

#### Scenario: Bundle rebuilt on engine bump

WHEN the vendored engine is updated to a new upstream commit
THEN the bundle is rebuilt from the new pinned checkout under a filename
carrying the new commit8, the previous commit's bundle is removed, and the
bundle's recorded commit matches the pin file (a committed test fails while
they disagree).

#### Scenario: Bundle records its provenance and capabilities

WHEN the bundle is imported
THEN it exposes the engine commit and upstream attribution alongside a
wrapper that resolves deck lists given as canonical catalog print ids, plays
one game between two automated seats, and reports the winner, turn count,
lore timeline and a compact per-turn action log.

#### Scenario: Runtime plays a deterministic game

WHEN the bundle is asked to play one game twice for the same legal deck
lists and seed (in the browser or Node)
THEN both plays produce the identical result.

### Requirement: Browser bundle stays engine-only at build time

The shipped bundle SHALL be rebuilt whenever an arena engine bump changes the
pinned commit, and the app build SHALL keep the vendored engine sources out
of its module graph — the engine reaches the browser only through the
shipped bundle artifact.

#### Scenario: App build excludes the vendor tree

WHEN the site build runs
THEN no vendored engine module is imported or bundled by `src/` code.
