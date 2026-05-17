import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import * as duckdb from '@duckdb/duckdb-wasm';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';

const INITIAL_VIEW_STATE = { longitude: -40, latitude: 35, zoom: 2.5, pitch: 0, bearing: 0 };
const BLUE_THEME = { min: [30, 58, 138], max: [34, 211, 238] };

// ─── FIX ①+③: Pre-compute color lookup as a plain object outside React ──────
// Returns a plain { [id]: [r,g,b,a] } object built once when data/threshold
// changes, instead of computing Math.log + interpolation per-feature per-frame.
// Using a plain object (not new Map()) avoids the shadowed Map constructor that
// deck.gl / react-map-gl imports override in this bundle.
function buildColorLookup(scoreMap, stats, multiplier, colorTheme) {
  const result = Object.create(null);
  if (!stats) return result;
  const threshold = stats.mean + stats.stdDev * multiplier;
  const range = stats.maxLog - threshold;
  const [minR, minG, minB] = colorTheme.min;
  const [maxR, maxG, maxB] = colorTheme.max;
  for (const [id, sci] of Object.entries(scoreMap)) {
    if (sci <= 0) continue;
    const logScore = Math.log(sci);
    if (logScore < threshold) continue;
    const t = range > 0 ? Math.max(0, Math.min(1, (logScore - threshold) / range)) : 1;
    result[id] = [
      Math.round(minR + t * (maxR - minR)),
      Math.round(minG + t * (maxG - minG)),
      Math.round(minB + t * (maxB - minB)),
      Math.round(80 + t * 175),
    ];
  }
  return result;
}

const TRANSPARENT = [0, 0, 0, 0];
const ANCHOR_FILL = [255, 255, 255, 100];
const ANCHOR_LINE = [255, 255, 255, 255];
const MISSING_FILL = [0, 0, 0, 120];
const MISSING_LINE = [255, 255, 255, 4];
const DEFAULT_LINE = [255, 255, 255, 20];

export default function App() {
  const [db, setDb] = useState(null);
  // ─── FIX ④: Track DB init state to unblock first paint ──────────────────
  const [dbStatus, setDbStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'

  const [selectedRegion, setSelectedRegion] = useState('None');
  const [selectedAnchorId, setSelectedAnchorId] = useState(null);
  const [thresholdMultiplier, setThresholdMultiplier] = useState(0);
  // ─── FIX D: separate display value from committed value ──────────────────
  // Without this, dragging the slider calls setThresholdMultiplier ~30×/s,
  // each tick invalidating both useMemo color lookups and rerunning
  // buildColorLookup over thousands of entries. sliderDisplay updates the
  // number label instantly; thresholdMultiplier only commits on pointer release.
  const [sliderDisplay, setSliderDisplay] = useState(0);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  // ─── FIX C: keep zoom in a ref so panning never invalidates useMemo ─────
  // viewState fires 60×/s during pan. Including viewState.zoom in layer deps
  // meant both GeoJsonLayers reconstructed every frame just to recompute
  // lineWidthMinPixels. Now layers are stable during pan; only zoom-threshold
  // crossings (zoom > 4.5) cause a layer rebuild via this separate state.
  const zoomRef = useRef(INITIAL_VIEW_STATE.zoom);
  const [isZoomedIn, setIsZoomedIn] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const [validCountries, setValidCountries] = useState(new Set());
  // ─── FIX ③: Store raw score maps + stats separately ─────────────────────
  const [domesticScores, setDomesticScores] = useState({});
  const [domesticStats, setDomesticStats] = useState(null);
  const [intlScores, setIntlScores] = useState({});
  const [intlStats, setIntlStats] = useState(null);

  // ─── FIX ①+③: Derive color lookup maps via useMemo ──────────────────────
  // These only recompute when scores/stats/threshold actually change —
  // not on every render tick. Each map is stable by reference between ticks.
  const domesticColors = useMemo(
    () => buildColorLookup(domesticScores, domesticStats, thresholdMultiplier, BLUE_THEME),
    [domesticScores, domesticStats, thresholdMultiplier]
  );
  const intlColors = useMemo(
    () => buildColorLookup(intlScores, intlStats, thresholdMultiplier, BLUE_THEME),
    [intlScores, intlStats, thresholdMultiplier]
  );

  // ─── FIX ④: Defer DuckDB init behind first paint ─────────────────────────
  useEffect(() => {
    // Let the map render first, then start the heavy WASM init
    const handle = setTimeout(async () => {
      setDbStatus('loading');
      try {
        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
        const workerUrl = URL.createObjectURL(
          new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
        );
        const worker = new Worker(workerUrl);
        const dbInstance = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
        await dbInstance.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(workerUrl);

        const deployBaseUrl = window.location.origin + import.meta.env.BASE_URL;
        const register = (name) =>
          dbInstance.registerFileURL(
            name,
            new URL(name, deployBaseUrl).href,
            duckdb.DuckDBDataProtocol.HTTP,
            false
          );
        await Promise.all([
          register('gadm_domestic.parquet'),
          register('country.parquet'),
          register('gadm_to_country.parquet'),
        ]);

        const conn = await dbInstance.connect();
        const validCheck = await conn.query(`SELECT DISTINCT source_id FROM 'country.parquet'`);
        const validSet = new Set(validCheck.toArray().map((r) => r.toJSON().source_id));
        await conn.close();

        setValidCountries(validSet);
        setDb(dbInstance);
        setDbStatus('ready');
      } catch (err) {
        console.error('DuckDB init failed:', err);
        setDbStatus('error');
      }
    }, 0); // defer past first paint
    return () => clearTimeout(handle);
  }, []);

  // ─── FIX ③: Stable processResults, returns plain object (not recreated) ──
  const processResults = useCallback((rows, keyCol, valCol) => {
    const map = {};
    const logScores = [];
    for (const row of rows) {
      const rowData = row.toJSON ? row.toJSON() : row;
      const key = String(rowData[keyCol]);
      const sci = Number(rowData[valCol]);
      if (sci > 0) {
        map[key] = sci;
        logScores.push(Math.log(sci));
      }
    }
    if (logScores.length === 0) return { map, stats: null };
    const mean = logScores.reduce((a, b) => a + b, 0) / logScores.length;
    const variance =
      logScores.map((v) => (v - mean) ** 2).reduce((a, b) => a + b, 0) / logScores.length;
    const stats = { mean, stdDev: Math.sqrt(variance), maxLog: Math.max(...logScores) };
    return { map, stats };
  }, []);

  const onMapClick = useCallback(
    async (info) => {
      if (!info.object?.properties || !db) return;
      const props = info.object.properties;
      const conn = await db.connect();
      try {
        if (props.GID_2) {
          const gadmId = props.GID_2;
          setSelectedAnchorId(gadmId);
          setSelectedRegion(`${props.NAME_2 || 'Unknown'} County, ${props.NAME_1}`);
          setIsMobileMenuOpen(false);
          const [domRows, intlRows] = await Promise.all([
            conn
              .query(
                `SELECT target_gadm, sci FROM 'gadm_domestic.parquet' WHERE source_gadm = '${gadmId}' AND source_gadm != target_gadm`
              )
              .then((r) => r.toArray()),
            conn
              .query(`SELECT iso2, sci FROM 'gadm_to_country.parquet' WHERE gadm_id = '${gadmId}'`)
              .then((r) => r.toArray()),
          ]);
          const dom = processResults(domRows, 'target_gadm', 'sci');
          const intl = processResults(intlRows, 'iso2', 'sci');
          setDomesticScores(dom.map);
          setDomesticStats(dom.stats);
          setIntlScores(intl.map);
          setIntlStats(intl.stats);
        } else if (props.iso_a2) {
          const iso2 = props.iso_a2;
          if (validCountries.size > 0 && iso2 !== 'US' && !validCountries.has(iso2)) return;
          setSelectedAnchorId(iso2);
          setSelectedRegion(`${props.name || props.ADMIN}`);
          setIsMobileMenuOpen(false);
          const [intlRows, domRows] = await Promise.all([
            conn
              .query(
                `SELECT target_id, sci FROM 'country.parquet' WHERE source_id = '${iso2}' AND source_id != target_id`
              )
              .then((r) => r.toArray()),
            conn
              .query(`SELECT gadm_id, sci FROM 'gadm_to_country.parquet' WHERE iso2 = '${iso2}'`)
              .then((r) => r.toArray()),
          ]);
          const intl = processResults(intlRows, 'target_id', 'sci');
          const dom = processResults(domRows, 'gadm_id', 'sci');
          setIntlScores(intl.map);
          setIntlStats(intl.stats);
          setDomesticScores(dom.map);
          setDomesticStats(dom.stats);
        }
      } catch (err) {
        console.error('DuckDB query failed:', err);
      } finally {
        await conn.close();
      }
    },
    [db, validCountries, processResults]
  );

  // ─── FIX ⑤: Stable tooltip — deps are the pre-computed Maps, not raw objects
  const getTooltip = useCallback(
    ({ object }) => {
      if (!object?.properties) return null;
      const props = object.properties;
      const gadmId = props.GID_2;
      const iso2 = props.iso_a2;
      const isMissingData =
        validCountries.size > 0 && iso2 && !validCountries.has(iso2) && iso2 !== 'US';
      const isAnchor =
        (gadmId && gadmId === selectedAnchorId) || (iso2 && iso2 === selectedAnchorId);
      const score = domesticScores[gadmId] || intlScores[iso2];
      const name = props.NAME_2 || props.name || props.ADMIN;

      let statusHtml = '';
      if (isMissingData) {
        statusHtml = `<p style="font-size:11px;color:#f87171;margin:4px 0 0">No Meta SCI data</p>`;
      } else if (isAnchor) {
        statusHtml = `<p style="font-size:11px;color:#fff;margin:4px 0 0">📍 Selected anchor</p>`;
      } else if (selectedRegion === 'None') {
        statusHtml = `<p style="font-size:11px;color:#67e8f9;margin:4px 0 0">Click to set as anchor</p>`;
      } else if (score) {
        statusHtml = `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">SCI: <b style="color:#fff">${Math.round(score).toLocaleString()}</b></p>`;
      } else {
        statusHtml = `<p style="font-size:11px;color:#6b7280;margin:4px 0 0">No connection data</p>`;
      }

      return {
        html: `<div style="background:rgba(17,24,39,0.95);border:1px solid rgba(255,255,255,0.12);padding:10px 12px;border-radius:8px;pointer-events:none"><p style="font-weight:600;font-size:13px;color:#f3f4f6;margin:0">${name}</p>${statusHtml}</div>`,
        style: { backgroundColor: 'transparent', padding: 0 },
      };
    },
    // ─── Only depend on pre-computed Maps and anchor state ─────────────────
    [validCountries, selectedAnchorId, selectedRegion, domesticScores, intlScores]
  );

  const layers = useMemo(() => {
    // ─── FIX C: isZoomedIn boolean only changes when crossing zoom=4.5 ───────
    // viewState.zoom was here before — changing 60×/s on every pan frame and
    // causing both GeoJsonLayers to fully reconstruct each time.
    const zoomFactor = isZoomedIn ? 35 : 6;
    const lineWidthMin = isZoomedIn ? 0.4 : 0.05;
    return [
      new GeoJsonLayer({
        id: 'countries-layer',
        data: `${import.meta.env.BASE_URL}countries.geojson`,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 0.5,
        getLineColor: (d) => {
          const iso2 = d?.properties?.iso_a2;
          if (iso2 === selectedAnchorId) return ANCHOR_LINE;
          if (validCountries.size > 0 && iso2 !== 'US' && !validCountries.has(iso2))
            return MISSING_LINE;
          return DEFAULT_LINE;
        },
        getLineWidth: (d) => (d?.properties?.iso_a2 === selectedAnchorId ? 3 : 1),
        getFillColor: (d) => {
          const iso2 = d?.properties?.iso_a2;
          if (iso2 === 'US') return TRANSPARENT;
          if (iso2 === selectedAnchorId) return ANCHOR_FILL;
          if (validCountries.size > 0 && !validCountries.has(iso2)) return MISSING_FILL;
          return intlColors[iso2] ?? TRANSPARENT;
        },
        updateTriggers: {
          getFillColor: [intlColors, validCountries, selectedAnchorId],
          getLineColor: [validCountries, selectedAnchorId],
          getLineWidth: [selectedAnchorId],
        },
        onClick: onMapClick,
      }),

      new GeoJsonLayer({
        id: 'counties-layer',
        data: `${import.meta.env.BASE_URL}gadm41_USA_2.json`,
        pickable: true,
        stroked: true,
        filled: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 100],
        lineWidthMinPixels: lineWidthMin,
        getLineColor: (d) => {
          if (d?.properties?.GID_2 === selectedAnchorId) return ANCHOR_LINE;
          return [255, 255, 255, zoomFactor];
        },
        getLineWidth: (d) => (d?.properties?.GID_2 === selectedAnchorId ? 3 : 1),
        getFillColor: (d) => {
          if (d?.properties?.GID_2 === selectedAnchorId) return ANCHOR_FILL;
          return domesticColors[d?.properties?.GID_2] ?? TRANSPARENT;
        },
        updateTriggers: {
          getFillColor: [domesticColors, selectedAnchorId],
          getLineColor: [isZoomedIn, selectedAnchorId],
          getLineWidth: [selectedAnchorId],
          lineWidthMinPixels: [isZoomedIn],
        },
        onClick: onMapClick,
      }),
    ];
  }, [domesticColors, intlColors, validCountries, selectedAnchorId, isZoomedIn, onMapClick]);

  return (
    <div className="relative w-screen h-screen bg-gray-900 text-white font-sans overflow-hidden">
      {/* ─── FIX ④: Loading overlay ──────────────────────────────────────── */}
      {dbStatus !== 'ready' && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 bg-gray-800/90 px-3 py-2 rounded-lg text-xs text-gray-300 border border-gray-700/50 pointer-events-none">
          {dbStatus === 'loading' && (
            <>
              <svg className="w-3.5 h-3.5 animate-spin text-cyan-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              Loading data engine…
            </>
          )}
          {dbStatus === 'error' && <span className="text-red-400">Data engine failed to load</span>}
          {dbStatus === 'idle' && <span className="text-gray-500">Initialising…</span>}
        </div>
      )}

      <DeckGL
        viewState={viewState}
        onViewStateChange={(e) => {
          setViewState(e.viewState);
          // ─── FIX C: only trigger re-render when crossing the zoom threshold ─
          // that changes line widths — not on every pan frame.
          const newZoom = e.viewState.zoom;
          const wasZoomedIn = zoomRef.current > 4.5;
          const nowZoomedIn = newZoom > 4.5;
          zoomRef.current = newZoom;
          if (wasZoomedIn !== nowZoomedIn) setIsZoomedIn(nowZoomedIn);
        }}
        controller={true}
        getTooltip={getTooltip}
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
        layers={layers}
        // ─── FIX B: cap device pixel ratio ───────────────────────────────────
        // Mobile screens have DPR 2–3×. Without this, deck.gl renders at full
        // native resolution — 4–9× more pixels than a desktop 1× screen.
        // 1.5 is the sweet spot: halves fragment work with near-invisible quality loss.
        useDevicePixels={typeof window !== 'undefined' && window.devicePixelRatio > 1
          ? Math.min(window.devicePixelRatio, 1.5)
          : true}
      >
        <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
      </DeckGL>

      {/* Mobile menu toggle */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="absolute top-4 left-4 z-20 sm:hidden bg-gray-900/95 border border-gray-700/80 shadow-2xl p-3 rounded-xl flex items-center justify-center text-cyan-400"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Control card */}
      <div
        className={`absolute top-20 left-4 right-4 sm:right-auto sm:left-6 sm:top-6 sm:w-80 bg-gray-900/95 sm:bg-gray-900/80 sm:backdrop-blur-md p-5 sm:p-6 rounded-xl sm:rounded-2xl border border-gray-700/50 shadow-2xl z-10 pointer-events-auto transition-all duration-300 ease-in-out origin-top-left ${
          isMobileMenuOpen
            ? 'scale-100 opacity-100'
            : 'scale-95 opacity-0 pointer-events-none sm:scale-100 sm:opacity-100 sm:pointer-events-auto'
        }`}
      >
        <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent mb-1 sm:mb-2">
          Global Connectedness
        </h1>

        <div className="bg-gray-800/80 p-4 rounded-xl border border-gray-700/50 mb-4 mt-4 sm:mt-6">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Anchor Region</p>
          <p className="text-base sm:text-lg font-semibold text-white truncate">{selectedRegion}</p>
        </div>

        <div
          className="bg-gray-800/80 p-4 rounded-xl border border-gray-700/50 transition-opacity duration-300"
          style={{ opacity: selectedRegion === 'None' ? 0.5 : 1 }}
        >
          <div className="flex justify-between items-center mb-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Elastic Noise Filter</p>
            <span className="text-xs text-cyan-400 font-mono font-bold">
              {sliderDisplay > 0 ? '+' : ''}
              {sliderDisplay}σ
            </span>
          </div>
          {/* ─── FIX D: onChange only updates the display label (cheap) ────────
              onPointerUp commits to thresholdMultiplier which triggers the
              expensive buildColorLookup via useMemo. Dragging is now free. */}
          <input
            type="range"
            min="-2"
            max="3"
            step="0.1"
            value={sliderDisplay}
            onChange={(e) => setSliderDisplay(parseFloat(e.target.value))}
            onPointerUp={(e) => setThresholdMultiplier(parseFloat(e.target.value))}
            onKeyUp={(e) => setThresholdMultiplier(parseFloat(e.target.value))}
            disabled={selectedRegion === 'None'}
            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
        </div>
      </div>
    </div>
  );
}