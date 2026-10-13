import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { parseFileRequest, fileRequestText } from '../shared/room-chat-tools';
import { parseChatSegments, splitLinks, isCopyworthy } from '../shared/chat-format';
import { t } from './i18n';
const source = readFileSync(new URL('./ui.ts', import.meta.url), 'utf8');
const esc = source.slice(source.indexOf('function esc('), source.indexOf('function dayLabel('));
const body = source.slice(source.indexOf('function renderBody('), source.indexOf('function hudTitle('));
const context = { parseFileRequest, parseChatSegments, splitLinks, isCopyworthy, t, renderBody: undefined as unknown as (text: string, lang: 'en' | 'ru') => string };
vm.runInNewContext(ts.transpileModule(esc + body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
it('renders request status and escaped title instead of protocol JSON in browser guests', () => {
  const html = context.renderBody(fileRequestText({ title: '<img src=x onerror=alert(1)>', status: 'fulfilled', fileIds: ['file-A'] }), 'ru');
  expect(html).toContain('Выполнен'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('havvn-request-v1');
  expect(context.renderBody('🙋 Please share a map', 'en')).toContain('File request · Open');
});
