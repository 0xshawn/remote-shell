import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ShellConnection, type ShellState } from '../shellWs';

// One persistent terminal per shell tab. Stays mounted (hidden when inactive)
// so the xterm instance and its /ws connection survive tab switches.
export function ShellView({ sessionId, active }: { sessionId: string; active: boolean }) {
  const elRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<ShellConnection | null>(null);
  const stateRef = useRef<ShellState>('connecting');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 14,
      scrollback: 1000,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff' },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(elRef.current!);
    try { fit.fit(); } catch { /* not visible yet */ }
    termRef.current = term;
    fitRef.current = fit;

    const conn = new ShellConnection(sessionId, {
      onData: (d) => term.write(d),
      onState: (s) => { stateRef.current = s; },
      getSize: () => ({ cols: term.cols, rows: term.rows }),
    });
    connRef.current = conn;
    conn.connect();

    term.onData((d) => conn.input(d));

    const onResize = () => {
      try { fit.fit(); } catch { /* ignore */ }
      conn.sendResize();
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(elRef.current!);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      conn.close();
      term.dispose();
    };
  }, [sessionId]);

  // When this tab becomes active, re-fit and focus.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      connRef.current?.sendResize();
      termRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div className={'view' + (active ? '' : ' hidden')}>
      <div className="shell-term" ref={elRef} />
    </div>
  );
}
