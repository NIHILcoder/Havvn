/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node artifact generator. */
// Export the saved measurements as an SVG suitable for sharing.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(process.argv[2] || 'artifacts/performance');
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const destination = path.join(dir, 'before-after.svg');
const names = ['Загрузки · 1000', 'Комната · только stats', 'Комната · прогресс', 'Видео + загрузки'];
const panels = [
  { title: 'Время обновления React — p95', metric: 'reactCommitMs', field: 'p95', unit: 'мс', digits: 1, aggregation: 'Медиана p95 трёх запусков' },
  { title: 'CPU всех процессов Electron', metric: 'cpuPercent', field: 'mean', unit: '%', digits: 3, aggregation: 'Медиана средних трёх запусков' },
  { title: 'Память всех процессов Electron', metric: 'allProcessesPrivateMiB', field: 'median', unit: 'МиБ', digits: 1, aggregation: 'Private bytes · медиана медиан трёх запусков' },
  { title: 'Память интерфейса', metric: 'rendererPrivateMiB', field: 'median', unit: 'МиБ', digits: 1, aggregation: 'Private bytes · медиана медиан трёх запусков' },
];
const colors = { before: '#8a929e', after: '#2878c6', text: '#202b3a', muted: '#657181', grid: '#e5e8ec' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fmt = (n, digits = 1) => n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const elements = [];
const text = (x, y, value, size = 16, color = colors.text, anchor = 'start', weight = 400) => elements.push('<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + color + '" text-anchor="' + anchor + '" font-weight="' + weight + '">' + escape(value) + '</text>');
const rect = (x, y, width, height, fill) => elements.push('<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" fill="' + fill + '"/>');
const line = (x1, y1, x2, y2, color) => elements.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '"/>');
const date = new Date(summary.sources.before[0].at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const time = at => new Date(at).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
text(48, 52, 'Оптимизация интерфейса Havvn: было → стало', 28, colors.text, 'start', 600);
text(48, 88, 'Этап 6 · три запуска до и три после · изменения этапов 2–5 присутствуют в обеих версиях', 18, colors.muted);
rect(48, 114, 14, 14, colors.before);
text(74, 127, 'Было — до этапа 6', 16);
rect(312, 114, 14, 14, colors.after);
text(338, 127, 'Стало — после этапа 6', 16);
text(678, 127, 'Меньше — лучше · справа показано изменение в процентах', 16, colors.muted);
panels.forEach((panel, index) => {
  const x = index % 2 ? 832 : 48;
  const y = index < 2 ? 196 : 606;
  const plotX = x + 216, plotWidth = 390;
  const pairs = summary.rows.map(row => ['before', 'after'].map(side => row[side].metrics[panel.metric][panel.field]));
  const max = Math.max(...pairs.flat()) * 1.18;
  text(x, y, panel.title, 22, colors.text, 'start', 600);
  text(x, y + 30, panel.aggregation, 15, colors.muted);
  text(x, y + 57, 'Сценарий', 14, colors.muted);
  text(x + 720, y + 57, 'Изменение', 14, colors.muted, 'end');
  for (let i = 0; i <= 4; i++) {
    const tickX = plotX + plotWidth * i / 4;
    line(tickX, y + 68, tickX, y + 325, colors.grid);
    text(tickX, y + 346, fmt(max * i / 4, panel.metric === 'cpuPercent' ? 2 : 0), 13, colors.muted, 'middle');
  }
  pairs.forEach(([before, after], row) => {
    const rowY = y + 78 + row * 66;
    text(x, rowY + 22, names[row], 16);
    [before, after].forEach((value, side) => {
      const barY = rowY + side * 20;
      const width = value / max * plotWidth;
      rect(plotX, barY, width, 14, side ? colors.after : colors.before);
      text(plotX + width + 7, barY + 12, fmt(value, panel.digits), 14);
    });
    const delta = (after / before - 1) * 100;
    text(x + 720, rowY + 22, (delta < 0 ? '−' : '+') + fmt(Math.abs(delta)) + '%', 17, colors.text, 'end', 500);
  });
  text(plotX + plotWidth / 2, y + 374, panel.unit, 15, colors.muted, 'middle');
});
const rowsBefore = summary.rows[0].before.renders.DownloadItem;
const rowsAfter = summary.rows[0].after.renders.DownloadItem;
text(48, 1020, 'Вызовы строк загрузок за 16 stats-тиков: ' + rowsBefore + ' → ' + rowsAfter + ' (−' + fmt((1 - rowsAfter / rowsBefore) * 100) + '%).', 18, colors.text, 'start', 500);
text(48, 1051, 'Источник: artifacts/performance/summary.json · ' + date + ', ' + time(summary.sources.before[0].at) + '–' + time(summary.sources.after[2].at) + ' МСК · 16 выборок через 750 мс.', 16, colors.muted);
text(48, 1080, 'Синтетический IPC; без swarm, daemon и FFmpeg. Снижение расхода ОЗУ всего Havvn не подтверждено.', 16, colors.muted);
text(48, 1109, 'Private bytes — частная выделенная память; этот показатель не равен занятой физической ОЗУ.', 16, colors.muted);
fs.writeFileSync(destination, '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1140" viewBox="0 0 1600 1140"><rect width="1600" height="1140" fill="white"/><g font-family="Arial, sans-serif">' + elements.join('') + '</g></svg>');
console.log(destination);
