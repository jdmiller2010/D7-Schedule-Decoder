// parse-xlsx.js — Shared XLSX parser for D7 Schedule Generator
// Reads the single-sheet XLSX source file and returns structured game data
// with full audit metadata (removed games, moved games, highlights, warnings).

'use strict';

const XLSX = require('xlsx');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// RGB value (no alpha) written by Excel for the "light yellow" highlight
const YELLOW_RGB = 'FFFF99';

// Division headers as they appear in the Key CSV
const DIVISION_HEADERS = new Set([
  '3A Player Pitch Baseball', 'Major Baseball', '50/70 Baseball', 'JR Baseball',
  '2A Softball', '3A Softball', 'Major Softball', 'JR Softball',
]);

// Patterns that make a cell with no game codes a known non-error.
// Order matters: first match wins.
const KNOWN_NOOP_PATTERNS = [
  { re: /game\s*removed/i,              label: 'game_removed'  },
  { re: /east\s+lane\s+no\s+interle/i, label: 'east_lane'     },
  { re: /moved?\s+to/i,                label: 'moved_to'      },
  { re: /no\s+\d+\s*(pm|am)\s*game/i,  label: 'time_note'     }, // "NO 3 PM GAME"
  { re: /\(?state\s+st\.?\)?/i,        label: 'location_note' },
  { re: /\(?no\s+east\s+lane\)?/i,     label: 'east_lane'     },
];

// ---------------------------------------------------------------------------
// Simple CSV parser (handles quoted fields with commas/newlines)
// ---------------------------------------------------------------------------
function parseCSV(content) {
  const rows = [];
  let current = [], cell = '', inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      current.push(cell.trim()); cell = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip CR
    } else if (ch === '\n' && !inQuotes) {
      current.push(cell.trim());
      rows.push(current);
      current = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || current.length > 0) {
    current.push(cell.trim());
    if (current.some(c => c !== '')) rows.push(current);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Parse Key CSV → map of teamNum → team info
// ---------------------------------------------------------------------------
function parseKey(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(content);
  const teams = {};
  let currentDivision = '';
  for (const row of rows) {
    if (!row[0]) continue;
    const first = row[0];
    if (DIVISION_HEADERS.has(first)) {
      currentDivision = first;
    } else if (first === 'Team' || first.includes('Inter-League')) {
      continue;
    } else if (row[1] && /^[A-H]\d+$/.test(row[1])) {
      teams[row[1]] = {
        name: first, num: row[1],
        manager: row[2] || '', phone: row[3] || '', email: row[4] || '',
        division: currentDivision,
      };
    }
  }
  return teams;
}

// ---------------------------------------------------------------------------
// Normalize a date header cell value → "Month Day" string
// "April 20th Mon" → "April 20"
// ---------------------------------------------------------------------------
function normalizeDate(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/(\d+)(st|nd|rd|th)/i, '$1')
    .replace(/\s+(Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun)\w*/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Read a single cell from the worksheet: returns { value, changed }
// changed = true when the cell has the light-yellow highlight
// ---------------------------------------------------------------------------
function getCellInfo(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell || cell.v == null) return { value: null, changed: false };
  const value = String(cell.v).trim() || null;
  const changed = cell.s?.fgColor?.rgb === YELLOW_RGB;
  return { value, changed };
}

// ---------------------------------------------------------------------------
// Parse game codes from a single cell's text.
//
// Returns:
//   activeGames    — games that are scheduled (play at this slot)
//   movedFromGames — games whose code appears here but were moved away
//                    (cell text contains "MOVED TO" after the code)
//   issues         — auto-fix notices and malformed-code warnings
//   normalizedText — text after normalization (for reporting)
// ---------------------------------------------------------------------------
function parseCellGames(rawText) {
  if (!rawText) return { activeGames: [], movedFromGames: [], issues: [], normalizedText: '' };

  const issues = [];

  // Normalize common formatting glitches
  let text = rawText
    .replace(/[\r\n]+/g, ' ')
    .replace(/(\d+);(\d+)/g, (m, h, min) => {
      issues.push({ type: 'semicolon_time', raw: m, fixed: `${h}:${min}` });
      return `${h}:${min}`;
    })
    .replace(/([A-H])\s+(\d)/g, (m, l, d) => {
      issues.push({ type: 'space_in_code', raw: m, fixed: l + d });
      return l + d;
    })
    .replace(/--/g, () => {
      issues.push({ type: 'double_dash', raw: '--', fixed: '-' });
      return '-';
    })
    .trim();

  // Find all game-code matches: e.g. A3-4, B12-F9, F12-9
  const gameRe = /([A-H]\d+)-([A-H]?\d+)/g;
  let match;
  const found = [];
  while ((match = gameRe.exec(text)) !== null) {
    found.push({
      team1raw: match[1],
      team2raw: match[2],
      index:    match.index,
      end:      match.index + match[0].length,
    });
  }

  const activeGames    = [];
  const movedFromGames = [];

  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    const prefix = m.team1raw[0];
    const team2  = /^[A-H]/.test(m.team2raw) ? m.team2raw : prefix + m.team2raw;

    // Validate numeric parts (1–2 digits each)
    if (!/^\d{1,2}$/.test(m.team1raw.slice(1)) || !/^[A-H]\d{1,2}$/.test(team2)) {
      issues.push({ type: 'invalid_team_code', raw: `${m.team1raw}-${m.team2raw}` });
      continue;
    }

    // Text between this code's end and the next code's start (or end of string)
    const nextStart = i + 1 < found.length ? found[i + 1].index : text.length;
    const between   = text.substring(m.end, nextStart);

    const timeMatch   = between.match(/(\d{1,2}:\d{2})/);
    const movedMatch  = between.match(/moved?\s+to\s+(.+?)(?:\s*$)/i);
    const isMovedFrom = movedMatch !== null;

    const gameObj = { team1: m.team1raw, team2, time: timeMatch ? timeMatch[1] : null };

    if (isMovedFrom) {
      movedFromGames.push({ ...gameObj, movedNote: movedMatch[1].trim() });
    } else {
      activeGames.push(gameObj);
    }
  }

  // Look for broken code patterns left after removing all valid games
  // e.g. "C-3" (letter dash digits, missing the digit-team prefix)
  const stripped = text
    .replace(/([A-H]\d+)-([A-H]?\d+)/g, '')
    .replace(/\d{1,2}:\d{2}/g, '');
  const brokenCode = stripped.match(/[A-H]-\d+/);
  if (brokenCode) {
    issues.push({ type: 'broken_team_code', raw: brokenCode[0] });
  }

  return { activeGames, movedFromGames, issues, normalizedText: text };
}

// ---------------------------------------------------------------------------
// Quick cell content classifier — used for early routing before game parsing
// ---------------------------------------------------------------------------
function classifyCell(rawText) {
  if (!rawText) return 'empty';
  if (/game\s*removed/i.test(rawText) && !/[A-H]\d+-[A-H]?\d+/.test(rawText)) return 'removed';
  if (/east\s+lane\s+no\s+interle/i.test(rawText)) return 'east_lane'; // may still have game codes
  return 'data';
}

// ---------------------------------------------------------------------------
// Main entry point: parse the XLSX file and return structured data
//
// Returns:
//   games           — active scheduled game objects (with changed/movedNote fields)
//   removedCells    — cells where D7 marked a game as removed
//   movedFromCells  — games whose source slot is annotated "MOVED TO ..."
//   eastLaneCells   — "EAST LANE NO INTERLEAGUE" annotations (may include games)
//   skippedCells    — cells with content that could not be parsed or classified
//   partialCells    — cells where some games parsed but a broken code remnant was found
//   normalizedCells — cells where auto-fixes were applied (semicolon times, spaces, etc.)
//   unknownLocations— location names that don't appear in the "field info" sheet
//   knownLocations  — Set of location names from the "field info" sheet
//   weeksFound      — sorted array of week numbers that contained game data
// ---------------------------------------------------------------------------
function parseScheduleXLSX(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath, { cellStyles: true });
  const ws = wb.Sheets['Schedule'];
  if (!ws) throw new Error(`XLSX file is missing a "Schedule" sheet: ${xlsxPath}`);

  const fieldInfoWs = wb.Sheets['field info'];

  // ── Build the set of known locations from the field info sheet ─────────
  const knownLocations = new Set();
  if (fieldInfoWs) {
    const fiRange = XLSX.utils.decode_range(fieldInfoWs['!ref']);
    for (let r = fiRange.s.r; r <= fiRange.e.r; r++) {
      const cell = fieldInfoWs[XLSX.utils.encode_cell({ r, c: 1 })]; // column B
      const v = cell?.v;
      if (v && typeof v === 'string' && v !== 'Location') {
        knownLocations.add(v.trim());
      }
    }
  }

  // ── Result buckets ─────────────────────────────────────────────────────
  const games            = [];   // { week, date, location, team1, team2, time, changed }
  const removedCells     = [];   // { week, date, location, rawCell, changed }
  const movedFromCells   = [];   // { week, date, location, team1, team2, time, movedNote, changed }
  const eastLaneCells    = [];   // { week, date, location, rawCell, changed, activeGames }
  const skippedCells     = [];   // { week, date, location, rawCell, changed, category }
  const partialCells     = [];   // { week, date, location, rawCell, broken }
  const normalizedCells  = [];   // { week, date, location, rawCell, normalized, fixes }
  const unknownLocations    = [];   // { location, week }
  const seenUnknownLocNames = new Set(); // fast dedup for unknownLocations

  const seenLocations    = new Set();

  const range = XLSX.utils.decode_range(ws['!ref']);

  let currentWeek  = null;
  let currentDates = [];

  // ── Walk every row ─────────────────────────────────────────────────────
  for (let r = range.s.r; r <= range.e.r; r++) {
    const { value: col0 } = getCellInfo(ws, r, 0);
    if (!col0) continue;

    // ── Week header row ──────────────────────────────────────────────────
    const weekMatch = col0.match(/^WEEK\s+(\d+)$/i);
    if (weekMatch) {
      currentWeek  = parseInt(weekMatch[1], 10);
      currentDates = [];
      for (let c = 1; c <= 6; c++) {
        const { value } = getCellInfo(ws, r, c);
        currentDates.push(normalizeDate(value));
      }
      continue;
    }

    if (currentWeek === null) continue;

    // ── Location data row ────────────────────────────────────────────────
    const location = col0;
    seenLocations.add(location);

    // Flag locations not in the field info sheet (once per unique name)
    if (knownLocations.size > 0 && !knownLocations.has(location) && !seenUnknownLocNames.has(location)) {
      seenUnknownLocNames.add(location);
      unknownLocations.push({ location, week: currentWeek });
    }

    // ── Walk each date column (B–G = indices 1–6) ────────────────────────
    for (let c = 1; c <= 6; c++) {
      const { value: rawValue, changed } = getCellInfo(ws, r, c);
      if (!rawValue) continue;

      const date = currentDates[c - 1];
      if (!date) continue;

      const ctx = { week: currentWeek, date, location, rawCell: rawValue, changed };
      const cellType = classifyCell(rawValue);

      // ── "Game removed" ───────────────────────────────────────────────
      if (cellType === 'removed') {
        removedCells.push(ctx);
        continue;
      }

      // ── Parse game codes (handles MOVED TO per-game detection) ────────
      const { activeGames, movedFromGames, issues, normalizedText } = parseCellGames(rawValue);

      // Track "EAST LANE NO INTERLEAGUE" cells separately (may also have active games)
      if (cellType === 'east_lane') {
        eastLaneCells.push({ ...ctx, embeddedGameCount: activeGames.length });
        // Do NOT skip — fall through to add any embedded active games
      }

      // Auto-fix tracking
      const autoFixes = issues.filter(i =>
        i.type === 'semicolon_time' || i.type === 'space_in_code' || i.type === 'double_dash'
      );
      if (autoFixes.length > 0) {
        normalizedCells.push({ ...ctx, normalized: normalizedText, fixes: autoFixes });
      }

      // Partial-parse tracking (game found BUT broken code remnant also present)
      const broken = issues.filter(i => i.type === 'broken_team_code');
      if (broken.length > 0 && (activeGames.length > 0 || movedFromGames.length > 0)) {
        partialCells.push({ ...ctx, broken: broken.map(b => b.raw) });
      }

      // Record moved-from games (game code was here but game moved away)
      for (const g of movedFromGames) {
        movedFromCells.push({ ...ctx, team1: g.team1, team2: g.team2, time: g.time, movedNote: g.movedNote });
      }

      // No usable content at all
      if (activeGames.length === 0 && movedFromGames.length === 0) {
        // Known non-errors: east_lane cells, "NO 3 PM GAME", location notes, etc.
        const isKnownNoop = cellType === 'east_lane' ||
          KNOWN_NOOP_PATTERNS.some(p => p.re.test(rawValue));
        if (!isKnownNoop) {
          skippedCells.push({ ...ctx, category: 'unrecognized' });
        }
        continue;
      }

      // Record active games
      for (const g of activeGames) {
        games.push({
          week:     currentWeek,
          date,
          location,
          team1:    g.team1,
          team2:    g.team2,
          time:     g.time,
          changed,
        });
      }
    }
  }

  const weeksFound = [...new Set(games.map(g => g.week))].sort((a, b) => a - b);

  return {
    games,
    removedCells,
    movedFromCells,
    eastLaneCells,
    skippedCells,
    partialCells,
    normalizedCells,
    unknownLocations,
    knownLocations,
    weeksFound,
  };
}

module.exports = { parseKey, parseScheduleXLSX };
