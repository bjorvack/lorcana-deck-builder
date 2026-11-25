import { describe, expect, it } from 'vitest';
import { resolveBatchOutputs } from './batch';

describe('batch output paths', () => {
  const defaultOut = '/data/matchups/abc123/sig.json';

  it('writes the trace file to --out when --trace is set', () => {
    const custom = '/tmp/ranker-traces.json';
    expect(
      resolveBatchOutputs({ out: custom, trace: true }, defaultOut),
    ).toEqual({
      matrixOut: defaultOut,
      traceOut: custom,
    });
  });

  it('falls back to a .traces.jsonl sidecar when --trace is set without --out', () => {
    expect(resolveBatchOutputs({ out: null, trace: true }, defaultOut)).toEqual(
      {
        matrixOut: defaultOut,
        traceOut: `${defaultOut}.traces.jsonl`,
      },
    );
  });

  it('uses --out as the matrix path when --trace is not set', () => {
    const custom = '/tmp/matrix.json';
    expect(
      resolveBatchOutputs({ out: custom, trace: false }, defaultOut),
    ).toEqual({
      matrixOut: custom,
      traceOut: null,
    });
  });

  it('uses the default matrix path when no flags are set', () => {
    expect(
      resolveBatchOutputs({ out: null, trace: false }, defaultOut),
    ).toEqual({
      matrixOut: defaultOut,
      traceOut: null,
    });
  });
});
