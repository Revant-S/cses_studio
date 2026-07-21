import assert from 'node:assert/strict';
import { describe, it } from 'node:test';


const MARKED = /\.marked$/;
const UNMARKED = /\.unmarked$/;
const ANY_PROBLEM = /^problem/;

const contextValue = (status: string, marked: boolean): string =>
  `problem.${status}.${marked ? 'marked' : 'unmarked'}`;

describe('problem contextValue', () => {
  const statuses = ['solved', 'attempted', 'unsolved'];

  it('matches the filled-star action only when marked', () => {
    for (const status of statuses) {
      assert.ok(MARKED.test(contextValue(status, true)), `${status} marked should match`);
      assert.ok(
        !MARKED.test(contextValue(status, false)),
        `${status} unmarked must NOT match the filled star`,
      );
    }
  });

  it('matches the hollow-star action only when unmarked', () => {
    for (const status of statuses) {
      assert.ok(UNMARKED.test(contextValue(status, false)), `${status} unmarked should match`);
      assert.ok(
        !UNMARKED.test(contextValue(status, true)),
        `${status} marked must NOT match the hollow star`,
      );
    }
  });

  it('never shows both star actions at once', () => {
    for (const status of statuses) {
      for (const marked of [true, false]) {
        const value = contextValue(status, marked);
        const shown = [MARKED.test(value), UNMARKED.test(value)].filter(Boolean).length;
        assert.equal(shown, 1, `exactly one star action for ${value}`);
      }
    }
  });

  it('still matches the generic problem menus', () => {
    for (const status of statuses) {
      for (const marked of [true, false]) {
        assert.ok(ANY_PROBLEM.test(contextValue(status, marked)));
      }
    }
  });
});
