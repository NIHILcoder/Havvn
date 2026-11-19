export const DOCUMENT_TEMPLATES = ['blank', 'meeting', 'tasks', 'project', 'links'] as const;
export type DocumentTemplateId = typeof DOCUMENT_TEMPLATES[number];
/** Ordinary editable text; no URLs, resources, callbacks or permission changes. */
export function documentTemplate(id: DocumentTemplateId, language: string): { title: string; text: string; language: 'markdown' | 'text' } {
  const ru = language === 'ru';
  const templates = {
    blank: { title: '', text: '' },
    meeting: ru ? { title: 'Заметки встречи', text: '# Заметки встречи\n\nДата: \nУчастники: \n\n## Повестка\n\n- \n\n## Решения\n\n- \n\n## Следующие шаги\n\n- [ ] Задача — ответственный — срок\n' } : { title: 'Meeting notes', text: '# Meeting notes\n\nDate: \nParticipants: \n\n## Agenda\n\n- \n\n## Decisions\n\n- \n\n## Next steps\n\n- [ ] Task — owner — deadline\n' },
    tasks: ru ? { title: 'Задачи', text: '# Задачи\n\n## Запланировано\n\n- [ ] Задача — ответственный — срок\n\n## В работе\n\n- [ ] \n\n## Готово\n\n- [x] \n' } : { title: 'Tasks', text: '# Tasks\n\n## Planned\n\n- [ ] Task — owner — deadline\n\n## In progress\n\n- [ ] \n\n## Done\n\n- [x] \n' },
    project: ru ? { title: 'Инструкция проекта', text: '# Проект\n\n## Назначение\n\nОпишите цель проекта.\n\n## Подготовка\n\n1. \n\n## Запуск\n\n1. \n\n## Проверка результата\n\n- [ ] \n\n## Полезные сведения\n\n- \n' } : { title: 'Project guide', text: '# Project\n\n## Purpose\n\nDescribe the goal of this project.\n\n## Setup\n\n1. \n\n## Run\n\n1. \n\n## Verify\n\n- [ ] \n\n## Useful details\n\n- \n' },
    links: ru ? { title: 'Полезные ссылки', text: '# Полезные ссылки\n\n## Документы\n\n- Название — ссылка — описание\n\n## Инструменты\n\n- Название — ссылка — описание\n' } : { title: 'Useful links', text: '# Useful links\n\n## Documents\n\n- Name — link — description\n\n## Tools\n\n- Name — link — description\n' },
  };
  return { ...templates[id], language: 'markdown' };
}
