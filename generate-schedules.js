// D7 Schedule Generator
// Reads the XLSX source file and outputs HTML schedule documents per team and per location.
// Usage: node generate-schedules.js

const fs = require('fs');
const path = require('path');
const { getPasswordHash, passwordGateSnippet, injectGate, navBar, NAV_CSS, PAGE_HEADER_CSS, SCHEDULE_INFO_BANNER, FOOTER_HTML, FOOTER_CSS, DIVISION_ORDER } = require('./config');
const { parseKey, parseScheduleXLSX } = require('./parse-xlsx');
const gateSnippet = passwordGateSnippet(getPasswordHash());

// ---------------------------------------------------------------------------
// Date / time helpers
// ---------------------------------------------------------------------------
function parseDate(str) {
  return new Date(`${str} 2026`);
}

// All games run 9 AM – 6 PM. Times in the CSV have no AM/PM designator.
// Hours 7–11 → AM (e.g. 9:00 AM Saturday morning)
// Hour 12 and hours 1–6 → PM (12:30 PM, 3:00 PM, 6:00 PM)
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function formatDateWithDay(str) {
  const d = parseDate(str);
  return DAYS[d.getDay()];
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const isPM = h === 12 || (h >= 1 && h <= 6);
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
}

// ---------------------------------------------------------------------------
// Phone link helper — strips formatting, adds +1 country code for tel: URI
// ---------------------------------------------------------------------------
function phoneLink(phone, fallback = '—') {
  if (!phone) return fallback;
  const digits = phone.replace(/\D/g, '');
  return `<a href="tel:+1${digits}">${phone}</a>`;
}

// ---------------------------------------------------------------------------
// Division color map
// ---------------------------------------------------------------------------
const DIVISION_COLORS = {
  '3A Player Pitch Baseball': { bg: '#1a365d', light: '#ebf8ff' },
  'Major Baseball':           { bg: '#2d3748', light: '#f7fafc' },
  '50/70 Baseball':           { bg: '#744210', light: '#fffbeb' },
  'JR Baseball':              { bg: '#22543d', light: '#f0fff4' },
  '2A Softball':              { bg: '#702459', light: '#fff5f7' },
  '3A Softball':              { bg: '#553c9a', light: '#faf5ff' },
  'Major Softball':           { bg: '#7b341e', light: '#fff5f0' },
  'JR Softball':              { bg: '#065666', light: '#edfdfd' },
};

function divisionColor(division) {
  return DIVISION_COLORS[division] || { bg: '#2c5282', light: '#ebf4ff' };
}

// Sport each division belongs to — used for home-page filters and warning maps
const DIVISION_SPORT = {
  '3A Player Pitch Baseball': 'baseball',
  'Major Baseball':           'baseball',
  '50/70 Baseball':           'baseball',
  'JR Baseball':              'baseball',
  '2A Softball':              'softball',
  '3A Softball':              'softball',
  'Major Softball':           'softball',
  'JR Softball':              'softball',
};

// Resolve display time for a game: explicit time → formatted, else Saturday default TBD, weekday default 6 PM
function resolveTime(g) {
  if (g.time) return formatTime(g.time);
  return parseDate(g.date).getDay() === 6 ? 'TBD' : '6:00 PM';
}

// Sort games by date asc, then time asc with timeless games last
function sortGames(games) {
  return games.slice().sort((a, b) => {
    const d = parseDate(a.date) - parseDate(b.date);
    if (d !== 0) return d;
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });
}

// ---------------------------------------------------------------------------
// League extraction — maps a team name to its parent league organisation
// Multi-word leagues must appear before any single-word league they start with
// ---------------------------------------------------------------------------
const KNOWN_LEAGUES = [
  'East Lane', 'Timber Country', 'South Salem', 'West Salem', 'Mt. Angel', 'St. Paul',
  'Keizer', 'Parrish', 'Cascade', 'Eugene', 'Sheldon', 'Sprague', 'Silverton', 'Corvallis',
];

function extractLeague(name) {
  for (const league of KNOWN_LEAGUES) {
    if (name.startsWith(league)) return league;
  }
  // Fallback: everything before ' - '
  const di = name.indexOf(' - ');
  if (di !== -1) return name.slice(0, di).trim();
  return name.split(' ')[0];
}

// ---------------------------------------------------------------------------
// HTML shared styles + CSV download script
// ---------------------------------------------------------------------------
const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
         margin: 0; padding: 0; background: #f0f4f8; color: #2d3748; }
  .page-body { padding: 1.5em; }
  ${NAV_CSS}
  ${PAGE_HEADER_CSS}
  ${FOOTER_CSS}
  table { width: 100%; border-collapse: collapse; background: white;
          border-radius: 8px; overflow: hidden;
          box-shadow: 0 2px 6px rgba(0,0,0,0.12); margin-top: 1.5em; }
  th { padding: 0.7em 1em; text-align: left; font-size: 0.85em;
       letter-spacing: 0.04em; text-transform: uppercase; color: white; }
  td { padding: 0.65em 1em; border-bottom: 1px solid #e2e8f0; font-size: 0.9em; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: #f7faff; }
  .pill { display: inline-block; padding: 0.15em 0.6em; border-radius: 9999px;
          font-size: 0.78em; font-weight: 600; }
  .home-pill { background: #c6f6d5; color: #276749; }
  .away-pill { background: #fed7d7; color: #9b2c2c; }
  .no-games { text-align: center; padding: 2.5em; color: #a0aec0; font-style: italic; }
  .contact small { color: #718096; font-size: 0.85em; display: block; }
  .week-label { font-size: 0.78em; color: #a0aec0; }
  .import-warn { background: #fffbeb; border: 2px solid #f6ad55; border-radius: 8px;
                 padding: 0.9em 1.25em; margin-bottom: 1.25em; font-size: 0.88em; }
  .import-warn strong { color: #744210; display: block; margin-bottom: 0.4em; }
  .import-warn ul { margin: 0.4em 0 0.5em 1.2em; padding: 0; color: #744210; }
  .import-warn li { margin: 0.2em 0; }
  .import-warn a { color: #744210; font-weight: 600; }
  .changed-badge { display: inline-block; background: #fefcbf; color: #744210;
                   border: 1px solid #f6e05e; border-radius: 9999px;
                   font-size: 0.7em; font-weight: 700; padding: 0.1em 0.5em;
                   vertical-align: middle; margin-left: 0.4em; }
  .moved-note { font-size: 0.78em; color: #718096; font-style: italic; display: block;
                margin-top: 0.15em; }
  .toolbar { display: flex; align-items: center; justify-content: space-between;
             margin-top: 1em; flex-wrap: wrap; gap: 0.5em; }
  .toolbar .game-count { font-size: 0.85em; color: #718096; margin: 0; }
  .btn-csv { display: inline-flex; align-items: center; gap: 0.4em;
             background: #ce153f; color: white; border: none; border-radius: 6px;
             padding: 0.45em 1em; font-size: 0.85em; font-weight: 600;
             cursor: pointer; text-decoration: none; }
  .btn-csv:hover { background: #a01030; }
  .btn-back { font-size: 0.82em; color: #3182ce; text-decoration: none; }
  .btn-back:hover { text-decoration: underline; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch;
                  border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.12); margin-top: 1.5em; }
  .table-scroll table { border-radius: 0; box-shadow: none; margin-top: 0; min-width: 520px; }
  @media (max-width: 700px) {
    .page-body { padding: 1em; }
    h1.page-title { font-size: 1.35em; }
    td { padding: 0.5em 0.75em; font-size: 0.85em; }
    th { padding: 0.5em 0.75em; font-size: 0.78em; }
  }
`;

// Shared client-side CSV download script
const CSV_SCRIPT = `
<script>
function downloadCSV(dataId, filename) {
  const rows = JSON.parse(document.getElementById(dataId).textContent);
  const csv = rows.map(row =>
    row.map(cell => {
      const s = String(cell == null ? '' : cell);
      return (s.includes(',') || s.includes('"') || s.includes('\\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',')
  ).join('\\r\\n');
  const blob = new Blob(['\\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
<\/script>`;

// ---------------------------------------------------------------------------
// Build per-team and per-location warning maps from parse issues.
// Returns { teamWarnings, locationWarnings } where each value is an array
// of human-readable warning strings for that page.
// ---------------------------------------------------------------------------
function buildWarningMaps(parseResult, allGames, teams) {
  const teamWarnings     = {}; // teamNum  → string[]
  const locationWarnings = {}; // location → string[]

  const addTeam = (num, msg) => {
    if (!teamWarnings[num]) teamWarnings[num] = [];
    if (!teamWarnings[num].includes(msg)) teamWarnings[num].push(msg);
  };
  const addLoc = (loc, msg) => {
    if (!locationWarnings[loc]) locationWarnings[loc] = [];
    if (!locationWarnings[loc].includes(msg)) locationWarnings[loc].push(msg);
  };

  // ── Partially parsed cells ───────────────────────────────────────────────
  // A game code couldn't be read — the teams we DID extract from that slot
  // and the location all get warned that a game may be missing.
  for (const c of parseResult.partialCells) {
    const locMsg = `Week ${c.week}, ${c.date}: the cell "${c.rawCell}" was only partially read — a game may be missing from this field's schedule. (Unmatched fragment: ${c.broken.join(', ')})`;
    addLoc(c.location, locMsg);

    const slotGames = allGames.filter(g =>
      g.week === c.week && g.date === c.date && g.location === c.location
    );
    for (const g of slotGames) {
      const teamMsg = `Week ${c.week}, ${c.date} at ${c.location}: a game code in the source file could not be read — your schedule for this date may be missing a game. (Raw cell: "${c.rawCell}")`;
      addTeam(g.team1, teamMsg);
      addTeam(g.team2, teamMsg);
    }
  }

  // ── Single pass over allGames: unknown team codes + time conflicts ────────
  const slotMap = {};
  for (const g of allGames) {
    // Unknown team codes
    const t1Known = !!teams[g.team1];
    const t2Known = !!teams[g.team2];
    if (!t1Known || !t2Known) {
      const badCodes   = [!t1Known && g.team1, !t2Known && g.team2].filter(Boolean);
      const knownCodes = [t1Known  && g.team1, t2Known  && g.team2].filter(Boolean);
      addLoc(g.location, `Week ${g.week}, ${g.date}: game references unknown team code ${badCodes.join(', ')} — that team's details cannot be shown.`);
      for (const num of knownCodes) {
        addTeam(num, `Week ${g.week}, ${g.date} at ${g.location}: your opponent's team code (${badCodes.join(', ')}) was not found in the team list — their details cannot be shown.`);
      }
    }

    // Time conflicts
    if (g.time) {
      const key = `${g.location}||${g.date}||${g.time}`;
      if (slotMap[key]) {
        const other = slotMap[key];
        addLoc(g.location, `Week ${g.week}, ${g.date} at ${g.time}: two games are scheduled at the same time at this field (${g.team1} vs ${g.team2}  and  ${other.team1} vs ${other.team2}).`);
        for (const num of [g.team1, g.team2, other.team1, other.team2]) {
          if (teams[num]) addTeam(num, `Week ${g.week}, ${g.date} at ${g.location} ${g.time}: a scheduling conflict exists — two games are assigned to this field/time slot.`);
        }
      } else {
        slotMap[key] = g;
      }
    }
  }

  // ── Unrecognized / skipped cells — warn the location page only ───────────
  for (const c of parseResult.skippedCells) {
    addLoc(c.location, `Week ${c.week}, ${c.date}: cell "${c.rawCell}" could not be parsed — a game may be missing from this field's schedule.`);
  }

  return { teamWarnings, locationWarnings };
}

// ---------------------------------------------------------------------------
// Render a warning banner for pages with import issues.
// warnings = string[] from buildWarningMaps
// verifyPath = relative path to verification.html from this page
// ---------------------------------------------------------------------------
function importWarnBanner(warnings, verifyPath) {
  if (!warnings || warnings.length === 0) return '';
  const items = warnings.map(w => `<li>${w}</li>`).join('');
  return `<div class="import-warn">
    <strong>&#9888; Schedule data warning</strong>
    <ul>${items}</ul>
    <a href="${verifyPath}">View full verification report</a> for details.
  </div>`;
}

// ---------------------------------------------------------------------------
// Generate HTML for a single team's schedule
// ---------------------------------------------------------------------------
function generateTeamHTML(team, allGames, teams, teamWarnings) {
  const myGames = sortGames(allGames.filter(g => g.team1 === team.num || g.team2 === team.num));

  const color = divisionColor(team.division);

  const rows = myGames.map(g => {
    // Visiting team is listed first (team1), home team is listed second (team2)
    const isHome = g.team2 === team.num;
    const oppNum = isHome ? g.team1 : g.team2;
    const opp = teams[oppNum];
    const oppName = opp ? opp.name : `Team ${oppNum}`;
    const oppManager = opp ? opp.manager : '—';
    const oppPhone = opp ? opp.phone : '';
    const oppEmail = opp ? opp.email : '';
    const timeStr = resolveTime(g);

    return `
      <tr${g.changed ? ' style="background:#fffff0"' : ''}>
        <td><strong>${g.date}</strong>${g.changed ? '<span class="changed-badge">Changed</span>' : ''}<br><span class="week-label">Week ${g.week} &middot; ${formatDateWithDay(g.date)}</span></td>
        <td>${timeStr}</td>
        <td><span class="pill ${isHome ? 'home-pill' : 'away-pill'}">${isHome ? 'Home' : 'Away'}</span></td>
        <td class="contact">
          <strong>${opp ? `<a href="${oppNum}_${opp.name.replace(/[^a-zA-Z0-9]/g, '_')}.html">${oppName}</a>` : oppName}</strong>
          <small>${oppManager}${oppPhone ? ' &middot; ' + phoneLink(oppPhone) : ''}</small>
          <small>${oppEmail ? '<a href="mailto:' + oppEmail + '">' + oppEmail + '</a>' : ''}</small>
        </td>
        <td><a href="../locations/${g.location.replace(/[^a-zA-Z0-9]/g, '_')}.html">${g.location}</a></td>
      </tr>`;
  }).join('');

  // Build JSON rows for CSV export: header + one row per game
  const csvData = [
    ['Date', 'Week', 'Time', 'Home/Away', 'Opponent', 'Opp Manager', 'Opp Phone', 'Opp Email', 'Location'],
    ...myGames.map(g => {
      const isHome = g.team2 === team.num;
      const oppNum = isHome ? g.team1 : g.team2;
      const opp = teams[oppNum];
      return [
        g.date, `Week ${g.week}`, resolveTime(g), isHome ? 'Home' : 'Away',
        opp ? opp.name : oppNum,
        opp ? opp.manager : '', opp ? opp.phone : '', opp ? opp.email : '',
        g.location,
      ];
    }),
  ];
  const csvFilename = `${team.num}_${team.name.replace(/[^a-zA-Z0-9]/g, '_')}_schedule.csv`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${team.name} — 2026 Schedule</title>
  <style>
    ${BASE_CSS}
    .division-tag { display: inline-block; background: ${color.bg}22; color: ${color.bg};
                    border: 1px solid ${color.bg}55; border-radius: 9999px;
                    font-size: 0.78em; font-weight: 600; padding: 0.15em 0.65em;
                    margin-bottom: 0.75em; }
    .coach-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                  gap: 1em; background: ${color.light};
                  border-radius: 8px; padding: 1em 1.5em; margin-top: 0.5em; }
    .coach-grid .field label { display: block; font-size: 0.75em; color: #718096;
                               text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.1em; }
    .coach-grid .field span { font-weight: 600; color: #2d3748; }
    .coach-grid .field a { color: #3182ce; text-decoration: none; }
  </style>
</head>
<body>
  ${navBar('../', 'teams')}
  <div class="page-body">
    ${SCHEDULE_INFO_BANNER}
    ${importWarnBanner(teamWarnings[team.num], '../verification.html')}
    <h1 class="page-title">${team.name}</h1>
    <span class="division-tag">${team.division}</span>

    <div class="coach-grid">
      <div class="field">
        <label>Manager</label>
        <span>${team.manager || '—'}</span>
      </div>
      <div class="field">
        <label>Phone</label>
        <span>${phoneLink(team.phone)}</span>
      </div>
      <div class="field">
        <label>Email</label>
        <span>${team.email ? `<a href="mailto:${team.email}">${team.email}</a>` : '—'}</span>
      </div>
      <div class="field">
        <label>Team #</label>
        <span>${team.num}</span>
      </div>
    </div>

    <div class="toolbar">
      <span class="game-count">${myGames.length} game${myGames.length !== 1 ? 's' : ''} scheduled</span>
      <button class="btn-csv" onclick="downloadCSV('csv-data','${csvFilename}')">&#8595; Download Schedule</button>
    </div>

    <script id="csv-data" type="application/json">${JSON.stringify(csvData)}<\/script>

    <div class="table-scroll">
    <table>
      <thead style="background: ${color.bg}">
        <tr>
          <th>Date</th>
          <th>Time</th>
          <th>H / A</th>
          <th>Opponent &amp; Contact</th>
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="5" class="no-games">No games found in schedule</td></tr>'}
      </tbody>
    </table>
    </div>
  </div>

  ${CSV_SCRIPT}
  ${FOOTER_HTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generate HTML for a single location's schedule
// ---------------------------------------------------------------------------
function generateLocationHTML(location, allGames, teams, locationWarnings) {
  const locGames = sortGames(allGames.filter(g => g.location === location));

  const rows = locGames.map(g => {
    const t1 = teams[g.team1];
    const t2 = teams[g.team2];
    const n1 = t1 ? `<a href="../teams/${t1.num}_${t1.name.replace(/[^a-zA-Z0-9]/g, '_')}.html">${t1.name}</a>` : `Team ${g.team1}`;
    const n2 = t2 ? `<a href="../teams/${t2.num}_${t2.name.replace(/[^a-zA-Z0-9]/g, '_')}.html">${t2.name}</a>` : `Team ${g.team2}`;
    const div = t1 ? t1.division : '';
    const color = divisionColor(div);

    const timeStr = resolveTime(g);

    return `
      <tr${g.changed ? ' style="background:#fffff0"' : ''}>
        <td><strong>${g.date}</strong>${g.changed ? '<span class="changed-badge">Changed</span>' : ''}<br><span class="week-label">Week ${g.week} &middot; ${formatDateWithDay(g.date)}</span></td>
        <td>${timeStr}</td>
        <td><span class="pill" style="background:${color.bg}22; color:${color.bg}; border: 1px solid ${color.bg}44">${div || '—'}</span></td>
        <td class="contact">
          <strong>${n1}</strong>
          ${t1 ? `<small>${t1.manager}${t1.phone ? ' &middot; ' + phoneLink(t1.phone) : ''}</small>` : ''}
          <small style="color:#a0aec0; font-size:0.8em">Visiting</small>
        </td>
        <td style="color:#718096; font-size:0.9em">vs</td>
        <td class="contact">
          <strong>${n2}</strong>
          ${t2 ? `<small>${t2.manager}${t2.phone ? ' &middot; ' + phoneLink(t2.phone) : ''}</small>` : ''}
          <small style="color:#276749; font-size:0.8em">Home</small>
        </td>
      </tr>`;
  }).join('');

  // Build JSON rows for CSV export
  const csvData = [
    ['Date', 'Week', 'Time', 'Division', 'Visiting Team', 'Visiting Manager', 'Visiting Phone', 'Home Team', 'Home Manager', 'Home Phone'],
    ...locGames.map(g => {
      const t1 = teams[g.team1], t2 = teams[g.team2];
      return [
        g.date, `Week ${g.week}`, resolveTime(g),
        t1 ? t1.division : '',
        t1 ? t1.name : g.team1, t1 ? t1.manager : '', t1 ? t1.phone : '',
        t2 ? t2.name : g.team2, t2 ? t2.manager : '', t2 ? t2.phone : '',
      ];
    }),
  ];
  const csvFilename = location.replace(/[^a-zA-Z0-9]/g, '_') + '_schedule.csv';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${location} — 2026 Schedule</title>
  <style>
    ${BASE_CSS}
  </style>
</head>
<body>
  ${navBar('../', 'locations')}
  <div class="page-body">
    ${SCHEDULE_INFO_BANNER}
    ${importWarnBanner(locationWarnings[location], '../verification.html')}
    <h1 class="page-title">${location}</h1>
    <p class="page-subtitle">2026 D7 Inter-League Schedule</p>

    <div class="toolbar">
      <span class="game-count">${locGames.length} game${locGames.length !== 1 ? 's' : ''} scheduled</span>
      <button class="btn-csv" onclick="downloadCSV('csv-data','${csvFilename}')">&#8595; Download Schedule</button>
    </div>

    <script id="csv-data" type="application/json">${JSON.stringify(csvData)}<\/script>

    <div class="table-scroll">
    <table>
      <thead style="background: #276749">
        <tr>
          <th>Date</th>
          <th>Time</th>
          <th>Division</th>
          <th>Visiting Team</th>
          <th></th>
          <th>Home Team</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="6" class="no-games">No games scheduled at this location</td></tr>'}
      </tbody>
    </table>
    </div>
  </div>

  ${CSV_SCRIPT}
  ${FOOTER_HTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Leagues directory page — all teams grouped by league with per-league CSV download
// ---------------------------------------------------------------------------
function generateLeaguesHTML(teams, allGames) {
  // Group by league
  const byLeague = {};
  for (const t of Object.values(teams)) {
    const league = extractLeague(t.name);
    if (!byLeague[league]) byLeague[league] = [];
    byLeague[league].push(t);
  }

  // Sort each league's teams by division order then team number
  for (const league of Object.keys(byLeague)) {
    byLeague[league].sort((a, b) => {
      const di = DIVISION_ORDER.indexOf(a.division) - DIVISION_ORDER.indexOf(b.division);
      if (di !== 0) return di;
      return a.num.localeCompare(b.num, undefined, { numeric: true });
    });
  }

  const leagueNames = Object.keys(byLeague).sort();

  const leagueSections = leagueNames.map(league => {
    const id = `league-${league.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const csvId = `csv-${id}`;
    const csvFilename = `${league.replace(/[^a-zA-Z0-9]/g, '_')}_teams.csv`;

    const leagueNums = new Set(byLeague[league].map(t => t.num));
    const scheduleRows = [];
    for (const g of allGames) {
      const isSat = new Date(`${g.date} 2026`).getDay() === 6;
      const timeStr = g.time ? formatTime(g.time) : (isSat ? 'TBD' : '6:00 PM');
      for (const [ourNum, oppNum, homeAway] of [[g.team1, g.team2, 'Away'], [g.team2, g.team1, 'Home']]) {
        if (!leagueNums.has(ourNum)) continue;
        const our = teams[ourNum];
        const opp = teams[oppNum];
        scheduleRows.push([
          g.date, `Week ${g.week}`, timeStr,
          our ? our.name : ourNum, our ? our.division : '',
          homeAway,
          opp ? opp.name : oppNum,
          opp ? opp.manager : '', opp ? opp.phone : '', opp ? opp.email : '',
          g.location,
        ]);
      }
    }
    scheduleRows.sort((a, b) => parseDate(a[0]) - parseDate(b[0]) || a[2].localeCompare(b[2]));
    const csvData = [
      ['Date', 'Week', 'Time', 'Team', 'Division', 'Home/Away', 'Opponent', 'Opp Manager', 'Opp Phone', 'Opp Email', 'Location'],
      ...scheduleRows,
    ];

    const rows = byLeague[league].map(t => {
      const phone = phoneLink(t.phone, '<span style="color:#a0aec0">—</span>');
      const email = t.email
        ? `<a href="mailto:${t.email}">${t.email}</a>`
        : '<span style="color:#a0aec0">—</span>';
      const teamHref = `teams/${t.num}_${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
      return `<tr class="team-row" onclick="location.href='${teamHref}'" title="View ${t.name} schedule">
        <td><a href="${teamHref}" onclick="event.stopPropagation()">${t.name}</a></td>
        <td><span style="font-size:0.8em;color:#718096">${t.division}</span></td>
        <td>${t.manager || '<span style="color:#a0aec0">—</span>'}</td>
        <td>${phone}</td>
        <td>${email}</td>
      </tr>`;
    }).join('');

    return `
    <div class="league-block" id="${id}">
      <div class="league-header">
        <h2 class="league-name">${league}</h2>
        <button class="btn-csv" onclick="downloadCSV('${csvId}','${csvFilename}')">&#8595; Download Schedule</button>
      </div>
      <script id="${csvId}" type="application/json">${JSON.stringify(csvData)}<\/script>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Team</th><th>Division</th><th>Manager</th><th>Phone</th><th>Email</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('\n');

  const jumpLinks = leagueNames.map(l =>
    `<a href="#league-${l.replace(/[^a-zA-Z0-9]/g, '-')}">${l}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>League Directory — 2026 D7</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
           margin: 0; background: #f0f4f8; color: #2d3748; }
    ${NAV_CSS}
    ${PAGE_HEADER_CSS}
    .page-body { padding: 1.5em 2em 4em; max-width: 1100px; }
    .jump-nav { display: flex; flex-wrap: wrap; gap: 0.5em; margin-bottom: 2em; }
    .jump-nav a { background: white; color: #3182ce; text-decoration: none; font-size: 0.82em;
                  font-weight: 500; padding: 0.3em 0.75em; border-radius: 9999px;
                  border: 1px solid #bee3f8; }
    .jump-nav a:hover { background: #ebf8ff; }
    .league-block { margin-bottom: 2.5em; scroll-margin-top: 70px; }
    .league-header { display: flex; align-items: center; justify-content: space-between;
                     margin-bottom: 0.6em; }
    .league-name { font-size: 1.15em; font-weight: 700; color: #1a202c; margin: 0; }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch;
                    border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    table { width: 100%; border-collapse: collapse; background: white;
            border-radius: 0; overflow: hidden; box-shadow: none; min-width: 520px; }
    th { background: #2d3748; color: white; padding: 0.55em 1em;
         text-align: left; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.04em; }
    td { padding: 0.55em 1em; border-bottom: 1px solid #edf2f7; font-size: 0.88em; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f7faff; }
    tbody tr.team-row { cursor: pointer; }
    a { color: #3182ce; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .btn-csv { display: inline-flex; align-items: center; gap: 0.4em;
               background: #ce153f; color: white; border: none; border-radius: 6px;
               padding: 0.35em 0.85em; font-size: 0.8em; font-weight: 600; cursor: pointer; }
    .btn-csv:hover { background: #a01030; }
    @media (max-width: 700px) {
      .page-body { padding: 1em; }
      h1.page-title { font-size: 1.35em; }
    }
    ${FOOTER_CSS}
  </style>
</head>
<body>
  ${navBar('', 'leagues')}
  <div class="page-body">
    ${SCHEDULE_INFO_BANNER}
    <h1 class="page-title">League Directory — 2026 D7 Inter-League</h1>
    <p class="page-subtitle">${Object.keys(teams).length} teams across ${leagueNames.length} leagues</p>
    <div class="jump-nav">${jumpLinks}</div>
    ${leagueSections}
  </div>
  ${CSV_SCRIPT}
  ${FOOTER_HTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Index page linking to all generated files
// ---------------------------------------------------------------------------
function generateIndex(teams, locations, allGames) {
  const byDivision = {};
  for (const t of Object.values(teams)) {
    if (!byDivision[t.division]) byDivision[t.division] = [];
    byDivision[t.division].push(t);
  }
  for (const div of Object.keys(byDivision)) {
    byDivision[div].sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
  }

  // Slugify a division name for use as a data attribute value
  const divSlug = div => div.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const teamSections = DIVISION_ORDER.map(div => {
    if (!byDivision[div]) return '';
    const color  = divisionColor(div);
    const sport  = DIVISION_SPORT[div] || 'baseball';
    const slug   = divSlug(div);
    const links  = byDivision[div].map(t => {
      const file = `teams/${t.num}_${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
      return `<li><a href="${file}">${t.name}</a> <span style="color:#a0aec0; font-size:0.85em">${t.manager}</span></li>`;
    }).join('\n');
    return `
      <section data-sport="${sport}" data-div="${slug}">
        <h2 style="color:${color.bg}; border-bottom: 2px solid ${color.bg}; padding-bottom:0.3em">${div}</h2>
        <ul>${links}</ul>
      </section>`;
  }).join('\n');

  // Build the division pill data for the JS filter (baseball and softball separately)
  const baseballDivs = DIVISION_ORDER.filter(d => DIVISION_SPORT[d] === 'baseball' && byDivision[d]);
  const softballDivs = DIVISION_ORDER.filter(d => DIVISION_SPORT[d] === 'softball' && byDivision[d]);

  const totalGames = allGames.length;
  const totalTeams = Object.keys(teams).length;
  const totalLocations = locations.length;
  const weekNums = [...new Set(allGames.map(g => g.week))].sort((a, b) => a - b);
  const totalWeeks = weekNums.length;
  const dates = allGames.map(g => parseDate(g.date)).sort((a, b) => a - b);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const seasonRange = dates.length ? `${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}, 2026` : '2026';

  // Determine which sports are played at each location
  const locSports = {};
  for (const g of allGames) {
    const t1 = teams[g.team1];
    const sport = t1 ? DIVISION_SPORT[t1.division] : null;
    if (!sport) continue;
    if (!locSports[g.location]) locSports[g.location] = new Set();
    locSports[g.location].add(sport);
  }

  const locationLinks = locations.sort().map(loc => {
    const file = `locations/${loc.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
    const sports = locSports[loc] || new Set();
    const hasBoth = sports.has('baseball') && sports.has('softball');
    const sportAttr = hasBoth ? 'both' : (sports.has('softball') ? 'softball' : 'baseball');
    return `<li data-loc-sport="${sportAttr}"><a href="${file}">${loc}</a></li>`;
  }).join('\n');

  // Serialise division metadata for client-side filter JS
  const divMeta = JSON.stringify({
    baseball: baseballDivs.map(d => ({ label: d, slug: divSlug(d) })),
    softball: softballDivs.map(d => ({ label: d, slug: divSlug(d) })),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>2026 D7 Inter-League Schedule</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
           margin: 0; background: #f0f4f8; color: #2d3748; }
    ${NAV_CSS}
    ${PAGE_HEADER_CSS}
    ${FOOTER_CSS}
    .page-body { padding: 1.5em 2em; max-width: 1200px; }
    .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 2em; }
    section { margin-bottom: 2em; }
    h2 { font-size: 1.1em; margin-bottom: 0.5em; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 0.3em 0; border-bottom: 1px solid #e2e8f0; }
    li:last-child { border-bottom: none; }
    a { color: #3182ce; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    .panel { background: white; border-radius: 10px; padding: 1.5em;
             box-shadow: 0 2px 6px rgba(0,0,0,0.08); scroll-margin-top: 60px; }
    .panel-title { font-size: 1.2em; font-weight: 700; margin-bottom: 1em;
                   padding-bottom: 0.5em; border-bottom: 2px solid #e2e8f0; color: #2d3748; }
    /* ── Filter controls ─────────────────────────────────────────── */
    .filter-bar { margin-bottom: 1.25em; display: flex; flex-direction: column; gap: 0.6em; }
    .filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4em; }
    .filter-label { font-size: 0.75em; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.06em; color: #718096; min-width: 4.5em; }
    .filter-btn {
      padding: 0.3em 0.85em; border-radius: 9999px; border: 1.5px solid #cbd5e0;
      background: white; color: #4a5568; font-size: 0.8em; font-weight: 500;
      cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .filter-btn:hover { background: #edf2f7; }
    .filter-btn.active-baseball {
      background: #2b6cb0; border-color: #2b6cb0; color: white;
    }
    .filter-btn.active-softball {
      background: #c05621; border-color: #c05621; color: white;
    }
    .filter-btn.active-all {
      background: #2d3748; border-color: #2d3748; color: white;
    }
    .filter-btn.active-div {
      background: #2d3748; border-color: #2d3748; color: white;
    }
    #div-filter-row { display: none; }
    @media (max-width: 700px) {
      .page-body { padding: 1em; }
      .grid { grid-template-columns: 1fr; }
      h1.page-title { font-size: 1.35em; }
    }
  </style>
</head>
<body>
  ${navBar('', 'home')}
  <div class="page-body">
    ${SCHEDULE_INFO_BANNER}
    <h1 class="page-title">2026 D7 Inter-League Schedule</h1>
    <p class="page-subtitle">Season runs ${seasonRange} &nbsp;&middot;&nbsp; ${totalWeeks} weeks &nbsp;&middot;&nbsp; ${totalGames} games &nbsp;&middot;&nbsp; ${totalTeams} teams &nbsp;&middot;&nbsp; ${totalLocations} locations</p>

    <div class="grid">
      <div class="panel" id="teams">
        <div class="panel-title">Teams by Division</div>

        <div class="filter-bar">
          <div class="filter-row">
            <span class="filter-label">Sport</span>
            <button class="filter-btn active-all" id="btn-all"       onclick="setSport('all')">All</button>
            <button class="filter-btn"             id="btn-baseball"  onclick="setSport('baseball')">Baseball</button>
            <button class="filter-btn"             id="btn-softball"  onclick="setSport('softball')">Softball</button>
          </div>
          <div class="filter-row" id="div-filter-row">
            <span class="filter-label">Division</span>
            <button class="filter-btn active-div" id="btn-div-all" onclick="setDiv('all')">All</button>
          </div>
        </div>

        ${teamSections}
      </div>
      <div class="panel" id="locations">
        <div class="panel-title">By Location</div>
        <div class="filter-bar" style="margin-bottom:0.9em">
          <div class="filter-row">
            <span class="filter-label">Sport</span>
            <button class="filter-btn active-all" id="loc-btn-all"      onclick="setLocSport('all')">All</button>
            <button class="filter-btn"            id="loc-btn-baseball" onclick="setLocSport('baseball')">Baseball</button>
            <button class="filter-btn"            id="loc-btn-softball" onclick="setLocSport('softball')">Softball</button>
          </div>
        </div>
        <ul id="location-list">${locationLinks}</ul>
      </div>
    </div>
  </div>
  ${FOOTER_HTML}
  <script>
  (function() {
    var META = ${divMeta};
    var sport = 'all', div = 'all';

    function setSport(s) {
      sport = s; div = 'all';
      // Update sport buttons
      ['all','baseball','softball'].forEach(function(id) {
        var btn = document.getElementById('btn-' + id);
        btn.className = 'filter-btn' + (s === id ? ' active-' + id : '');
      });
      // Rebuild division pills
      var row = document.getElementById('div-filter-row');
      if (s === 'all') {
        row.style.display = 'none';
      } else {
        row.style.display = 'flex';
        // Remove old dynamic pills (keep "All" button which is always first)
        var allBtn = document.getElementById('btn-div-all');
        allBtn.className = 'filter-btn active-div';
        while (row.children.length > 2) row.removeChild(row.lastChild); // keep label + allBtn
        META[s].forEach(function(d) {
          var btn = document.createElement('button');
          btn.className = 'filter-btn';
          btn.textContent = d.label;
          btn.setAttribute('data-div-slug', d.slug);
          btn.onclick = function() { setDiv(d.slug); };
          row.appendChild(btn);
        });
      }
      applyFilter();
    }

    function setDiv(d) {
      div = d;
      // Update div buttons
      var row = document.getElementById('div-filter-row');
      Array.from(row.querySelectorAll('.filter-btn')).forEach(function(btn) {
        var slug = btn.getAttribute('data-div-slug') || 'all';
        btn.className = 'filter-btn' + (slug === d ? ' active-div' : '');
      });
      applyFilter();
    }

    function applyFilter() {
      document.querySelectorAll('#teams section').forEach(function(sec) {
        var secSport = sec.getAttribute('data-sport');
        var secDiv   = sec.getAttribute('data-div');
        var sportOk  = sport === 'all' || secSport === sport;
        var divOk    = div   === 'all' || secDiv   === div;
        sec.style.display = (sportOk && divOk) ? '' : 'none';
      });
    }

    function setLocSport(s) {
      ['all','baseball','softball'].forEach(function(id) {
        var btn = document.getElementById('loc-btn-' + id);
        btn.className = 'filter-btn' + (s === id ? ' active-' + id : '');
      });
      document.querySelectorAll('#location-list li').forEach(function(li) {
        var sp = li.getAttribute('data-loc-sport'); // 'baseball' | 'softball' | 'both'
        var show = s === 'all' || sp === s || sp === 'both';
        li.style.display = show ? '' : 'none';
      });
    }

    window.setSport    = setSport;
    window.setDiv      = setDiv;
    window.setLocSport = setLocSport;
  })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Write parse-report.txt — human-readable summary of every parse decision.
// Read this first after every XLSX update before publishing.
// ---------------------------------------------------------------------------
function writeParseReport(baseDir, teams, parseResult) {
  const { games, removedCells, movedFromCells, eastLaneCells,
          skippedCells, partialCells, normalizedCells,
          unknownLocations, weeksFound } = parseResult;

  const changedGames  = games.filter(g => g.changed);
  const unknownTeams  = games.filter(g => !teams[g.team1] || !teams[g.team2]);

  // Game counts per team
  const counts = {};
  for (const num of Object.keys(teams)) counts[num] = 0;
  for (const g of games) {
    if (counts[g.team1] !== undefined) counts[g.team1]++;
    if (counts[g.team2] !== undefined) counts[g.team2]++;
  }

  const lines = [];
  const hr = '='.repeat(60);
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

  lines.push(hr);
  lines.push('D7 SCHEDULE — PARSE REPORT');
  lines.push(`Generated : ${now}`);
  lines.push(`Source    : 2026 Season Interleague schedule UPDATED 4.12.2026.xlsx`);
  lines.push(hr);
  lines.push('');

  // ── Summary ─────────────────────────────────────────────────────────────
  lines.push('SUMMARY');
  lines.push(`  Weeks parsed        : ${weeksFound.length} (Weeks ${weeksFound.join(', ')})`);
  lines.push(`  Teams loaded (Key)  : ${Object.keys(teams).length}`);
  lines.push(`  Active games        : ${games.length}`);
  lines.push(`  Changed (yellow)    : ${changedGames.length}`);
  lines.push(`  Games removed       : ${removedCells.length}`);
  lines.push(`  Games moved away    : ${movedFromCells.length}`);
  lines.push(`  East Lane notes     : ${eastLaneCells.length}`);
  lines.push('');

  // ── Warnings (must review) ───────────────────────────────────────────────
  const warnCount = skippedCells.length + partialCells.length + unknownTeams.length + unknownLocations.length;
  lines.push(`WARNINGS — ${warnCount === 0 ? 'none (safe to publish)' : `${warnCount} item(s) REQUIRE REVIEW before publishing`}`);

  if (skippedCells.length > 0) {
    lines.push('');
    lines.push(`  [WARN] ${skippedCells.length} cell(s) had content that could not be parsed or classified:`);
    for (const c of skippedCells) {
      lines.push(`    Week ${c.week}, ${c.date}, ${c.location}: "${c.rawCell}"`);
    }
  }

  if (partialCells.length > 0) {
    lines.push('');
    lines.push(`  [WARN] ${partialCells.length} cell(s) had a game parsed but also a broken/unmatched code:`);
    for (const c of partialCells) {
      lines.push(`    Week ${c.week}, ${c.date}, ${c.location}: "${c.rawCell}"  →  unmatched: ${c.broken.join(', ')}`);
    }
  }

  if (unknownTeams.length > 0) {
    lines.push('');
    lines.push(`  [WARN] ${unknownTeams.length} game(s) reference a team code not in the Key CSV:`);
    for (const g of unknownTeams) {
      const bad = [!teams[g.team1] && g.team1, !teams[g.team2] && g.team2].filter(Boolean);
      lines.push(`    Week ${g.week}, ${g.date}, ${g.location}: unknown code(s) ${bad.join(', ')}`);
    }
  }

  if (unknownLocations.length > 0) {
    lines.push('');
    lines.push(`  [WARN] ${unknownLocations.length} location name(s) in schedule not found in "field info" sheet:`);
    for (const u of unknownLocations) {
      lines.push(`    "${u.location}" (first seen Week ${u.week})`);
    }
  }

  if (warnCount === 0) lines.push('  (none)');
  lines.push('');

  // ── Auto-fixes applied ───────────────────────────────────────────────────
  if (normalizedCells.length > 0) {
    lines.push(`INFO — ${normalizedCells.length} cell(s) had minor formatting auto-corrected:`);
    for (const c of normalizedCells) {
      const fixDesc = c.fixes.map(f => `${f.raw} → ${f.fixed}`).join(', ');
      lines.push(`  Week ${c.week}, ${c.date}, ${c.location}: ${fixDesc}`);
    }
    lines.push('');
  }

  // ── Removed games ────────────────────────────────────────────────────────
  if (removedCells.length > 0) {
    lines.push(`REMOVED GAMES (${removedCells.length}) — not included in any schedule:`);
    for (const c of removedCells) {
      lines.push(`  Week ${c.week}, ${c.date}, ${c.location}${c.changed ? '  [highlighted]' : ''}`);
    }
    lines.push('');
  }

  // ── Moved-from games ─────────────────────────────────────────────────────
  if (movedFromCells.length > 0) {
    lines.push(`MOVED GAMES (${movedFromCells.length}) — source slot annotated "MOVED TO"; game appears at destination:`);
    for (const c of movedFromCells) {
      lines.push(`  Week ${c.week}, ${c.date}, ${c.location}: ${c.team1} vs ${c.team2}  →  ${c.movedNote}${c.changed ? '  [highlighted]' : ''}`);
    }
    lines.push('');
  }

  // ── Game counts per team ─────────────────────────────────────────────────
  lines.push('GAME COUNTS PER TEAM');
  const byDiv = {};
  for (const [num, t] of Object.entries(teams)) {
    if (!byDiv[t.division]) byDiv[t.division] = [];
    byDiv[t.division].push({ num, name: t.name, count: counts[num] || 0 });
  }
  for (const div of DIVISION_ORDER) {
    if (!byDiv[div]) continue;
    const members = byDiv[div].sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
    const total = members.reduce((s, m) => s + m.count, 0);
    const avg   = (total / members.length).toFixed(1);
    const min   = Math.min(...members.map(m => m.count));
    const max   = Math.max(...members.map(m => m.count));
    lines.push(`  ${div} (${members.length} teams, avg ${avg}, range ${min}–${max})`);
    for (const m of members) {
      const flag = m.count === 0 ? ' *** ZERO GAMES ***' : (m.count <= 3 ? ' (low)' : '');
      lines.push(`    ${m.num.padEnd(4)} ${m.name.padEnd(35)} ${m.count} games${flag}`);
    }
  }
  lines.push('');
  lines.push(hr);

  const reportPath = path.join(baseDir, 'parse-report.txt');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const baseDir    = __dirname;
const outputDir  = path.join(baseDir, 'output');
const teamsDir   = path.join(outputDir, 'teams');
const locationsDir = path.join(outputDir, 'locations');

fs.mkdirSync(teamsDir,     { recursive: true });
fs.mkdirSync(locationsDir, { recursive: true });

// ── Load team info from Key CSV ─────────────────────────────────────────────
console.log('Parsing team key...');
const teams = parseKey(path.join(baseDir, '2026 D7 Original Schedule - Key.csv'));
console.log(`  Loaded ${Object.keys(teams).length} teams`);

// ── Parse the XLSX schedule ─────────────────────────────────────────────────
console.log('Parsing XLSX schedule...');
const xlsxFile   = path.join(baseDir, '2026 Season Interleague schedule UPDATED 4.12.2026.xlsx');
const parseResult = parseScheduleXLSX(xlsxFile);
const allGames   = parseResult.games;
console.log(`  Weeks found  : ${parseResult.weeksFound.join(', ')}`);
console.log(`  Active games : ${allGames.length}`);
console.log(`  Removed      : ${parseResult.removedCells.length}`);
console.log(`  Moved away   : ${parseResult.movedFromCells.length}`);
console.log(`  Changed cells: ${allGames.filter(g => g.changed).length}`);

if (parseResult.skippedCells.length > 0) {
  console.warn(`\n  ⚠  ${parseResult.skippedCells.length} unrecognized cell(s) — see parse-report.txt`);
}
if (parseResult.partialCells.length > 0) {
  console.warn(`  ⚠  ${parseResult.partialCells.length} partial cell(s) — see parse-report.txt`);
}
if (parseResult.unknownLocations.length > 0) {
  console.warn(`  ⚠  ${parseResult.unknownLocations.length} unknown location name(s) — see parse-report.txt`);
}

// ── Assign default times for Saturday double-headers ───────────────────────
// Timeless Saturday games at the same field: first → 12:30, second → 3:00
const satGroups = {};
for (const g of allGames) {
  if (g.time || parseDate(g.date).getDay() !== 6) continue;
  const key = `${g.date}|${g.location}`;
  if (!satGroups[key]) satGroups[key] = [];
  satGroups[key].push(g);
}
for (const group of Object.values(satGroups)) {
  if (group[0]) group[0].time = '12:30';
  if (group[1]) group[1].time = '3:00';
}

// ── Write parse report ──────────────────────────────────────────────────────
const reportPath = writeParseReport(baseDir, teams, parseResult);
console.log(`\nParse report : ${reportPath}`);
console.log('  READ THIS before publishing — check for WARNs\n');

// ── Build per-page warning maps ─────────────────────────────────────────────
const { teamWarnings, locationWarnings } = buildWarningMaps(parseResult, allGames, teams);
const warnedTeams = Object.keys(teamWarnings).length;
const warnedLocs  = Object.keys(locationWarnings).length;
if (warnedTeams > 0 || warnedLocs > 0) {
  console.log(`  Warnings injected into ${warnedTeams} team page(s) and ${warnedLocs} location page(s)`);
}


// ── Generate HTML ───────────────────────────────────────────────────────────
console.log('Generating team schedules...');
for (const team of Object.values(teams)) {
  const html = injectGate(generateTeamHTML(team, allGames, teams, teamWarnings), gateSnippet);
  const filename = `${team.num}_${team.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
  fs.writeFileSync(path.join(teamsDir, filename), html);
}
console.log(`  Generated ${Object.keys(teams).length} team files`);

console.log('Generating location schedules...');
const locations = [...new Set(allGames.map(g => g.location))];
for (const loc of locations) {
  const html = injectGate(generateLocationHTML(loc, allGames, teams, locationWarnings), gateSnippet);
  const filename = loc.replace(/[^a-zA-Z0-9]/g, '_') + '.html';
  fs.writeFileSync(path.join(locationsDir, filename), html);
}
console.log(`  Generated ${locations.length} location files`);

console.log('Generating index...');
const indexHtml = injectGate(generateIndex(teams, locations, allGames), gateSnippet);
fs.writeFileSync(path.join(outputDir, 'index.html'), indexHtml);

console.log('Generating leagues directory...');
const leaguesHtml = injectGate(generateLeaguesHTML(teams, allGames), gateSnippet);
fs.writeFileSync(path.join(outputDir, 'leagues.html'), leaguesHtml);

console.log('\nDone! Open output/index.html in a browser to browse all schedules.');
