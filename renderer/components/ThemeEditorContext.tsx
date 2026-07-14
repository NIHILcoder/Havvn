/**
 * Theme-editor open/close, hoisted to the app root.
 *
 * The editor is no longer a Settings modal — it is a top-level dock panel that
 * lives beside the whole app and survives page navigation. So the open state has
 * to live above the pages: the Settings → Interface button calls openEditor() from
 * here, and AppContent renders the dock at the shell level when open is true. That
 * way you can click Rooms/Downloads with the dock open and watch them recolor.
 */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

interface ThemeEditorContextValue {
  open: boolean;
  openEditor: () => void;
  closeEditor: () => void;
}

const ThemeEditorCtx = createContext<ThemeEditorContextValue | null>(null);

export const ThemeEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false);
  const openEditor = useCallback(() => setOpen(true), []);
  const closeEditor = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, openEditor, closeEditor }), [open, openEditor, closeEditor]);
  return <ThemeEditorCtx.Provider value={value}>{children}</ThemeEditorCtx.Provider>;
};

export function useThemeEditor(): ThemeEditorContextValue {
  const ctx = useContext(ThemeEditorCtx);
  if (!ctx) throw new Error('useThemeEditor must be used within a ThemeEditorProvider');
  return ctx;
}
