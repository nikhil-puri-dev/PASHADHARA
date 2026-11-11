import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModelJson } from '../src/model-json.ts';

test('accepts JSON or exactly one complete JSON fence', () => {
  assert.deepEqual(parseModelJson('{"findings":[]}'), { findings: [] });
  assert.deepEqual(parseModelJson('```json\n{"findings":[]}\n```'), { findings: [] });
  assert.throws(() => parseModelJson('prefix\n```json\n{}\n```'));
  assert.throws(() => parseModelJson('```json\n{}\n```\n```json\n{}\n```'));
  assert.throws(() => parseModelJson('```json\n{}'));
});
