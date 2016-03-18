import assert from 'assert';
import test from 'testit';

test('node-release', () => {
  const nodeRelease = require('../../src/bots/node-release').default;
  return nodeRelease({dryRun: true}).then(result => {
    assert(Array.isArray(result), 'Expected an array');
    assert(result.every(calls => Array.isArray(calls)), 'Expected an array of arrays');
  });
});
