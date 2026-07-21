import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function renderBar(value: number, total: number, width = 10): string {
  if (total <= 0) {
    return '░'.repeat(width);
  }
  const filled = Math.round((value / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

describe('renderBar', () => {
  it('is empty at zero', () => {
    assert.equal(renderBar(0, 10), '░'.repeat(10));
  });

  it('is full at completion', () => {
    assert.equal(renderBar(10, 10), '█'.repeat(10));
  });

  it('is half filled at 50%', () => {
    assert.equal(renderBar(5, 10), '█████░░░░░');
  });

  it('always spans the requested width', () => {
    for (let value = 0; value <= 35; value += 1) {
      assert.equal(renderBar(value, 35, 12).length, 12, `width wrong at ${value}`);
    }
  });

  it('does not divide by zero for an empty category', () => {
    assert.equal(renderBar(0, 0, 6), '░░░░░░');
  });

  it('rounds rather than truncating', () => {
    // 7/10 -> 70% of 10 cells.
    assert.equal(renderBar(7, 10), '███████░░░');
  });
});
