/**
 * Shared text-reference extraction lives in src/text/refs.ts (D5: one
 * implementation for the trainer and the app). This file stays as the
 * trainer-side import path so existing imports and tests keep working.
 */
export { extractNameReferences, referenceDecks, type TextReferences } from '../../src/text/refs';
