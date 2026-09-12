/**
 * Rate Limiter для защиты от flood-атак через IPC
 * Ограничивает количество запросов от одного webContents
 */

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface LimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Rate Limiter класс
 */
export class RateLimiter {
  private limits = new Map<string, LimitEntry>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Очистка старых записей каждые 5 минут
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
    this.cleanupInterval.unref();
  }

  /**
   * Проверить лимит для ключа
   * @param key Уникальный ключ (например, "addDownload:123")
   * @param maxRequests Максимальное количество запросов
   * @param windowMs Временное окно в миллисекундах
   * @returns true если запрос разрешен, false если превышен лимит
   */
  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const limit = this.limits.get(key);

    // Создать новое окно или окно истекло
    if (!limit || now >= limit.resetAt) {
      this.limits.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return true;
    }

    // Проверить, не превышен ли лимит
    if (limit.count >= maxRequests) {
      return false;
    }

    // Увеличить счетчик
    limit.count++;
    return true;
  }

  /**
   * Проверить лимит или выбросить ошибку
   * @throws Error если лимит превышен
   */
  checkOrThrow(key: string, maxRequests: number, windowMs: number): void {
    if (!this.check(key, maxRequests, windowMs)) {
      throw new Error(`Rate limit exceeded. Please try again later.`);
    }
  }

  /**
   * Сбросить счетчик для ключа
   */
  reset(key: string): void {
    this.limits.delete(key);
  }

  /**
   * Очистить истекшие записи
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, limit] of this.limits.entries()) {
      if (now >= limit.resetAt) {
        this.limits.delete(key);
      }
    }
  }

  /**
   * Получить информацию о текущем состоянии лимита
   */
  getStatus(key: string): { count: number; resetIn: number } | null {
    const limit = this.limits.get(key);
    if (!limit) {
      return null;
    }

    const now = Date.now();
    return {
      count: limit.count,
      resetIn: Math.max(0, limit.resetAt - now),
    };
  }

  /**
   * Уничтожить rate limiter
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.limits.clear();
  }
}

/**
 * Глобальный rate limiter instance
 */
export const globalRateLimiter = new RateLimiter();

/**
 * Предустановленные лимиты для различных операций
 */
export const RATE_LIMITS = {
  // Загрузки
  ADD_DOWNLOAD: { maxRequests: 10, windowMs: 60000 }, // 10 загрузок за минуту
  REMOVE_DOWNLOAD: { maxRequests: 20, windowMs: 60000 }, // 20 удалений за минуту
  PAUSE_RESUME: { maxRequests: 50, windowMs: 60000 }, // 50 пауз/возобновлений за минуту

  // Комнаты
  CREATE_ROOM: { maxRequests: 5, windowMs: 300000 }, // 5 комнат за 5 минут
  JOIN_ROOM: { maxRequests: 10, windowMs: 300000 }, // 10 подключений за 5 минут
  SEND_CHAT: { maxRequests: 30, windowMs: 60000 }, // 30 сообщений за минуту

  // Поиск и создание
  SEARCH: { maxRequests: 15, windowMs: 60000 }, // 15 поисков за минуту
  CREATE_TORRENT: { maxRequests: 5, windowMs: 300000 }, // 5 созданий за 5 минут

  // RSS
  ADD_RSS_FEED: { maxRequests: 10, windowMs: 300000 }, // 10 фидов за 5 минут

  // Общие операции
  GENERIC: { maxRequests: 100, windowMs: 60000 }, // 100 запросов за минуту
} as const;

/**
 * Создать уникальный ключ для webContents
 * @param action Название действия (например, 'downloads:add')
 * @param webContentsId ID webContents из event.sender.id
 */
export function createWebContentsKey(action: string, webContentsId: number): string {
  return `${action}:${webContentsId}`;
}

/**
 * Вспомогательная функция для применения rate limiting с конфигом
 */
export function applyRateLimit(
  key: string,
  config: RateLimitConfig,
  limiter: RateLimiter = globalRateLimiter
): void {
  limiter.checkOrThrow(key, config.maxRequests, config.windowMs);
}
