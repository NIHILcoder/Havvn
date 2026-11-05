import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Both room editors follow the active Havvn palette, including custom themes.
export const roomEditorHighlight = HighlightStyle.define([
  { tag: [tags.heading, tags.strong], color: 'var(--color-text-primary)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.null, tags.processingInstruction], color: 'var(--color-accent-primary)' },
  { tag: tags.string, color: 'var(--color-success)' },
  { tag: [tags.number, tags.propertyName, tags.tagName, tags.link], color: 'var(--color-info)' },
  { tag: [tags.comment, tags.meta], color: 'var(--color-text-secondary)' },
  { tag: tags.invalid, color: 'var(--color-error)' },
]);
