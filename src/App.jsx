import React, { useState, useEffect, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import * as duckdb from '@duckdb/duckdb-wasm';
import 'maplibre-gl/dist/maplibre-gl.css';

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
  const [hoverInfo, setHoverInfo] = useState(null);
  const [thresholdMultiplier, setThresholdMultiplier] = useState(0); 
  
  // --- Track ViewState for dynamic line fading ---
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

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
        
       // Dynamic base URL resolver for GitHub Pages subdirectories
        const deployBaseUrl = window.location.origin + import.meta.env.BASE_URL;
        
        await dbInstance.registerFileURL('gadm_domestic.parquet', new URL('gadm_domestic.parquet', deployBaseUrl).href, duckdb.DuckDBDataProtocol.HTTP, false);
        await dbInstance.registerFileURL('country.parquet', new URL('country.parquet', deployBaseUrl).href, duckdb.DuckDBDataProtocol.HTTP, false);
        await dbInstance.registerFileURL('gadm_to_country.parquet', new URL('gadm_to_country.parquet', deployBaseUrl).href, duckdb.DuckDBDataProtocol.HTTP, false);

        setDb(dbInstance);
        console.log("🟢 Engine Status: Adaptive Resolution Matrix Active");
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
        setSelectedRegion(`${props.NAME_2 || "Unknown"} County, ${props.NAME_1}`);

        const domQ = await conn.query(`SELECT target_gadm, sci FROM 'gadm_domestic.parquet' WHERE source_gadm = '${gadmId}'`);
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
        setSelectedRegion(`${props.name || props.ADMIN}`);

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
  }, [db]);

  const layers = [
    new GeoJsonLayer({
      id: 'countries-layer',
      data: `${import.meta.env.BASE_URL}countries.geojson`, // Dynamic path fix
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 0.5,
      getLineColor: [255, 255, 255, 20], 
      getFillColor: (d) => {
        if (d?.properties?.iso_a2 === 'US') return [0, 0, 0, 0]; 
        return getLogColor(intlMap[d?.properties?.iso_a2], intlStats, thresholdMultiplier, BLUE_THEME);
      },
      updateTriggers: { getFillColor: [intlMap, intlStats, thresholdMultiplier] },
      onHover: (info) => setHoverInfo(info),
      onClick: onMapClick 
    }),
    
    new GeoJsonLayer({
      id: 'counties-layer',
      data: `${import.meta.env.BASE_URL}gadm41_USA_2.json`, // Dynamic path fix
      pickable: true,
      stroked: true,
      filled: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 100], 
      
      // --- THE ADAPTIVE VISUAL FIX ---
      // Dynamically drop stroke thickness and opacity based on active viewState zoom
      lineWidthMinPixels: viewState.zoom > 4.5 ? 0.4 : 0.05,
      getLineColor: [255, 255, 255, viewState.zoom > 4.5 ? 35 : 6], 
      
      getFillColor: (d) => getLogColor(domesticMap[d?.properties?.GID_2], domesticStats, thresholdMultiplier, BLUE_THEME),
      updateTriggers: { 
        getFillColor: [domesticMap, domesticStats, thresholdMultiplier],
        getLineColor: [viewState.zoom],
        lineWidthMinPixels: [viewState.zoom]
      },
      onHover: (info) => setHoverInfo(info),
      onClick: onMapClick
    })
  ];

  return (
    <div className="relative w-screen h-screen bg-gray-900 text-white font-sans overflow-hidden">
      {/* Updated DeckGL properties to actively listen and broadcast viewState modifications */}
      <DeckGL 
        viewState={viewState}
        onViewStateChange={e => setViewState(e.viewState)}
        controller={true} 
        getCursor={({isHovering}) => isHovering ? 'pointer' : 'grab'} 
        layers={layers}
      >
        <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
      </DeckGL>

      <div className="absolute top-6 left-6 w-80 bg-gray-900/80 backdrop-blur-md p-6 rounded-2xl border border-gray-700/50 shadow-2xl pointer-events-none">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent mb-2">Global Connectedness</h1>
        
        <div className="bg-gray-800/80 p-4 rounded-xl border border-gray-700/50 mb-4 mt-6">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Anchor Region</p>
          <p className="text-lg font-semibold text-white truncate">{selectedRegion}</p>
        </div>

        <div className="bg-gray-800/80 p-4 rounded-xl border border-gray-700/50 pointer-events-auto transition-opacity duration-300" style={{ opacity: selectedRegion === "None" ? 0.5 : 1 }}>
          <div className="flex justify-between items-center mb-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Elastic Noise Filter</p>
            <span className="text-xs text-cyan-400 font-mono font-bold">{thresholdMultiplier > 0 ? '+' : ''}{thresholdMultiplier}σ</span>
          </div>
          <input type="range" min="-2" max="3" step="0.1" value={thresholdMultiplier} onChange={(e) => setThresholdMultiplier(parseFloat(e.target.value))} disabled={selectedRegion === "None"} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
        </div>
      </div>

      {hoverInfo?.object?.properties && (
        <div className="absolute z-50 bg-gray-800/95 backdrop-blur-md border border-gray-600 p-3 rounded-lg shadow-2xl pointer-events-none transform -translate-x-1/2 -translate-y-[120%]" style={{ left: hoverInfo.x, top: hoverInfo.y }}>
          <p className="font-bold text-sm text-gray-100 mb-1">{hoverInfo.object.properties.NAME_2 || hoverInfo.object.properties.name || hoverInfo.object.properties.ADMIN}</p>
          {(() => {
            const gadmId = hoverInfo.object.properties.GID_2;
            const iso2 = hoverInfo.object.properties.iso_a2;
            const score = domesticMap[gadmId] || intlMap[iso2];
            
            return score ? (
              <p className="text-xs text-gray-400 flex items-center gap-4">
                <span>SCI Score:</span>
                <span className="font-mono font-bold text-white">{Math.round(score).toLocaleString()}</span>
              </p>
            ) : <p className="text-xs text-gray-500 italic">No connection data</p>;
          })()}
        </div>
      )}
    </div>
  );
}