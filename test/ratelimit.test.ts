import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createLimiter } from '../src/lib/ratelimit.ts';

it('allows max hits per window, per key, then resets', () => {
  const limiter = createLimiter(1000, 2);
  assert.equal(limiter.hit('a', 0), 0);
  assert.equal(limiter.hit('a', 100), 0);
  assert.equal(limiter.hit('a', 200), 1, 'third hit waits out the window');
  assert.equal(limiter.hit('b', 200), 0, 'other keys are unaffected');
  assert.equal(limiter.hit('a', 1000), 0, 'new window');
  limiter.stop();
});
