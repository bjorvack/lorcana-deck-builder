/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(cleanup);

function Bomb({ fail }: { fail: boolean }): ReactNode {
  if (fail) throw new Error('boom');
  return <p>fine</p>;
}

describe('ErrorBoundary', () => {
  it('shows a recoverable fallback instead of unmounting the app', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb fail />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('boom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // recovery: the same child no longer throwing renders normally again
    rerender(
      <ErrorBoundary>
        <Bomb fail={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('fine')).toBeTruthy();
  });

  it('logs the failure to the console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb fail />
      </ErrorBoundary>,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
