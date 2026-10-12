import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  CornerDownLeft,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  LayoutGrid,
  Monitor,
  Package,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Square,
  Sun,
} from 'lucide-react';
import { api, type FolderListing, type Project, type Suggestion } from './api';
import { fuzzyScore } from './fuzzy';
import type { ThemePref } from './theme';
import type { View } from './Sidebar';

export type PaletteMode = 'root' | 'browse';

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  /** Return true to keep the palette open (e.g. navigating folders). */
  run: () => boolean | void;
}

interface Props {
  initialMode: PaletteMode;
  projects: Project[];
  currentProject: Project | null;
  view: View;
  onClose: () => void;
  onOpenProject: (project: Project) => void;
  onAddPath: (path: string) => Promise<void>;
  onNewSession: (project: Project) => void;
  onSetTheme: (pref: ThemePref) => void;
  /** Opens the dialog itself, so the palette must not refocus the terminal. */
  onOpenSettings: () => void;
  onSetView: (view: View) => void;
  onToggleSidebar: () => void;
  /** Only in the focus view, with a session shown. */
  onToggleInspector?: () => void;
  /** With a session shown. */
  onAddSkill?: () => void;
}

const ICON = 15;
const looksLikePath = (q: string) => /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(q);

export function CommandPalette(props: Props) {
  const { projects, currentProject, onClose } = props;
  const [mode, setMode] = useState<PaletteMode>(props.initialMode);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.suggestions().then(setSuggestions).catch(() => {});
  }, []);

  useEffect(() => {
    if (mode === 'browse' && !listing) navigate(undefined);
  }, [mode]);

  function navigate(path: string | undefined) {
    setError('');
    api
      .folders(path)
      .then((l) => {
        setListing(l);
        setQuery('');
        setActive(0);
      })
      .catch((e) => setError(e.message));
    inputRef.current?.focus();
  }

  function add(path: string) {
    setError('');
    props.onAddPath(path).then(onClose, (e) => setError(e.message));
    return true; // closed by onAddPath once the project exists
  }

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const rank = <T,>(list: T[], text: (x: T) => string) =>
      list
        .map((x) => ({ x, s: fuzzyScore(q, text(x)) }))
        .filter((r) => r.s !== null)
        .sort((a, b) => (q ? b.s! - a.s! : 0))
        .map((r) => r.x);

    if (mode === 'browse') {
      const out: Item[] = [];
      if (q && looksLikePath(q)) {
        out.push({ id: 'goto', group: 'Go to', label: q, icon: <CornerDownLeft size={ICON} />, run: () => (navigate(q), true) });
      }
      if (listing?.path) {
        out.push({
          id: 'add-here',
          group: 'Folder',
          label: `Add “${listing.path.split(/[\\/]/).filter(Boolean).pop() ?? listing.path}” as project`,
          detail: listing.path,
          icon: <FolderPlus size={ICON} />,
          run: () => add(listing.path!),
        });
        out.push({
          id: 'up',
          group: 'Folder',
          label: 'Parent folder',
          icon: <ArrowUp size={ICON} />,
          run: () => (navigate(listing.parent ?? ''), true),
        });
      }
      for (const dir of rank(listing?.dirs ?? [], (d) => d.name)) {
        out.push({ id: dir.path, group: 'Folders', label: dir.name, icon: <Folder size={ICON} />, run: () => (navigate(dir.path), true) });
      }
      return out;
    }

    const known = new Set(projects.map((p) => p.path.toLowerCase()));
    const out: Item[] = [];
    for (const p of rank(projects, (p) => p.name)) {
      out.push({ id: p.id, group: 'Projects', label: p.name, detail: p.path, icon: <Folder size={ICON} />, run: () => props.onOpenProject(p) });
    }
    for (const s of rank(suggestions.filter((s) => !known.has(s.path.toLowerCase())), (s) => s.name)) {
      out.push({ id: s.path, group: 'Recent in Claude Code', label: s.name, detail: s.path, icon: <History size={ICON} />, run: () => add(s.path) });
    }

    const actions: Item[] = [
      { id: 'browse', group: 'Actions', label: 'Browse folders…', icon: <FolderOpen size={ICON} />, run: () => (setMode('browse'), setQuery(''), setActive(0), true) },
      ...(currentProject
        ? [{ id: 'new', group: 'Actions', label: `New session in ${currentProject.name}`, icon: <Plus size={ICON} />, run: () => props.onNewSession(currentProject) }]
        : []),
      props.view === 'grid'
        ? { id: 'view', group: 'Actions', label: 'Switch to focus view', icon: <Square size={ICON} />, run: () => props.onSetView('focus') }
        : { id: 'view', group: 'Actions', label: 'Switch to grid view', icon: <LayoutGrid size={ICON} />, run: () => props.onSetView('grid') },
      { id: 'sidebar', group: 'Actions', label: 'Toggle sidebar', icon: <PanelLeft size={ICON} />, run: () => props.onToggleSidebar() },
      ...(props.onToggleInspector
        ? [{ id: 'inspector', group: 'Actions', label: 'Show or hide the inspector', icon: <PanelRight size={ICON} />, run: () => props.onToggleInspector!() }]
        : []),
      ...(props.onAddSkill
        ? [{ id: 'add-skill', group: 'Actions', label: `Add skill to ${currentProject?.name ?? 'this project'}…`, icon: <Package size={ICON} />, run: () => (props.onAddSkill!(), true) }]
        : []),
      { id: 'settings', group: 'Actions', label: 'Settings…', icon: <Settings size={ICON} />, run: () => (props.onOpenSettings(), true) },
      { id: 'theme-system', group: 'Actions', label: 'Theme: System', icon: <Monitor size={ICON} />, run: () => props.onSetTheme('system') },
      { id: 'theme-light', group: 'Actions', label: 'Theme: Light', icon: <Sun size={ICON} />, run: () => props.onSetTheme('light') },
      { id: 'theme-dark', group: 'Actions', label: 'Theme: Dark', icon: <Moon size={ICON} />, run: () => props.onSetTheme('dark') },
    ];
    out.push(...rank(actions, (a) => a.label));
    if (q && looksLikePath(q)) {
      out.unshift({ id: 'add-path', group: 'Add', label: `Add ${q}`, icon: <FolderPlus size={ICON} />, run: () => add(q) });
    }
    return out;
  }, [mode, query, listing, projects, suggestions, currentProject, props.view, !props.onToggleInspector, !props.onAddSkill]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [active, items]);

  function runItem(item: Item | undefined) {
    if (!item) return;
    if (!item.run()) onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'browse' && props.initialMode === 'root') {
        setMode('root');
        setQuery('');
      } else onClose();
    } else if (e.key === 'Backspace' && !query && mode === 'browse' && listing) {
      e.preventDefault();
      navigate(listing.parent ?? '');
    }
  }

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        {mode === 'browse' && (
          <div className="palette-crumb">
            <FolderOpen size={13} />
            <span>{listing?.path ?? 'This PC'}</span>
          </div>
        )}
        <input
          ref={inputRef}
          className="palette-input"
          autoFocus
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode === 'browse' ? 'Filter folders, or paste a path…' : 'Search projects, folders and actions…'}
        />
        {error && <div className="palette-error">{error}</div>}
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">No results</div>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header}
                <div
                  className="palette-item"
                  data-active={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => runItem(item)}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> select</span>
          {mode === 'browse' && <span><kbd>Backspace</kbd> parent</span>}
          <span><kbd>Esc</kbd> {mode === 'browse' && props.initialMode === 'root' ? 'back' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}
