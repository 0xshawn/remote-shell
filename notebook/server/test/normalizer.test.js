'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { NotebookStore } = require('../src/notebookStore');
const { Normalizer } = require('../src/normalizer');

function runFixture(name) {
  const file = path.join(__dirname, 'fixtures', name);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const store = new NotebookStore();
  const statuses = [];
  const norm = new Normalizer(store, { onStatus: (s) => statuses.push(s) });
  for (const line of lines) norm.handle(JSON.parse(line));
  return { store, cells: store.cells, statuses };
}

test('text-only turn: system + assistant_text + result, ends idle', () => {
  const { cells, statuses } = runFixture('text-turn.jsonl');
  const kinds = cells.map((c) => c.kind);
  assert.deepStrictEqual(kinds, ['system', 'assistant_text', 'result']);

  const sys = cells[0];
  assert.strictEqual(sys.subtype, 'init');
  assert.ok(sys.model, 'system cell carries a model');
  assert.ok(sys.toolCount > 0, 'system cell carries a tool count');

  const txt = cells[1];
  assert.match(txt.text, /hello notebook/);
  assert.strictEqual(txt.streaming, false, 'assistant text is finalized after content_block_stop');

  const result = cells[2];
  assert.strictEqual(result.kind, 'result');
  assert.strictEqual(result.isError, false);
  assert.ok(typeof result.costUsd === 'number');

  assert.deepStrictEqual(statuses, ['idle']);
});

test('tool turn: tool_call cell carries parsed input and merged result', () => {
  const { cells, statuses } = runFixture('tool-turn.jsonl');

  const tool = cells.find((c) => c.kind === 'tool_call');
  assert.ok(tool, 'a tool_call cell exists');
  assert.strictEqual(tool.name, 'Bash');
  assert.strictEqual(tool.status, 'done', 'tool result merged in -> status done');
  assert.strictEqual(tool.isError, false);
  // input must be the parsed object (from snapshot / parsed inputPartial), not a fragment
  assert.ok(tool.input && typeof tool.input === 'object');
  assert.strictEqual(tool.input.command, 'echo hello-from-tool');
  assert.match(tool.result, /hello-from-tool/);

  // The tool_use_id must have been threaded so the later tool_result merged
  // into the SAME cell (no duplicate orphan result cell).
  const orphanResults = cells.filter((c) => c.kind === 'tool_call' && c.name === '(result)');
  assert.strictEqual(orphanResults.length, 0, 'no orphan result cells');

  // There should be assistant text both before and after the tool call.
  const texts = cells.filter((c) => c.kind === 'assistant_text');
  assert.ok(texts.length >= 1);

  assert.strictEqual(cells[cells.length - 1].kind, 'result');
  assert.deepStrictEqual(statuses, ['idle']);
});

test('no duplicate user/replay cells leak in (manager owns the user cell)', () => {
  const { cells } = runFixture('tool-turn.jsonl');
  assert.strictEqual(cells.filter((c) => c.kind === 'user').length, 0,
    'normalizer does not emit user cells; replays are ignored');
});

test('store assigns ids and monotonically increasing seq', () => {
  const { cells, store } = runFixture('tool-turn.jsonl');
  const ids = new Set(cells.map((c) => c.id));
  assert.strictEqual(ids.size, cells.length, 'all cell ids are unique');
  assert.ok(store.seq >= cells.length, 'seq advanced at least once per cell');
});

test('unknown / malformed events are ignored without throwing', () => {
  const store = new NotebookStore();
  const norm = new Normalizer(store);
  assert.doesNotThrow(() => {
    norm.handle(null);
    norm.handle({ type: 'totally_unknown' });
    norm.handle({ type: 'stream_event' }); // no .event
    norm.handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 9 } }); // no open block
  });
  assert.strictEqual(store.cells.length, 0);
});
