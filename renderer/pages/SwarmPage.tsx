/**
 * SwarmPage — a live world map of the peers you're connected to.
 *
 * Peers from every active torrent are grouped by country in the engine (resolved
 * fully offline via a country-level IP DB, so no peer address ever leaves the
 * machine or reaches the UI) and drawn on a real Natural-Earth world map. Each
 * country with peers is a glowing node sized by connection count; if we know your
 * own country, arcs stream from every node toward your home marker. Everything is
 * monochrome — activity is encoded by size, brightness and motion, not colour —
 * to match the app's single-accent design.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { geoNaturalEarth1, geoPath, geoCentroid, geoGraticule10 } from 'd3-geo';
import worldGeo from '../assets/world-110m.geojson';
import { SwarmGeo } from '../../shared/types';
import { useTranslation } from '../utils/i18nContext';
import { Icon } from '../components';
import { formatSpeed } from './download-helpers';
import './SwarmPage.css';

// Natural Earth 1 has a ~2:1 aspect ratio.
const W = 1000;
const H = 500;

/** ISO-3166 alpha-2 → regional-indicator flag emoji. */
function codeToFlag(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return '🏳';
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

interface SwarmNode {
  country: string;
  name: string;
  count: number;
  seeds: number;
  downBps: number;
  upBps: number;
  x: number;
  y: number;
  r: number;
  active: boolean;
}

export const SwarmPage: React.FC = () => {
  const { t } = useTranslation();
  const [geo, setGeo] = useState<SwarmGeo | null>(null);
  const [homeCode, setHomeCode] = useState<string | null>(null);

  // Map geometry + per-country centroids — projected once, reused forever.
  const map = useMemo(() => {
    const projection = geoNaturalEarth1().fitSize([W, H], worldGeo as never);
    const pathGen = geoPath(projection as never);
    const countries = (worldGeo.features as unknown[]).map((f, key) => ({
      key,
      d: pathGen(f as never) || '',
    }));
    const sphere = pathGen({ type: 'Sphere' } as never) || '';
    const graticule = pathGen(geoGraticule10() as never) || '';
    const centroidByCode = new Map<string, { x: number; y: number; name: string }>();
    for (const f of worldGeo.features) {
      const props = f.properties as Record<string, string | number | null>;
      const raw = props.ISO_A2 && props.ISO_A2 !== '-99' ? props.ISO_A2 : props.ISO_A2_EH;
      const code = typeof raw === 'string' ? raw : '';
      if (!/^[A-Za-z]{2}$/.test(code)) continue;
      const c = geoCentroid(f as never) as [number, number];
      const p = projection(c);
      if (!p) continue;
      centroidByCode.set(code.toUpperCase(), { x: p[0], y: p[1], name: String(props.NAME || code) });
    }
    return { countries, sphere, graticule, centroidByCode };
  }, []);

  // Poll the live swarm geography.
  useEffect(() => {
    let alive = true;
    const tick = () => window.api.getSwarmGeo().then((g) => { if (alive) setGeo(g); }).catch(() => {});
    tick();
    const iv = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Best-effort home location — the same public-IP lookup the Privacy tab uses.
  // If it's unavailable we simply draw no home marker/arcs.
  useEffect(() => {
    let alive = true;
    window.api.getIpInfo()
      .then((info) => { if (alive && info?.country) setHomeCode(String(info.country).toUpperCase()); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const nodes: SwarmNode[] = useMemo(() => {
    if (!geo) return [];
    const maxCount = Math.max(1, ...geo.points.map((p) => p.count));
    const out: SwarmNode[] = [];
    for (const p of geo.points) {
      const c = map.centroidByCode.get(p.country);
      if (!c) continue;
      out.push({
        country: p.country,
        name: c.name,
        count: p.count,
        seeds: p.seeds,
        downBps: p.downBps,
        upBps: p.upBps,
        x: c.x,
        y: c.y,
        r: 3 + Math.sqrt(p.count / maxCount) * 13,
        active: p.downBps > 0,
      });
    }
    return out;
  }, [geo, map]);

  const home = homeCode ? map.centroidByCode.get(homeCode) : null;

  const totalDown = geo ? geo.points.reduce((s, p) => s + p.downBps, 0) : 0;
  const totalUp = geo ? geo.points.reduce((s, p) => s + p.upBps, 0) : 0;
  const hasPeers = !!geo && nodes.length > 0;

  // Barlist: countries by connection count, bars proportional to the leader.
  const ranked = useMemo(() => [...nodes].sort((a, b) => b.count - a.count), [nodes]);
  const leaderCount = ranked.length ? ranked[0].count : 1;

  // Quadratic-bezier arc, bowed toward home for a premium "incoming traffic" look.
  const arc = (x1: number, y1: number, x2: number, y2: number): string => {
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist;
    const k = Math.min(dist * 0.3, 90);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${(( x1 + x2) / 2 + nx * k).toFixed(1)},${((y1 + y2) / 2 + ny * k).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };

  return (
    <div className="swarm-page">
      <div className="swarm-topbar">
        <div className="swarm-title">
          <span className="swarm-live-dot" />
          <h1>{t('swarm.title')}</h1>
        </div>
      </div>

      {/* Concept layout: map stage | stat panel (KPI tiles + country barlist) */}
      <div className="swarm-wrap">
        <div className="swarm-stage">
          <div className="swarm-legend">
            <b><span className="d d-home" />{t('swarm.legendYou')}</b>
            <b><span className="d d-peer" />{t('swarm.legendPeer')}</b>
            <b><span className="d d-seed" />{t('swarm.legendSeed')}</b>
          </div>

          <svg className="swarm-map" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('swarm.title')}>
            <path className="swarm-sphere" d={map.sphere} />
            <path className="swarm-graticule" d={map.graticule} />
            <g className="swarm-countries">
              {map.countries.map((c) => (
                <path key={c.key} d={c.d} className="swarm-country" />
              ))}
            </g>

            {home && (
              <g className="swarm-arcs">
                {nodes.map((n) => (
                  <path key={`a-${n.country}`} className="swarm-arc" d={arc(n.x, n.y, home.x, home.y)} />
                ))}
              </g>
            )}

            <g className="swarm-nodes">
              {nodes.map((n, i) => (
                <g
                  key={n.country}
                  transform={`translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`}
                  className={`swarm-node ${n.active ? 'active' : ''} ${n.seeds > n.count / 2 ? 'seedy' : ''}`}
                >
                  <circle className="swarm-node-ring" r={n.r} style={{ animationDelay: `${(i % 8) * 0.25}s` }} />
                  <circle className="swarm-node-core" r={Math.max(1.6, n.r * 0.34)} />
                </g>
              ))}
            </g>

            {home && (
              <g transform={`translate(${home.x.toFixed(1)},${home.y.toFixed(1)})`} className="swarm-home">
                <circle className="swarm-home-halo" r={16} />
                <circle className="swarm-home-core" r={5} />
                <circle className="swarm-home-dot" r={2} />
              </g>
            )}
          </svg>

          {geo && !hasPeers && (
            <div className="swarm-empty">
              <Icon name="globe" size={30} />
              <p>{geo.totalConns > 0 ? t('swarm.emptyResolving') : t('swarm.empty')}</p>
            </div>
          )}
        </div>

        <div className="swarm-panel">
          <div className="swarm-kpis">
            <div className="swarm-kpi">
              <span className="swarm-kpi-v">{geo ? geo.resolved : '—'}</span>
              <span className="swarm-kpi-l">{t('swarm.peers')}</span>
            </div>
            <div className="swarm-kpi">
              <span className="swarm-kpi-v">{nodes.length}</span>
              <span className="swarm-kpi-l">{t('swarm.countries')}</span>
            </div>
            <div className="swarm-kpi">
              <span className="swarm-kpi-v acc">{formatSpeed(totalDown)}</span>
              <span className="swarm-kpi-l">↓</span>
            </div>
            <div className="swarm-kpi">
              <span className="swarm-kpi-v up">{formatSpeed(totalUp)}</span>
              <span className="swarm-kpi-l">↑</span>
            </div>
          </div>

          {hasPeers && (
            <div className="swarm-barlist">
              <div className="swarm-list-head">{t('swarm.topCountries')}</div>
              {ranked.slice(0, 10).map((n) => (
                <div key={n.country} className={`swarm-b ${n.active ? 'active' : ''}`} title={n.name}>
                  <span className="swarm-b-cc">{codeToFlag(n.country)} {n.country}</span>
                  <div className="swarm-b-track">
                    <i
                      className={n.seeds > n.count / 2 ? 'seed' : ''}
                      style={{ width: `${Math.max(4, Math.round((n.count / leaderCount) * 100))}%` }}
                    />
                  </div>
                  <span className="swarm-b-num">{n.count}</span>
                </div>
              ))}
            </div>
          )}

          {geo && (geo.dht !== undefined || (geo.transport && geo.transport.total > 0)) && (
            <div className="swarm-barlist">
              <div className="swarm-list-head">{t('swarm.transport')}</div>
              <div className="swarm-trans">
                {geo.transport && geo.transport.total > 0 && (() => {
                  const tr = geo.transport;
                  const pct = (n: number): number => Math.round((n / tr.total) * 100);
                  return (
                    <>
                      {tr.utp > 0 && <span className="swarm-pill"><b>{pct(tr.utp)}%</b> µTP</span>}
                      {tr.tcp > 0 && <span className="swarm-pill"><b>{pct(tr.tcp)}%</b> TCP</span>}
                      {tr.webrtc > 0 && <span className="swarm-pill"><b>{pct(tr.webrtc)}%</b> WebRTC</span>}
                      <span className="swarm-pill"><b>{pct(tr.encrypted)}%</b> {t('swarm.encrypted')}</span>
                    </>
                  );
                })()}
                {geo.dht !== undefined && (
                  <span className={`swarm-pill ${geo.dht ? '' : 'off'}`}>
                    <b>DHT</b> {geo.dht ? t('swarm.on') : t('swarm.off')}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="swarm-note">
            <Icon name="lock" size={12} />
            <span>
              {t('swarm.privacy')}
              {geo && geo.resolved < geo.totalConns ? ` ${t('swarm.unresolved').replace('{n}', String(geo.totalConns - geo.resolved))}` : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SwarmPage;
