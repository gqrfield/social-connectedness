import React, { useState, useEffect, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import * as duckdb from '@duckdb/duckdb-wasm';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';

const INITIAL_VIEW_STATE = { longitude: -40, latitude: 35, zoom: 2.5, pitch: 0, bearing: 0 };
const BLUE_THEME = { min: [30, 58, 138], max: [34, 211, 238] }; 

function getLogColor(sciScore, stats, multiplier, colorTheme) {
  if (!sciScore || !stats) return [0, 0, 0, 0]; 
  const logScore = Math.log(sciScore);
  const threshold = stats.mean + (stats.stdDev * multiplier); 
  if (logScore < threshold) return [0, 0, 0, 0]; 
  
  const t = Math.max(0, Math.min(1, (logScore - threshold) / (stats.maxLog - threshold)));
  const [minR, minG, minB] = colorTheme.min;
  const [maxR, maxG, maxB] = colorTheme.max;

  return [
    Math.round(minR + t * (maxR - minR)),
    Math.round(minG + t * (maxG - minG)),
    Math.round(minB + t * (maxB - minB)),
    Math.round(80 + t * (255 - 80))
  ];
}

export default function App() {
  const [db, setDb] = useState(null);
  const [selectedRegion, setSelectedRegion] = useState("None");
  const [selectedAnchorId, setSelectedAnchorId] = useState(null);
  const [thresholdMultiplier, setThresholdMultiplier] = useState(0); 
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  
  // Mobile UI Toggle State
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  const [validCountries, setValidCountries] = useState(new Set());
  const [domesticMap, setDomesticMap] = useState({});
  const [domesticStats, setDomesticStats] = useState(null);
  const [intlMap, setIntlMap] = useState({});
  const [intlStats, setIntlStats] = useState(null);

  useEffect(() => {
    async function initDB() {
      try {
        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
        const worker_url = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
        
        const worker = new Worker(worker_url);
        const dbInstance = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
        await dbInstance.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(worker_url); 
        
        const deployBaseUrl = window.location.origin + import.meta.env.BASE_URL;
        await dbInstance.registerFileURL('gadm_domestic.parquet', new URL('gadm_domestic.parquet', deployBaseUrl).href, duckdb.DuckDBDataProtocol.HTTP, false);
        await dbInstance.registerFileURL('country.parquet', new URL('country.parquet', deployBaseUrl).href, duckdb.DuckDBDataProtocol.HTTP, false);
        await dbInstance.registerFileURL('gadm_to_country.parquet', new URL('gadm_to_country.parquet', deployBaseUrl).href, duckdb.DuckDBDataProtocol.HTTP, false);

        setDb(dbInstance);

        const conn = await dbInstance.connect();
        const validCheck = await conn.query(`SELECT DISTINCT source_id FROM 'country.parquet'`);
        const validSet = new Set(validCheck.toArray().map(r => r.toJSON().source_id));
        setValidCountries(validSet);
        await conn.close();
      } catch (error) {
        console.error("Engine Initialization Failed:", error);
      }
    }
    initDB();
  }, []);

  const processResults = (rows, keyCol, valCol) => {
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
    let stats = null;
    if (logScores.length > 0) {
      const mean = logScores.reduce((a, b) => a + b, 0) / logScores.length;
      const variance = logScores.map(v => Math.pow(v - mean, 2)).reduce((a, b) => a + b, 0) / logScores.length;
      stats = { mean, stdDev: Math.sqrt(variance), maxLog: Math.max(...logScores) };
    }
    return { map, stats };
  };

  const onMapClick = useCallback(async (info) => {
    if (!info.object?.properties || !db) return;
    
    const props = info.object.properties;
    const conn = await db.connect();

    try {
      if (props.GID_2) {
        const gadmId = props.GID_2; 
        setSelectedAnchorId(gadmId);
        setSelectedRegion(`${props.NAME_2 || "Unknown"} County, ${props.NAME_1}`);
        setIsMobileMenuOpen(false); // Auto-close menu on selection

        const domQ = await conn.query(`SELECT target_gadm, sci FROM 'gadm_domestic.parquet' WHERE source_gadm = '${gadmId}' AND source_gadm != target_gadm`);
        const domData = processResults(domQ.toArray(), 'target_gadm', 'sci');
        setDomesticMap(domData.map);
        setDomesticStats(domData.stats);

        const intlQ = await conn.query(`SELECT iso2, sci FROM 'gadm_to_country.parquet' WHERE gadm_id = '${gadmId}'`);
        const intData = processResults(intlQ.toArray(), 'iso2', 'sci');
        setIntlMap(intData.map);
        setIntlStats(intData.stats);
      } 
      else if (props.iso_a2) {
        const iso2 = props.iso_a2;

        if (validCountries.size > 0 && iso2 !== 'US' && !validCountries.has(iso2)) return;

        setSelectedAnchorId(iso2);
        setSelectedRegion(`${props.name || props.ADMIN}`);
        setIsMobileMenuOpen(false); 

        const intlQ = await conn.query(`SELECT target_id, sci FROM 'country.parquet' WHERE source_id = '${iso2}' AND source_id != target_id`);
        const intData = processResults(intlQ.toArray(), 'target_id', 'sci');
        setIntlMap(intData.map);
        setIntlStats(intData.stats);

        const domQ = await conn.query(`SELECT gadm_id, sci FROM 'gadm_to_country.parquet' WHERE iso2 = '${iso2}'`);
        const domData = processResults(domQ.toArray(), 'gadm_id', 'sci');
        setDomesticMap(domData.map);
        setDomesticStats(domData.stats);
      }
    } catch (error) {
      console.error("🔥 DuckDB Query Failed:", error);
    } finally {
      await conn.close();
    }
  }, [db, validCountries]);

  // NATIVE DECK.GL TOOLTIP RENDERER (Bypasses React DOM diffing for massive performance boost)
  const getTooltip = useCallback(({object}) => {
    if (!object || !object.properties) return null;
    
    const props = object.properties;
    const gadmId = props.GID_2;
    const iso2 = props.iso_a2;
    const isMissingData = validCountries.size > 0 && iso2 && !validCountries.has(iso2) && iso2 !== 'US';
    const isAnchor = (gadmId && gadmId === selectedAnchorId) || (iso2 && iso2 === selectedAnchorId);
    const score = domesticMap[gadmId] || intlMap[iso2];
    const name = props.NAME_2 || props.name || props.ADMIN;

    let statusHtml = '';
    
    // Updated Priority Logic
    if (isMissingData) {
      statusHtml = `<p class="text-xs text-red-400 italic mt-1">No Meta SCI Data Available</p>`;
    } else if (isAnchor) {
      statusHtml = `<p class="text-xs text-white font-bold bg-white/20 px-2 py-1 rounded-md inline-block mt-1">📍 Selected Anchor</p>`;
    } else if (selectedRegion === "None") {
      statusHtml = `<p class="text-xs text-cyan-400 italic mt-1">Click to set as anchor</p>`;
    } else if (score) {
      statusHtml = `<p class="text-xs text-gray-400 flex items-center gap-4 mt-1"><span>SCI Score:</span><span class="font-mono font-bold text-white">${Math.round(score).toLocaleString()}</span></p>`;
    } else {
      statusHtml = `<p class="text-xs text-gray-500 italic mt-1">No connection data</p>`;
    }

    return {
      html: `
        <div class="bg-gray-800/95 backdrop-blur-md border border-gray-600 p-3 rounded-lg shadow-2xl">
          <p class="font-bold text-sm text-gray-100">${name}</p>
          ${statusHtml}
        </div>
      `,
      style: { backgroundColor: 'transparent', padding: 0 } // Overrides default black tooltip box
    };
  }, [validCountries, selectedAnchorId, selectedRegion, domesticMap, intlMap]);

  const layers = [
    new GeoJsonLayer({
      id: 'countries-layer',
      data: `${import.meta.env.BASE_URL}countries.geojson`, 
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 0.5,
      getLineColor: (d) => {
        const iso2 = d?.properties?.iso_a2;
        if (iso2 === selectedAnchorId) return [255, 255, 255, 255]; 
        if (validCountries.size > 0 && iso2 !== 'US' && !validCountries.has(iso2)) return [255, 255, 255, 4];
        return [255, 255, 255, 20]; 
      }, 
      getLineWidth: (d) => d?.properties?.iso_a2 === selectedAnchorId ? 3 : 1, 
      getFillColor: (d) => {
        const iso2 = d?.properties?.iso_a2;
        if (iso2 === 'US') return [0, 0, 0, 0]; 
        if (iso2 === selectedAnchorId) return [255, 255, 255, 100]; 
        if (validCountries.size > 0 && !validCountries.has(iso2)) return [0, 0, 0, 120]; 
        return getLogColor(intlMap[iso2], intlStats, thresholdMultiplier, BLUE_THEME);
      },
      updateTriggers: { 
        getFillColor: [intlMap, intlStats, thresholdMultiplier, validCountries, selectedAnchorId],
        getLineColor: [validCountries, selectedAnchorId],
        getLineWidth: [selectedAnchorId]
      },
      onClick: onMapClick 
    }),
    
    new GeoJsonLayer({
      id: 'counties-layer',
      data: `${import.meta.env.BASE_URL}gadm41_USA_2.json`, 
      pickable: true,
      stroked: true,
      filled: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 100], 
      lineWidthMinPixels: viewState.zoom > 4.5 ? 0.4 : 0.05,
      getLineColor: (d) => {
        if (d?.properties?.GID_2 === selectedAnchorId) return [255, 255, 255, 255];
        return [255, 255, 255, viewState.zoom > 4.5 ? 35 : 6];
      }, 
      getLineWidth: (d) => d?.properties?.GID_2 === selectedAnchorId ? 3 : 1, 
      getFillColor: (d) => {
        if (d?.properties?.GID_2 === selectedAnchorId) return [255, 255, 255, 100]; 
        return getLogColor(domesticMap[d?.properties?.GID_2], domesticStats, thresholdMultiplier, BLUE_THEME);
      },
      updateTriggers: { 
        getFillColor: [domesticMap, domesticStats, thresholdMultiplier, selectedAnchorId],
        getLineColor: [viewState.zoom, selectedAnchorId],
        getLineWidth: [selectedAnchorId],
        lineWidthMinPixels: [viewState.zoom]
      },
      onClick: onMapClick
    })
  ];

  return (
    <div className="relative w-screen h-screen bg-gray-900 text-white font-sans overflow-hidden">
      <DeckGL 
        viewState={viewState}
        onViewStateChange={e => setViewState(e.viewState)}
        controller={true} 
        getTooltip={getTooltip} // NATIVE PERFORMANCE FIX
        getCursor={({isHovering}) => isHovering ? 'pointer' : 'grab'} 
        layers={layers}
      >
        <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
      </DeckGL>

      {/* MOBILE MENU TOGGLE BUTTON (Hidden on Desktop) */}
      <button 
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="absolute top-4 left-4 z-20 sm:hidden bg-gray-900/95 border border-gray-700/80 shadow-2xl p-3 rounded-xl flex items-center justify-center text-cyan-400"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* RESPONSIVE CONTROL CARD */}
      <div className={`absolute top-20 left-4 right-4 sm:right-auto sm:left-6 sm:top-6 sm:w-80 bg-gray-900/95 sm:bg-gray-900/80 sm:backdrop-blur-md p-5 sm:p-6 rounded-xl sm:rounded-2xl border border-gray-700/50 shadow-2xl z-10 pointer-events-auto transition-all duration-300 ease-in-out origin-top-left ${isMobileMenuOpen ? 'scale-100 opacity-100' : 'scale-95 opacity-0 pointer-events-none sm:scale-100 sm:opacity-100 sm:pointer-events-auto'}`}>
        <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent mb-1 sm:mb-2">Global Connectedness</h1>
        
        <div className="bg-gray-800/80 p-4 rounded-xl border border-gray-700/50 mb-4 mt-4 sm:mt-6">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Anchor Region</p>
          <p className="text-base sm:text-lg font-semibold text-white truncate">{selectedRegion}</p>
        </div>

        <div className="bg-gray-800/80 p-4 rounded-xl border border-gray-700/50 transition-opacity duration-300" style={{ opacity: selectedRegion === "None" ? 0.5 : 1 }}>
          <div className="flex justify-between items-center mb-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Elastic Noise Filter</p>
            <span className="text-xs text-cyan-400 font-mono font-bold">{thresholdMultiplier > 0 ? '+' : ''}{thresholdMultiplier}σ</span>
          </div>
          <input type="range" min="-2" max="3" step="0.1" value={thresholdMultiplier} onChange={(e) => setThresholdMultiplier(parseFloat(e.target.value))} disabled={selectedRegion === "None"} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
        </div>
      </div>
    </div>
  );
}