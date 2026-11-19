# site-delivery Specification

## Purpose
The app ships as a static site on GitHub Pages with CI quality gates and an automated weekly data refresh.

## Requirements

### Requirement: Deploy the app to GitHub Pages
A CI workflow SHALL build the app (base path scoped to the repository name) on every push to the main branch and deploy the build artifacts to GitHub Pages.

#### Scenario: Push to main deploys
- **WHEN** a commit lands on main
- **THEN** the workflow builds the app and the updated site is live on GitHub Pages under `/lorcana-deck-builder/`

### Requirement: CI quality gates
CI SHALL run TypeScript typechecking, the full test suite, and a production build on every pull request and push, failing on any error.

#### Scenario: Failing test blocks merge
- **WHEN** a push introduces a failing test
- **THEN** CI fails and reports which test failed

### Requirement: Data refresh workflow
A scheduled workflow SHALL run the data pipeline weekly and on manual dispatch, committing snapshot changes so the deployed site stays current.

#### Scenario: New set release
- **WHEN** lorcanajson.org publishes a new set and the weekly workflow runs
- **THEN** the new cards appear in the committed snapshot and, after deploy, in the site
