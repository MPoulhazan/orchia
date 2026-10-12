import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from './api';
import { SMOOTH_SCROLL_MS, useSmoothScroll } from './smoothScroll';

interface Props {
  sessionId: string;
  theme: ITheme;
  /** Changing this value moves keyboard focus back into the terminal. */
  focusKey?: number;
  fontSize?: number;
  /** Take keyboard focus once the terminal is ready. */
  autoFocus?: boolean;
}

export function TerminalView({ sessionId, theme, focusKey, fontSize = 13, autoFocus = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const refitRef = useRef<() => void>(() => {});
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const smoothScroll = useSmoothScroll().enabled;
  const smoothScrollRef = useRef(smoothScroll);
  smoothScrollRef.current = smoothScroll;
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;

    const term = new Terminal({
      fontFamily: '"Atkinson Hyperlegible Mono Variable", ui-monospace, monospace',
      fontSize: fontSizeRef.current,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      smoothScrollDuration: smoothScrollRef.current ? SMOOTH_SCROLL_MS : 0,
      allowProposedApi: true,
      theme: themeRef.current,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    const ws = new WebSocket(api.streamUrl(sessionId));
    const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    const sendSize = () => {
      if (disposed || !term.element || !host.clientWidth || !host.clientHeight) return;
      fit.fit();
      send({ t: 'resize', cols: term.cols, rows: term.rows });
    };

    refitRef.current = sendSize;

    term.attachCustomKeyEventHandler((e) => {
      // Shift+Enter inserts a newline in Claude's prompt: send a line feed (Ctrl+J).
      // Swallow the keypress too, or xterm sends an extra \r that submits the prompt.
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown') send({ t: 'in', d: '\n' });
        e.preventDefault();
        return false;
      }
      if (e.type !== 'keydown') return true;
      // Ctrl+C copies when text is selected, otherwise it interrupts as usual.
      if (e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Let the browser fire a paste event, which xterm turns into input.
      if (e.ctrlKey && e.key === 'v') return false;
      return true;
    });

    term.onData((d) => send({ t: 'in', d }));

    // Images can't go through the PTY: the server saves them and we type their
    // paths, which Claude Code turns into [Image #n] attachments.
    let noticeTimer = 0;
    const flash = (text: string) => {
      setNotice(text);
      clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setNotice(null), 4000);
    };
    const attach = async (images: File[]) => {
      for (const image of images) {
        try {
          const { path } = await api.pasteImage(sessionId, image);
          if (disposed) return;
          term.paste(path + ' ');
        } catch (err) {
          flash(`Couldn't attach the image: ${(err as Error).message}`);
          return;
        }
      }
      term.focus();
    };
    const imagesIn = (files: FileList | undefined | null) =>
      [...(files ?? [])].filter((f) => f.type.startsWith('image/'));

    // Text wins when the clipboard has both (Excel copies cells as text and as a picture).
    const onPaste = (e: ClipboardEvent) => {
      const images = imagesIn(e.clipboardData?.files);
      if (!images.length || e.clipboardData?.getData('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      attach(images);
    };
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!host.contains(e.relatedTarget as Node | null)) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const images = imagesIn(e.dataTransfer?.files);
      if (images.length) attach(images);
      else flash('Only images can be dropped here.');
    };
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);

    ws.onopen = sendSize;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.t === 'snapshot') {
        // Lay the saved screen out at the size it was captured at, then fit:
        // writing it at another width would wrap every line wrongly.
        term.resize(msg.cols, msg.rows);
        term.write(msg.d, sendSize);
      }
      if (msg.t === 'out') term.write(msg.d);
      if (msg.t === 'reset') {
        term.reset();
        sendSize();
      }
    };

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sendSize);
    });

    // Wait for the monospace font so the cell grid is measured correctly.
    document.fonts.load('13px "Atkinson Hyperlegible Mono Variable"').finally(() => {
      if (disposed) return;
      term.open(host);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Falls back to the DOM renderer.
      }
      sendSize();
      observer.observe(host);
      if (autoFocusRef.current) term.focus();
    });

    return () => {
      disposed = true;
      termRef.current = null;
      clearTimeout(noticeTimer);
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
      cancelAnimationFrame(frame);
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.smoothScrollDuration = smoothScroll ? SMOOTH_SCROLL_MS : 0;
  }, [smoothScroll]);

  useEffect(() => {
    if (focusKey) termRef.current?.focus();
  }, [focusKey]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    refitRef.current();
  }, [fontSize]);

  // Padding lives on the wrapper: the fit addon measures the inner element's
  // parent and would count border-box padding as usable space.
  return (
    <div className="terminal-frame" data-dragging={dragging}>
      <div className="terminal-host" ref={hostRef} />
      {dragging && <div className="terminal-drop">Drop an image to attach it</div>}
      {notice && (
        <div className="terminal-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
