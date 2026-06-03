import React, { createContext, useContext, useState, useEffect } from 'react';

type Language = 'en' | 'ru';

// Simple dictionary
const dictionary = {
  en: {
    // Sidebar
    'nav.downloads': 'Downloads',
    'nav.catalog': 'Catalog',
    'nav.settings': 'Settings',
    'nav.create': 'Create Torrent',
    'nav.menu': 'Menu',
    
    // Downloads
    'filter.all': 'All',
    'filter.downloading': 'Downloading',
    'filter.completed': 'Completed',
    'filter.paused': 'Paused',
    'filter.error': 'Error',
    'btn.addTorrent': 'Add Torrent',
    'btn.addUrl': 'Add URL/Magnet',
    'search.placeholder': 'Search downloads...',
    'table.name': 'Name',
    'table.size': 'Size',
    'table.progress': 'Progress',
    'table.status': 'Status',
    'table.speed': 'Speed',
    'table.eta': 'ETA',
    'table.peers': 'Peers',
    'context.pause': 'Pause',
    'context.resume': 'Resume',
    'context.delete': 'Delete',
    'context.deleteFiles': 'Delete with files',
    'context.openFolder': 'Open Folder',
    'context.copyMagnet': 'Copy Magnet Link',
    
    // Catalog
    'catalog.title': 'Community Catalog',
    'catalog.subtitle': 'Discover public domain and open source content',
    'catalog.search': 'Search catalog...',
    'catalog.refresh': 'Refresh',
    'catalog.add': 'Add to Downloads',
    'catalog.category.all': 'All Categories',
    
    // Create Torrent
    'create.title': 'Create New Torrent',
    'create.subtitle': 'Share your files with the world',
    'create.selectFiles': 'Select Files or Folders',
    'create.drop': 'Drag & Drop files here',
    'create.browse': 'or click to browse',
    'create.name': 'Torrent Name',
    'create.name.placeholder': 'Enter a descriptive name',
    'create.trackers': 'Trackers',
    'create.trackers.placeholder': 'One tracker URL per line',
    'create.comment': 'Comment',
    'create.comment.placeholder': 'Optional description',
    'create.private': 'Private Torrent',
    'create.startSeeding': 'Start seeding immediately',
    'create.submit': 'Create & Save Torrent',
    
    // Settings
    'settings.title': 'Settings',
    'settings.general': 'General',
    'settings.downloads': 'Downloads',
    'settings.network': 'Network',
    'settings.advanced': 'Advanced',
    'settings.scheduler': 'Scheduler',
    'settings.seeding': 'Collaborative Seeding',
    'settings.interface': 'Interface',
    'settings.notifications': 'Notifications',
    'settings.system': 'System',
    'settings.hotkeys': 'Hotkeys',
    'settings.about': 'About',
    
    'settings.language': 'Language',
    'settings.language.desc': 'Application interface language',
    'settings.theme': 'Color Scheme',
    'settings.theme.desc': 'Choose your preferred theme',
    
    // Add Torrent Modal/Preview
    'add.drop': 'Drop torrent file here',
    'add.dropSubtitle': 'to start downloading',
    'add.btn': 'Add Selected Torrent',
    
    // Status
    'status.seeding': 'Seeding',
    'status.downloading': 'Downloading',
    'status.queued': 'Queued',
    'status.completed': 'Completed',
    'status.paused': 'Paused',
    'status.error': 'Error',
    'status.removed': 'Removed',

    // Search
    'search.title': 'Search Torrents',
    'search.providers': 'Providers',
    'search.input': 'Search for torrents...',
    'search.btn': 'Search',
    'search.failed': 'Search failed',
    'search.noLink': 'No downloadable link',
    'search.hint.title': 'Configure a search provider first',
    'search.hint.desc': 'TorrentHunt uses a plugin-based search system. Add a Jackett, Prowlarr, or custom provider to start searching.',
    'search.hint.open': 'Open Provider Settings',
    'search.hint.ready.title': 'Ready to search',
    'search.hint.ready.desc': 'Internet Archive is built in — type a query to search public-domain and Creative Commons torrents. Add more providers (Jackett, Prowlarr) for broader results.',
    'search.hint.ready.open': 'Manage Providers',
    'search.noResults.title': 'No results',
    'search.noResults.desc': 'Try a different query or check your providers.',
    'search.results': 'results',
    'search.col.provider': 'Provider',
    'search.added': 'Added',
    'search.download': 'Download',
    'search.providers.title': 'Search Providers',
    'search.providers.desc': 'Add Jackett, Prowlarr (Torznab), or custom JSON API providers. Jackett & Prowlarr are self-hosted — enter your local URL + API key.',
    'search.providers.empty': 'No providers configured yet.',
    'search.test': 'Test',
    'search.enable': 'Enable',
    'search.disable': 'Disable',
    'search.addProvider': 'Add Provider',
    'search.provider.name': 'Provider name',
    'search.provider.apiKey': 'API Key (optional)',
    'search.provider.removeConfirm': 'Remove this provider?',
    'search.guide.title': 'Setup Guide',
    'search.guide.jackett': 'Download from github.com/Jackett/Jackett, start it, then add http://localhost:9117 with your API key from the Jackett dashboard.',
    'search.guide.prowlarr': 'Use Torznab type, URL http://localhost:9696, API key from Prowlarr Settings → Security.',
    'search.guide.custom': 'Any JSON API that accepts ?q={query} and returns { results: [{title, magnetUri, size, seeds, leechers}] }.',
    'search.category.all': 'All Categories',
    'search.category.movies': 'Movies',
    'search.category.tv': 'TV',
    'search.category.music': 'Music',
    'search.category.software': 'PC/Software',
    'search.category.xxx': 'XXX',
    'search.category.other': 'Other',

    // RSS
    'rss.title': 'RSS Feeds',
    'rss.checkAll': 'Check All',
    'rss.addFeed': 'Add Feed',
    'rss.tab.feeds': 'Feeds',
    'rss.tab.items': 'Items',
    'rss.tab.edit': 'Edit Feed',
    'rss.tab.add': 'Add Feed',
    'rss.loading': 'Loading RSS feeds...',
    'rss.empty.title': 'No RSS feeds',
    'rss.empty.desc': 'Add an RSS feed to auto-download new torrents.',
    'rss.every': 'Every',
    'rss.minutesShort': 'm',
    'rss.autoDownload': 'Auto-download',
    'rss.filter': 'Filter:',
    'rss.check': 'Check',
    'rss.checkNow': 'Check now',
    'rss.viewItems': 'View items',
    'rss.edit': 'Edit',
    'rss.enable': 'Enable',
    'rss.disable': 'Disable',
    'rss.delete': 'Delete',
    'rss.deleteConfirm': 'Delete this RSS feed and all its items?',
    'rss.allFeeds': 'All feeds',
    'rss.searchItems': 'Search items by title...',
    'rss.searchClear': 'Clear search',
    'rss.searchEmpty.title': 'No matching items',
    'rss.searchEmpty.desc': 'No items match your search. Try a different term.',
    'rss.clearItems': 'Clear list',
    'rss.clearAll': 'Clear all',
    'rss.clearConfirm': 'Remove the shown items from the list? Feeds and already-downloaded files are not affected — items may reappear on the next feed check.',
    'rss.items.empty.title': 'No items',
    'rss.items.empty.desc': 'Check a feed to load items.',
    'rss.downloaded': 'Downloaded',
    'rss.download': 'Download',
    'rss.form.addTitle': 'Add RSS Feed',
    'rss.form.editTitle': 'Edit Feed',
    'rss.form.name': 'Feed Name *',
    'rss.form.namePlaceholder': 'e.g. Ubuntu Releases',
    'rss.form.url': 'RSS URL *',
    'rss.form.interval': 'Check interval (minutes)',
    'rss.form.savePath': 'Save path (optional)',
    'rss.form.savePathPlaceholder': 'Default save path',
    'rss.form.filter': 'Title filter (regex, optional)',
    'rss.form.filterHint': 'Case-insensitive. e.g. S\\d+E\\d+ for TV episodes',
    'rss.form.filterPlaceholder': 'e.g. 1080p|2160p',
    'rss.form.enabled': 'Enabled',
    'rss.form.autoDl': 'Auto-download new items',
    'rss.form.autoDlHint': 'Automatically adds matching items to downloads',
    'rss.form.cancel': 'Cancel',
    'rss.form.save': 'Save Changes',
    'rss.form.add': 'Add Feed',
  },
  ru: {
    // Sidebar
    'nav.downloads': 'Загрузки',
    'nav.catalog': 'Каталог',
    'nav.settings': 'Настройки',
    'nav.create': 'Создать торрент',
    'nav.menu': 'Меню',
    
    // Downloads
    'filter.all': 'Все',
    'filter.downloading': 'Загружаются',
    'filter.completed': 'Завершены',
    'filter.paused': 'На паузе',
    'filter.error': 'Ошибки',
    'btn.addTorrent': 'Добавить торрент',
    'btn.addUrl': 'Добавить URL/Magnet',
    'search.placeholder': 'Поиск загрузок...',
    'table.name': 'Имя',
    'table.size': 'Размер',
    'table.progress': 'Прогресс',
    'table.status': 'Статус',
    'table.speed': 'Скорость',
    'table.eta': 'Осталось',
    'table.peers': 'Пиры',
    'context.pause': 'Пауза',
    'context.resume': 'Продолжить',
    'context.delete': 'Удалить',
    'context.deleteFiles': 'Удалить с файлами',
    'context.openFolder': 'Открыть папку',
    'context.copyMagnet': 'Копировать Magnet-ссылку',
    
    // Catalog
    'catalog.title': 'Каталог сообщества',
    'catalog.subtitle': 'Находите открытый и бесплатный контент',
    'catalog.search': 'Поиск в каталоге...',
    'catalog.refresh': 'Обновить',
    'catalog.add': 'В Загрузки',
    'catalog.category.all': 'Все категории',
    
    // Create Torrent
    'create.title': 'Создать новый торрент',
    'create.subtitle': 'Поделитесь файлами с миром',
    'create.selectFiles': 'Выберите файлы или папки',
    'create.drop': 'Перетащите файлы сюда',
    'create.browse': 'или нажмите для выбора',
    'create.name': 'Имя торрента',
    'create.name.placeholder': 'Введите понятное название',
    'create.trackers': 'Трекеры',
    'create.trackers.placeholder': 'Один URL трекера на строку',
    'create.comment': 'Комментарий',
    'create.comment.placeholder': 'Необязательное описание',
    'create.private': 'Приватный торрент',
    'create.startSeeding': 'Начать раздачу сразу',
    'create.submit': 'Создать и сохранить',
    
    // Settings
    'settings.title': 'Настройки',
    'settings.general': 'Основные',
    'settings.downloads': 'Загрузки',
    'settings.network': 'Сеть',
    'settings.advanced': 'Продвинутые',
    'settings.scheduler': 'Расписание',
    'settings.seeding': 'Коллаб. Раздача',
    'settings.interface': 'Интерфейс',
    'settings.notifications': 'Уведомления',
    'settings.system': 'Система',
    'settings.hotkeys': 'Горячие клавиши',
    'settings.about': 'О программе',
    
    'settings.language': 'Язык',
    'settings.language.desc': 'Язык интерфейса приложения',
    'settings.theme': 'Цветовая схема',
    'settings.theme.desc': 'Выберите предпочтительную тему',
    
    // Add Torrent Modal/Preview
    'add.drop': 'Перетащите torrent файл сюда',
    'add.dropSubtitle': 'чтобы начать загрузку',
    'add.btn': 'Добавить выбранный торрент',
    
    // Status
    'status.seeding': 'Раздается',
    'status.downloading': 'Скачивается',
    'status.queued': 'В очереди',
    'status.completed': 'Завершен',
    'status.paused': 'На паузе',
    'status.error': 'Ошибка',
    'status.removed': 'Удален',

    // Search
    'search.title': 'Поиск торрентов',
    'search.providers': 'Провайдеры',
    'search.input': 'Искать торренты...',
    'search.btn': 'Найти',
    'search.failed': 'Поиск не удался',
    'search.noLink': 'Нет ссылки для загрузки',
    'search.hint.title': 'Сначала настройте провайдера поиска',
    'search.hint.desc': 'TorrentHunt использует систему поиска на основе плагинов. Добавьте провайдера Jackett, Prowlarr или свой, чтобы начать поиск.',
    'search.hint.open': 'Открыть настройки провайдеров',
    'search.hint.ready.title': 'Готово к поиску',
    'search.hint.ready.desc': 'Internet Archive встроен — введите запрос, чтобы искать торренты public-domain и Creative Commons. Для более широких результатов добавьте провайдеров (Jackett, Prowlarr).',
    'search.hint.ready.open': 'Управление провайдерами',
    'search.noResults.title': 'Ничего не найдено',
    'search.noResults.desc': 'Попробуйте другой запрос или проверьте провайдеров.',
    'search.results': 'результатов',
    'search.col.provider': 'Провайдер',
    'search.added': 'Добавлено',
    'search.download': 'Скачать',
    'search.providers.title': 'Провайдеры поиска',
    'search.providers.desc': 'Добавьте Jackett, Prowlarr (Torznab) или свой JSON API. Jackett и Prowlarr работают локально — укажите ваш URL и API-ключ.',
    'search.providers.empty': 'Провайдеры ещё не настроены.',
    'search.test': 'Проверить',
    'search.enable': 'Включить',
    'search.disable': 'Отключить',
    'search.addProvider': 'Добавить провайдера',
    'search.provider.name': 'Название провайдера',
    'search.provider.apiKey': 'API-ключ (необязательно)',
    'search.provider.removeConfirm': 'Удалить этого провайдера?',
    'search.guide.title': 'Инструкция по настройке',
    'search.guide.jackett': 'Скачайте с github.com/Jackett/Jackett, запустите, затем добавьте http://localhost:9117 с вашим API-ключом из панели Jackett.',
    'search.guide.prowlarr': 'Выберите тип Torznab, URL http://localhost:9696, API-ключ из Prowlarr: Settings → Security.',
    'search.guide.custom': 'Любой JSON API, принимающий ?q={query} и возвращающий { results: [{title, magnetUri, size, seeds, leechers}] }.',
    'search.category.all': 'Все категории',
    'search.category.movies': 'Фильмы',
    'search.category.tv': 'Сериалы',
    'search.category.music': 'Музыка',
    'search.category.software': 'ПО',
    'search.category.xxx': 'Для взрослых',
    'search.category.other': 'Прочее',

    // RSS
    'rss.title': 'RSS-ленты',
    'rss.checkAll': 'Проверить все',
    'rss.addFeed': 'Добавить ленту',
    'rss.tab.feeds': 'Ленты',
    'rss.tab.items': 'Элементы',
    'rss.tab.edit': 'Изменить ленту',
    'rss.tab.add': 'Добавить ленту',
    'rss.loading': 'Загрузка RSS-лент...',
    'rss.empty.title': 'Нет RSS-лент',
    'rss.empty.desc': 'Добавьте RSS-ленту для автозагрузки новых торрентов.',
    'rss.every': 'Каждые',
    'rss.minutesShort': 'мин',
    'rss.autoDownload': 'Автозагрузка',
    'rss.filter': 'Фильтр:',
    'rss.check': 'Проверить',
    'rss.checkNow': 'Проверить сейчас',
    'rss.viewItems': 'Показать элементы',
    'rss.edit': 'Изменить',
    'rss.enable': 'Включить',
    'rss.disable': 'Отключить',
    'rss.delete': 'Удалить',
    'rss.deleteConfirm': 'Удалить эту RSS-ленту и все её элементы?',
    'rss.allFeeds': 'Все ленты',
    'rss.searchItems': 'Поиск по названию...',
    'rss.searchClear': 'Очистить поиск',
    'rss.searchEmpty.title': 'Ничего не найдено',
    'rss.searchEmpty.desc': 'Нет элементов по запросу. Попробуйте другой запрос.',
    'rss.clearItems': 'Очистить список',
    'rss.clearAll': 'Очистить всё',
    'rss.clearConfirm': 'Убрать показанные элементы из списка? Ленты и уже скачанные файлы не затрагиваются — элементы могут появиться снова при следующей проверке ленты.',
    'rss.items.empty.title': 'Нет элементов',
    'rss.items.empty.desc': 'Проверьте ленту, чтобы загрузить элементы.',
    'rss.downloaded': 'Загружено',
    'rss.download': 'Скачать',
    'rss.form.addTitle': 'Добавить RSS-ленту',
    'rss.form.editTitle': 'Изменить ленту',
    'rss.form.name': 'Название ленты *',
    'rss.form.namePlaceholder': 'напр. Релизы Ubuntu',
    'rss.form.url': 'URL RSS *',
    'rss.form.interval': 'Интервал проверки (минуты)',
    'rss.form.savePath': 'Путь сохранения (необязательно)',
    'rss.form.savePathPlaceholder': 'Папка сохранения по умолчанию',
    'rss.form.filter': 'Фильтр по названию (regex, необязательно)',
    'rss.form.filterHint': 'Без учёта регистра. Напр. S\\d+E\\d+ для серий сериалов',
    'rss.form.filterPlaceholder': 'напр. 1080p|2160p',
    'rss.form.enabled': 'Включено',
    'rss.form.autoDl': 'Автозагрузка новых элементов',
    'rss.form.autoDlHint': 'Автоматически добавляет подходящие элементы в загрузки',
    'rss.form.cancel': 'Отмена',
    'rss.form.save': 'Сохранить изменения',
    'rss.form.add': 'Добавить ленту',
  }
};

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: keyof typeof dictionary.en) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en');

  useEffect(() => {
    const saved = localStorage.getItem('language') as Language;
    if (saved && (saved === 'en' || saved === 'ru')) {
      setLanguageState(saved);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('language', lang);
  };

  const t = (key: keyof typeof dictionary.en): string => {
    return dictionary[language][key] || dictionary.en[key] || key;
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useTranslation = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
};
