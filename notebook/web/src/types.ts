// Shared types mirroring the server's cell model and protocol.

export type SessionStatus = 'idle' | 'running' | 'waiting_input' | 'error' | 'exited';

export type CellKind =
  | 'system'
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'result'
  | 'error';

export interface Cell {
  id: string;
  seq: number;
  ts: number;
  kind: CellKind;
  // system
  subtype?: string;
  model?: string | null;
  cwd?: string | null;
  permissionMode?: string | null;
  toolCount?: number | null;
  // user / assistant_text / thinking
  text?: string;
  streaming?: boolean;
  // tool_call
  toolUseId?: string | null;
  name?: string;
  inputPartial?: string;
  input?: unknown;
  status?: 'streaming' | 'pending' | 'done' | 'error';
  result?: string;
  isError?: boolean;
  parentToolUseId?: string | null;
  // result
  numTurns?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  // error
  message?: string;
}

export interface SessionSummary {
  id: string;
  kind: 'shell' | 'claude';
  label: string;
  status?: SessionStatus;
  cwd?: string;
  model?: string | null;
  permissionMode?: string;
  createdAt?: number;
}

// ---- /nbws server -> client messages ----
export type NbServerMsg =
  | { type: 'snapshot'; sessionId: string; status: SessionStatus; seq: number; cells: Cell[] }
  | { type: 'cell'; sessionId: string; op: 'add' | 'update'; seq: number; cell: Cell }
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'session_ended'; sessionId: string };
