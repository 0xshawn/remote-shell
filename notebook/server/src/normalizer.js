'use strict';

// ============================================================================
// Normalizer: claude stream-json events -> notebook cell model.
//
// Tolerant state machine. Streaming content blocks build cells live (token by
// token); the full `assistant` message snapshot then reconciles/repairs them
// (it is authoritative for content). Tool results arrive later as `user`
// events and are merged back into the matching tool_call cell by tool_use_id.
//
// Design rules (verified against claude v2.1.183 captures):
//   - Stream blocks are keyed by `${messageId}:${index}` (index resets per msg).
//   - `input_json_delta.partial_json` fragments are concatenated, never parsed
//     mid-stream; the assistant snapshot carries the complete `input` object.
//   - `user` events with `isReplay:true` are the echo of our own input; the
//     manager already added an optimistic user cell, so we ignore replays here.
//   - Unknown event types are ignored (forward-compatible).
// ============================================================================

const RESULT_MAX = 100 * 1000; // cap a single tool result we keep in a cell

function truncate(s) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= RESULT_MAX) return s;
  return s.slice(0, RESULT_MAX) + `\n…[truncated ${s.length - RESULT_MAX} chars]`;
}

// tool_result `content` is a string, or an array of content blocks.
function stringifyToolContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n');
  }
  return JSON.stringify(content);
}

class Normalizer {
  // store: NotebookStore; opts.onStatus(status): called on terminal result.
  constructor(store, opts = {}) {
    this.store = store;
    this.onStatus = opts.onStatus || (() => {});
    this.curMsgId = null;
    this.blocks = new Map(); // `${msgId}:${index}` -> cell
    this.tools = new Map(); // tool_use_id -> tool_call cell
    this._sawInit = false; // emit the system banner only once per session
  }

  handle(o) {
    if (!o || typeof o !== 'object') return;
    switch (o.type) {
      case 'system': return this._system(o);
      case 'stream_event': return this._stream(o);
      case 'assistant': return this._assistant(o);
      case 'user': return this._user(o);
      case 'result': return this._result(o);
      default: return; // ignore unknown top-level types
    }
  }

  _system(o) {
    if (o.subtype !== 'init') return; // 'status' and others: ignore
    if (this._sawInit) return; // resumed turns re-emit init; show the banner once
    this._sawInit = true;
    this.store.add({
      kind: 'system',
      subtype: 'init',
      model: o.model || null,
      cwd: o.cwd || null,
      permissionMode: o.permissionMode || null,
      toolCount: Array.isArray(o.tools) ? o.tools.length : null,
    });
  }

  _stream(o) {
    const e = o.event;
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'message_start':
        this.curMsgId = e.message && e.message.id ? e.message.id : this.curMsgId;
        return;
      case 'content_block_start':
        return this._blockStart(o, e);
      case 'content_block_delta':
        return this._blockDelta(e);
      case 'content_block_stop':
        return this._blockStop(e);
      default:
        return; // message_delta / message_stop / unknown: nothing to render
    }
  }

  _key(index) {
    return `${this.curMsgId}:${index}`;
  }

  _blockStart(o, e) {
    const cb = e.content_block || {};
    const key = this._key(e.index);
    let cell = null;
    if (cb.type === 'text') {
      cell = this.store.add({ kind: 'assistant_text', text: '', streaming: true });
    } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
      cell = this.store.add({ kind: 'thinking', text: '', streaming: true });
    } else if (cb.type === 'tool_use') {
      const hasInput = cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length > 0;
      cell = this.store.add({
        kind: 'tool_call',
        toolUseId: cb.id || null,
        name: cb.name || '(tool)',
        inputPartial: '',
        input: hasInput ? cb.input : null,
        status: 'streaming',
        parentToolUseId: o.parent_tool_use_id || null,
      });
      if (cb.id) this.tools.set(cb.id, cell);
    }
    if (cell) this.blocks.set(key, cell);
  }

  _blockDelta(e) {
    const cell = this.blocks.get(this._key(e.index));
    if (!cell) return;
    const d = e.delta || {};
    if (d.type === 'text_delta' && cell.kind === 'assistant_text') {
      cell.text += d.text || '';
      this.store.update(cell);
    } else if (d.type === 'thinking_delta' && cell.kind === 'thinking') {
      cell.text += d.thinking || '';
      this.store.update(cell);
    } else if (d.type === 'input_json_delta' && cell.kind === 'tool_call') {
      cell.inputPartial += d.partial_json || '';
      this.store.update(cell);
    }
    // signature_delta and others: ignore
  }

  _blockStop(e) {
    const cell = this.blocks.get(this._key(e.index));
    if (!cell) return;
    cell.streaming = false;
    if (cell.kind === 'tool_call' && !cell.input && cell.inputPartial) {
      try { cell.input = JSON.parse(cell.inputPartial); } catch { /* keep raw inputPartial */ }
    }
    this.store.update(cell);
  }

  // Per-flush message snapshot. NOTE: each `assistant` event carries only the
  // block(s) just finalized (array index restarts at 0 per snapshot), so we do
  // NOT key by array position. Text/thinking are already fully built from the
  // delta stream (--include-partial-messages is always on), so the snapshot is
  // used only as a safety net to repair tool calls, matched by tool_use_id:
  // it backfills the complete `input` object and surfaces a tool we somehow
  // missed the stream-start for (e.g. a subagent's).
  _assistant(o) {
    const content = (o.message && Array.isArray(o.message.content)) ? o.message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const id = block.id || null;
      const existing = id ? this.tools.get(id) : null;
      if (existing) {
        existing.name = block.name || existing.name;
        if (block.input && typeof block.input === 'object') existing.input = block.input;
        if (existing.status === 'streaming') existing.status = 'pending';
        this.store.update(existing);
      } else {
        const cell = this.store.add({
          kind: 'tool_call',
          toolUseId: id,
          name: block.name || '(tool)',
          inputPartial: '',
          input: block.input || null,
          status: 'pending',
          parentToolUseId: o.parent_tool_use_id || null,
        });
        if (id) this.tools.set(id, cell);
      }
    }
  }

  _user(o) {
    if (o.isReplay) return; // echo of our own input; optimistic cell already added
    const content = (o.message && Array.isArray(o.message.content)) ? o.message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const text = truncate(stringifyToolContent(block.content));
      const isError = !!block.is_error;
      const cell = this.tools.get(block.tool_use_id);
      if (cell) {
        cell.result = text;
        cell.isError = isError;
        cell.status = isError ? 'error' : 'done';
        this.store.update(cell);
      } else {
        // Unmatched result (e.g. from a subagent whose tool_use we didn't see).
        this.store.add({
          kind: 'tool_call',
          toolUseId: block.tool_use_id || null,
          name: '(result)',
          inputPartial: '',
          input: null,
          status: isError ? 'error' : 'done',
          result: text,
          isError,
          parentToolUseId: o.parent_tool_use_id || null,
        });
      }
    }
  }

  _result(o) {
    this.store.add({
      kind: 'result',
      subtype: o.subtype || null,
      isError: !!o.is_error,
      numTurns: o.num_turns ?? null,
      costUsd: o.total_cost_usd ?? null,
      durationMs: o.duration_ms ?? null,
    });
    this.onStatus(o.is_error ? 'error' : 'idle');
  }
}

module.exports = { Normalizer, stringifyToolContent, truncate };
