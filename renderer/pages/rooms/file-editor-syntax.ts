import { StreamLanguage } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { javascript, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { css } from '@codemirror/legacy-modes/mode/css';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import type { SyncEditorDraft } from '../../../shared/room-file-sync-editor';

/** Parsing is presentation only; main-process UTF-8, format and write checks remain authoritative. */
export function fileEditorSyntax(draft: Pick<SyncEditorDraft, 'path' | 'language'>) {
  if (draft.language === 'markdown') return markdown();
  if (draft.language === 'json') return json();
  if (draft.language === 'xml') return xml();
  switch (draft.path.split('.').at(-1)?.toLowerCase()) {
    case 'cs': return StreamLanguage.define(csharp);
    case 'js': case 'jsx': return StreamLanguage.define(javascript);
    case 'ts': case 'tsx': return StreamLanguage.define(typescript);
    case 'css': return StreamLanguage.define(css);
    case 'html': return xml();
    case 'jsonc': return StreamLanguage.define(javascript);
    case 'yaml': case 'yml': return StreamLanguage.define(yaml);
    case 'toml': return StreamLanguage.define(toml);
    case 'sh': return StreamLanguage.define(shell);
    case 'ps1': return StreamLanguage.define(powerShell);
    case 'sql': return StreamLanguage.define(standardSQL);
    case 'ini': case 'cfg': case 'conf': return StreamLanguage.define(properties);
    default: return [];
  }
}
