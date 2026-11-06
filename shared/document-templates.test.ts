import { expect, it } from 'vitest';
import { DOCUMENT_TEMPLATES, documentTemplate } from './document-templates';
import { validDocumentText } from './room-documents';

it('provides ordinary editable, bounded text in both application languages', () => {
  for (const id of DOCUMENT_TEMPLATES) for (const language of ['ru', 'en']) {
    const value = documentTemplate(id, language);
    expect(validDocumentText(value.text)).toBe(true);
    expect(Object.keys(value).sort()).toEqual(['language', 'text', 'title']);
    expect(value.text).not.toMatch(/https?:|<script|data:|javascript:/i);
    if (id !== 'blank') expect(value.title.length).toBeGreaterThan(0);
  }
  expect(documentTemplate('meeting', 'ru').text).toContain('Решения');
  expect(documentTemplate('meeting', 'en').text).toContain('Decisions');
  expect(documentTemplate('tasks', 'ru').text).toContain('- [ ]');
  expect(documentTemplate('blank', 'ru').text).toBe('');
});
