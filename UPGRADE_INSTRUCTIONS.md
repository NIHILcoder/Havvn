# DownloadsPage.tsx - Инструкции по обновлению

## ✅ ЧТО УЖЕ СДЕЛАНО:

1. **Цветовая палитра** - обновлена в `variables.css`
2. **Toast компонент** - создан `Toast.tsx` и `Toast.css`
3. **ContextMenu компонент** - создан `ContextMenu.tsx` и `ContextMenu.css`
4. **StatusBadge с иконками** - обновлен `Badge.tsx`
5. **CSS стили** - добавлены стили для поиска, фильтров, bulk-actions в `DownloadsPage.css`
6. **Типы** - добавлены `totalSize` и `priority` в `Download` interface
7. **Размер файла в компактном виде** - обновлен компактный вид

## 📝 ЧТО НУЖНО ДОДЕЛАТЬ ВРУЧНУЮ:

### Обновить DownloadsPage.tsx:

Замени импорты в начале файла на:
```tsx
import {
  Button,
  Icon,
  Input,
  ProgressBar,
  StatusBadge,
  ToastContainer,  // вместо Alert
  EmptyState,
  FilePreview,
  ContextMenu,     // новое
  ContextMenuItem  // новое
} from '../components';
```

Добавь в state компонента DownloadsPage:
```tsx
// Toast notifications
const [toasts, setToasts] = useState<Array<{
  id: string;
  message: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}>>([]);

// Search
const [searchQuery, setSearchQuery] = useState('');

// Selection
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

// Context menu
const [contextMenu, setContextMenu] = useState<{
  x: number;
  y: number;
  downloadId: string;
} | null>(null);
```

Добавь helpers для toasts:
```tsx
const addToast = useCallback((message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 5000) => {
  const id = `toast-${Date.now()}-${Math.random()}`;
  setToasts(prev => [...prev, { id, message, variant, duration }]);
}, []);

const removeToast = useCallback((id: string) => {
  setToasts(prev => prev.filter(t => t.id !== id));
}, []);
```

Замени все `setMessage` на `addToast`.

Добавь фильтрацию по поиску в filteredDownloads:
```tsx
const filteredDownloads = downloads.filter(download => {
  if (searchQuery && !download.name.toLowerCase().includes(searchQuery.toLowerCase())) {
    return false;
  }
  // ... остальная фильтрация
});
```

Добавь в JSX ПЕРЕД списком загрузок:

1. **Поиск и фильтры** (см. полный код в выводе subagent выше)
2. **Bulk actions bar** (когда selectedIds.size > 0)
3. **Обработчики для bulk операций** (handlePauseAll, handleResumeAll, handleClearCompleted)
4. **Context menu** - добавь props onContextMenu в DownloadItem
5. **<ToastContainer>** - в конце return, вместо/вместе с message

## 🔄 АЛЬТЕРНАТИВА:

Если хочешь полностью обновленную версию:
1. Сохрани текущий `DownloadsPage.tsx` как backup
2. Скопируй полный код из вывода subagent выше (начинается с "/**")
3. Вставь его вместо текущего содержимого

## ⚠️ ВАЖНО:

Некоторые функции используют `download.totalSize` и `download.magnetUri` - убедись что эти поля есть в твоих данных или добавь проверки:
```tsx
{download.totalSize > 0 && <span>{formatBytes(download.totalSize)}</span>}
{download.magnetUri && /* ... */}
```

## 🎨 ЧТО ПОЛУЧИШЬ:

✅ Поиск по названию
✅ Tabs Active/Completed
✅ Checkboxes для мультиselect
✅ Bulk-операции (Pause All, Resume All, Clear Completed)
✅ Контекстное меню (правый клик)
✅ Toast уведомления
✅ Размер файла в компактном виде
✅ Иконки в badges
✅ Улучшенная палитра

## 📦 РЕЗЕРВНАЯ КОПИЯ:

Создана: `DownloadsPage.tsx.backup`
