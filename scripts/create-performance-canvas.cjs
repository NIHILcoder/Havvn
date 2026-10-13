/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node artifact generator. */
// Save the measured comparison as one self-contained Codex canvas.
const fs = require('node:fs'), path = require('node:path');
const dir = path.resolve(process.argv[2] || 'artifacts/performance');
if (!process.argv[3]) throw Error('Pass the absolute managed canvas path');
const destination = path.resolve(process.argv[3]);
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const data = { rows: summary.rows, hardware: summary.hardware, electron: summary.electron,
  start: summary.sources.before[0].at, end: summary.sources.after[2].at };
const source = `import { H1, H2, Text, Row, Grid, Stat, Callout, Select, BarChart, Table, Link, useState, useHostTheme } from 'cursor/canvas';
const data = ${JSON.stringify(data)};
const names = ['1000 загрузок', 'Комната: только stats', 'Комната: прогресс', 'Видео + 1000 загрузок'];
const specs = {
  reactCommitMs: { title: 'Время обновления React — p95', unit: 'мс', field: 'p95', aggregation: 'Медиана p95 трёх запусков' },
  cpuPercent: { title: 'CPU всех процессов Electron', unit: '%', field: 'mean', aggregation: 'Медиана средних трёх запусков' },
  allProcessesPrivateMiB: { title: 'Память всех процессов Electron — private bytes', unit: 'МиБ', field: 'median', aggregation: 'Медиана медиан трёх запусков' },
  rendererPrivateMiB: { title: 'Память интерфейса — private bytes', unit: 'МиБ', field: 'median', aggregation: 'Медиана медиан трёх запусков' },
  rendererWorkingSetMiB: { title: 'Физическая память интерфейса — working set', unit: 'МиБ', field: 'median', aggregation: 'Медиана медиан трёх запусков' },
  rendererHeapMiB: { title: 'Использованная память JavaScript — V8 heap', unit: 'МиБ', field: 'median', aggregation: 'Медиана медиан трёх запусков' },
  statsCallbackMs: { title: 'Время обработки stats callback — p95', unit: 'мс', field: 'p95', aggregation: 'Медиана p95 трёх запусков' },
  rendererTimerLagMs: { title: 'Задержка таймера интерфейса — p95', unit: 'мс', field: 'p95', aggregation: 'Медиана p95 трёх запусков' },
} as const;
type Metric = keyof typeof specs;
type Sample = typeof data.rows[number];
const memoryMetrics = ['allProcessesPrivateMiB', 'rendererPrivateMiB', 'rendererWorkingSetMiB', 'rendererHeapMiB'] as const;
type MemoryMetric = typeof memoryMetrics[number];
const fmt = (n: number, digits = 2) => n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const value = (r: Sample, side: 'before' | 'after', metric: Metric) => r[side].metrics[metric][specs[metric].field];
const change = (r: Sample, metric: Metric) => (value(r, 'after', metric) / value(r, 'before', metric) - 1) * 100;
const signed = (n: number, digits = 1) => (n < 0 ? '−' : n > 0 ? '+' : '') + fmt(Math.abs(n), digits);
const time = (at: string) => new Date(at).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const day = new Date(data.start).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const sourceCaption = 'Источник: artifacts/performance/before-1…3.json и after-1…3.json · ' + day + ', ' + time(data.start) + '–' + time(data.end) + ' МСК';
function ComparisonChart({ metric, height = 300 }: { metric: Metric; height?: number }) {
  const spec = specs[metric];
  const digits = metric === 'cpuPercent' ? 3 : 1;
  const rounded = (n: number) => Number(n.toFixed(digits));
  return <div>
    <H2>{spec.title}</H2>
    <Text size="small" tone="secondary">X: {spec.unit} · Y: сценарий · меньше — лучше</Text>
    <BarChart categories={names} series={[
      { name: 'Было — до этапа 6', data: data.rows.map(r => rounded(value(r, 'before', metric))), tone: 'neutral' },
      { name: 'Стало — после этапа 6', data: data.rows.map(r => rounded(value(r, 'after', metric))), tone: 'info' },
    ]} horizontal height={height} beginAtZero valueSuffix={' ' + spec.unit} showValues />
    <Text size="small" tone="secondary">{spec.aggregation}. {sourceCaption}.</Text>
  </div>;
}
export default function PerformanceComparison() {
  const theme = useHostTheme();
  const [metric, setMetric] = useState<Metric>('reactCommitMs');
  const [memory, setMemory] = useState<MemoryMetric>('allProcessesPrivateMiB');
  const spec = specs[metric];
  return <div style={{ padding: 24, maxWidth: 1120, margin: '0 auto', color: theme.text.primary }}>
    <H1>Havvn: было → стало</H1>
    <Text tone="secondary">{day} · {time(data.start)}–{time(data.end)} МСК · Electron {data.electron} · {data.hardware.cpu.trim()} · {data.hardware.cpus} логических CPU</Text>
    <Callout title="Сравнение оптимизации интерфейса — этап 6" tone="info">Три запуска до и три после. Замеры сравнивают общий store и подписки по ID с прежним интерфейсом; изменения этапов 2–5 присутствуют в обеих версиях. Выигрыш всех этапов вместе здесь не измерен.</Callout>
    <Row gap={32} wrap style={{ margin: '24px 0' }}>
      <Stat label="Вызовы строк загрузок за 16 stats-тиков" value={data.rows[0].before.renders.DownloadItem + ' → ' + data.rows[0].after.renders.DownloadItem} />
      <Stat label="Сокращение вызовов строк загрузок" value={'−' + fmt((1 - data.rows[0].after.renders.DownloadItem / data.rows[0].before.renders.DownloadItem) * 100, 1) + '%'} tone="info" />
    </Row>
    <ComparisonChart metric="reactCommitMs" height={320} />
    <Grid columns="repeat(auto-fit, minmax(min(100%, 440px), 1fr))" gap={32} style={{ marginTop: 24 }}>
      <div><ComparisonChart metric="cpuPercent" /><Text tone="secondary">Средняя нагрузка CPU ниже во всех четырёх сценариях. Значения относятся к контрольному стенду.</Text></div>
      <div>
        <ComparisonChart metric={memory} />
        <Text size="small" weight="medium">Показатель памяти</Text>
        <Select value={memory} onChange={v => setMemory(v as MemoryMetric)} options={memoryMetrics.map(value => ({ value, label: specs[value].title }))} />
        <Text tone="secondary">Общая private memory выросла в двух сценариях и снизилась в двух. Снижение общего расхода ОЗУ Havvn не подтверждено. Private bytes — частная выделенная память; working set — физическая память процесса.</Text>
      </div>
    </Grid>
    <div style={{ marginTop: 32 }}>
      <H2>Точные значения и изменение</H2>
      <Select value={metric} onChange={v => setMetric(v as Metric)} options={Object.entries(specs).map(([value, s]) => ({ value, label: s.title }))} />
      <Text size="small" tone="secondary">{spec.aggregation}. Изменение = (стало / было − 1) × 100%; отрицательное значение означает уменьшение. {sourceCaption}.</Text>
      <Table headers={['Сценарий', 'Было, ' + spec.unit, 'Стало, ' + spec.unit, 'Разница, ' + spec.unit, 'Изменение']} columnAlign={['left', 'right', 'right', 'right', 'right']} rows={data.rows.map((r, i) => [names[i], fmt(value(r, 'before', metric), metric === 'cpuPercent' ? 3 : 2), fmt(value(r, 'after', metric), metric === 'cpuPercent' ? 3 : 2), signed(value(r, 'after', metric) - value(r, 'before', metric), metric === 'cpuPercent' ? 3 : 2), signed(change(r, metric)) + '%'])} />
    </div>
    <H2>Разброс измерений памяти</H2>
    <Text size="small" tone="secondary">{specs[memory].title}, МиБ. Медиана [минимум…максимум медиан трёх запусков]; диапазон не является доверительным интервалом. {sourceCaption}.</Text>
    <Table headers={['Сценарий', 'Было, медиана [разброс]', 'Стало, медиана [разброс]']} rows={data.rows.map((r, i) => [names[i], ...(['before', 'after'] as const).map(side => { const m = r[side].metrics[memory]; return fmt(m.median) + ' [' + fmt(m.runMedianMin) + '…' + fmt(m.runMedianMax) + ']'; })])} />
    <H2>Условия замера</H2>
    <Text tone="secondary">16 выборок через 750 мс на сценарий в каждом запуске. 1000 загрузок, один изменяющийся торрент; комната с 1000 файлами и 200 сообщениями; воспроизведение WebM. Настоящие React-компоненты, синтетический IPC, скрытое окно, программный GPU, production React profiling. В выборки не входят swarm, room-engine, голос, daemon и FFmpeg. Сборка мусора не форсировалась.</Text>
    <Text><Link href="D:/reps/Havvn/Havvn/docs/renderer-performance.md">Методика и команды повторения</Link> · <Link href="D:/reps/Havvn/Havvn/artifacts/performance/summary.json">Полная сводка: RAM, working set, heap, CPU, задержки</Link></Text>
  </div>;
}
`;
fs.writeFileSync(destination, source);
console.log(destination);
