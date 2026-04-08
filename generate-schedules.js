// D7 Schedule Generator
// Reads CSV files and outputs HTML schedule documents per team and per location.
// Usage: node generate-schedules.js

const fs = require('fs');
const path = require('path');
const { getPasswordHash, passwordGateSnippet, injectGate, navBar, NAV_CSS, PAGE_HEADER_CSS, FOOTER_HTML, FOOTER_CSS } = require('./config');
const gateSnippet = passwordGateSnippet(getPasswordHash());

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields containing commas and newlines
// ---------------------------------------------------------------------------
function parseCSV(content) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      current.push(cell.trim());
      cell = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip CR; \r\n will be handled when \n is encountered
    } else if (ch === '\n' && !inQuotes) {
      current.push(cell.trim());
      rows.push(current);
      current = [];
      cell = '';
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
function parseKey(content) {
  const rows = parseCSV(content);
  const teams = {};
  let currentDivision = '';

  const divisionHeaders = new Set([
    '3A Player Pitch Baseball',
    'Major Baseball',
    '50/70 Baseball',
    'JR Baseball',
    '2A Softball',
    '3A Softball',
    'Major Softball',
    'JR Softball',
  ]);

  for (const row of rows) {
    if (!row[0]) continue;
    const first = row[0];
    if (divisionHeaders.has(first)) {
      currentDivision = first;
    } else if (first === 'Team' || first.includes('Inter-League')) {
      continue;
    } else if (row[1] && /^[A-H]\d+$/.test(row[1])) {
      teams[row[1]] = {
        name: first,
        num: row[1],
        manager: row[2] || '',
        phone: row[3] || '',
        email: row[4] || '',
        division: currentDivision,
      };
    }
  }
  return teams;
}

// ---------------------------------------------------------------------------
// Parse individual game codes from a cell
// Returns array of { team1, team2, time }
// ---------------------------------------------------------------------------
function parseGames(cell) {
  if (!cell) return [];

  // Normalize: collapse whitespace/newlines, fix semicolon times, remove stray spaces in team codes
  let text = cell
    .replace(/[\r\n]+/g, ' ')
    .replace(/(\d+);(\d+)/g, '$1:$2')   // "9;00" → "9:00"
    .replace(/([A-H])\s+(\d)/g, '$1$2') // "A 1" → "A1"
    .replace(/--/g, '-')                  // double dash → single
    .trim();

  const games = [];

  // Match game tokens: Letter+digits dash (optional Letter) digits
  // e.g. A3-4, B12-F9 (second team letter present), F12-9
  const gameRe = /([A-H]\d+)-([A-H]?\d+)/g;
  let match;
  const found = [];
  while ((match = gameRe.exec(text)) !== null) {
    found.push({
      raw: match[0],
      team1raw: match[1],
      team2raw: match[2],
      end: match.index + match[0].length,
      nextStart: null, // filled below
    });
  }

  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    const nextStart = i + 1 < found.length ? found[i + 1].index : text.length;
    m.nextStart = nextStart;

    const prefix = m.team1raw[0]; // letter from first team
    const team1 = m.team1raw;
    // Second team: if it already has a letter prefix keep it, else add same letter
    const team2 = /^[A-H]/.test(m.team2raw) ? m.team2raw : prefix + m.team2raw;

    // Validate both teams look like real codes (1–2 digits)
    if (!/^\d{1,2}$/.test(team1.slice(1)) || !/^[A-H]\d{1,2}$/.test(team2)) {
      console.warn(`  Skipping unrecognized game code: "${m.raw}" in cell: "${cell.substring(0, 60)}"`);
      continue;
    }

    // Extract time from the text between this match end and next match start
    const between = text.substring(m.end, nextStart);
    const timeMatch = between.match(/(\d{1,2}:\d{2})/);
    const time = timeMatch ? timeMatch[1] : null;

    games.push({ team1, team2, time });
  }

  return games;
}

// ---------------------------------------------------------------------------
// Parse a Week CSV → array of game objects
// ---------------------------------------------------------------------------
function parseWeek(content, weekNum) {
  const rows = parseCSV(content);
  if (rows.length === 0) return [];

  // Row 0: WEEK N, date1, date2, date3, date4, date5, date6
  const header = rows[0];
  const dates = header.slice(1).map(d => d.replace(/(\d+)(st|nd|rd|th)/i, '$1').trim());

  const games = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row[0]) continue;
    const location = row[0];

    for (let c = 1; c <= 6; c++) {
      const cell = row[c];
      if (!cell) continue;
      const date = dates[c - 1];
      if (!date) continue;

      const cellGames = parseGames(cell);
      for (const g of cellGames) {
        games.push({ week: weekNum, date, location, team1: g.team1, team2: g.team2, time: g.time });
      }
    }
  }

  return games;
}

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

// ---------------------------------------------------------------------------
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
// Generate HTML for a single team's schedule
// ---------------------------------------------------------------------------
function generateTeamHTML(team, allGames, teams) {
  const myGames = allGames
    .filter(g => g.team1 === team.num || g.team2 === team.num)
    .sort((a, b) => {
      const d = parseDate(a.date) - parseDate(b.date);
      if (d !== 0) return d;
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });

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
    const isSaturday = new Date(`${g.date} 2026`).getDay() === 6;
    const defaultTime = isSaturday ? 'TBD' : '6:00 PM';
    const timeStr = g.time
      ? (() => {
          return formatTime(g.time);
        })()
      : defaultTime;

    return `
      <tr>
        <td><strong>${g.date}</strong><br><span class="week-label">Week ${g.week} &middot; ${formatDateWithDay(g.date)}</span></td>
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
      const isSat = new Date(`${g.date} 2026`).getDay() === 6;
      const t = g.time
        ? formatTime(g.time)
        : (isSat ? 'TBD' : '6:00 PM');
      return [
        g.date, `Week ${g.week}`, t, isHome ? 'Home' : 'Away',
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
    <div style="background:#fff8e1;border:1px solid #f6c90e;border-radius:8px;padding:0.75em 1em;margin-bottom:1.25em;font-size:0.85em;color:#7d5a00;line-height:1.5">
      <strong>Coaching Staff Only</strong> &mdash; Please do not share this website or its contents beyond your coaching staff. Parents and families should receive the schedule through your league&rsquo;s official communication channels.
    </div>
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
function generateLocationHTML(location, allGames, teams) {
  const locGames = allGames
    .filter(g => g.location === location)
    .sort((a, b) => {
      const d = parseDate(a.date) - parseDate(b.date);
      if (d !== 0) return d;
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });

  const rows = locGames.map(g => {
    const t1 = teams[g.team1];
    const t2 = teams[g.team2];
    const n1 = t1 ? `<a href="../teams/${t1.num}_${t1.name.replace(/[^a-zA-Z0-9]/g, '_')}.html">${t1.name}</a>` : `Team ${g.team1}`;
    const n2 = t2 ? `<a href="../teams/${t2.num}_${t2.name.replace(/[^a-zA-Z0-9]/g, '_')}.html">${t2.name}</a>` : `Team ${g.team2}`;
    const div = t1 ? t1.division : '';
    const color = divisionColor(div);

    // Visiting team is listed first (team1/n1), home team is listed second (team2/n2)
    const isSaturday = new Date(`${g.date} 2026`).getDay() === 6;
    const defaultTime = isSaturday ? 'TBD' : '6:00 PM';
    const timeStr = g.time
      ? (() => {
          return formatTime(g.time);
        })()
      : defaultTime;

    return `
      <tr>
        <td><strong>${g.date}</strong><br><span class="week-label">Week ${g.week} &middot; ${formatDateWithDay(g.date)}</span></td>
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
      const isSat = new Date(`${g.date} 2026`).getDay() === 6;
      const t = g.time
        ? formatTime(g.time)
        : (isSat ? 'TBD' : '6:00 PM');
      return [
        g.date, `Week ${g.week}`, t,
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
  const divisionOrder = [
    '3A Player Pitch Baseball', 'Major Baseball', '50/70 Baseball', 'JR Baseball',
    '2A Softball', '3A Softball', 'Major Softball', 'JR Softball',
  ];

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
      const di = divisionOrder.indexOf(a.division) - divisionOrder.indexOf(b.division);
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
  const divisionOrder = [
    '3A Player Pitch Baseball',
    'Major Baseball',
    '50/70 Baseball',
    'JR Baseball',
    '2A Softball',
    '3A Softball',
    'Major Softball',
    'JR Softball',
  ];

  const byDivision = {};
  for (const t of Object.values(teams)) {
    if (!byDivision[t.division]) byDivision[t.division] = [];
    byDivision[t.division].push(t);
  }
  for (const div of Object.keys(byDivision)) {
    byDivision[div].sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
  }

  const teamSections = divisionOrder.map(div => {
    if (!byDivision[div]) return '';
    const color = divisionColor(div);
    const links = byDivision[div].map(t => {
      const file = `teams/${t.num}_${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
      return `<li><a href="${file}">${t.name}</a> <span style="color:#a0aec0; font-size:0.85em">${t.manager}</span></li>`;
    }).join('\n');
    return `
      <section>
        <h2 style="color:${color.bg}; border-bottom: 2px solid ${color.bg}; padding-bottom:0.3em">${div}</h2>
        <ul>${links}</ul>
      </section>`;
  }).join('\n');

  const totalGames = allGames.length;
  const totalTeams = Object.keys(teams).length;
  const totalLocations = locations.length;
  const weekNums = [...new Set(allGames.map(g => g.week))].sort((a, b) => a - b);
  const totalWeeks = weekNums.length;
  const dates = allGames.map(g => parseDate(g.date)).sort((a, b) => a - b);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const seasonRange = dates.length ? `${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}, 2026` : '2026';

  const locationLinks = locations.sort().map(loc => {
    const file = `locations/${loc.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
    return `<li><a href="${file}">${loc}</a></li>`;
  }).join('\n');

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
    <h1 class="page-title">2026 D7 Inter-League Schedule</h1>
    <p class="page-subtitle">Season runs ${seasonRange} &nbsp;&middot;&nbsp; ${totalWeeks} weeks &nbsp;&middot;&nbsp; ${totalGames} games &nbsp;&middot;&nbsp; ${totalTeams} teams &nbsp;&middot;&nbsp; ${totalLocations} locations</p>

    <div class="grid">
      <div class="panel" id="teams">
        <div class="panel-title">Teams by Division</div>
        ${teamSections}
      </div>
      <div class="panel" id="locations">
        <div class="panel-title">By Location</div>
        <ul>${locationLinks}</ul>
      </div>
    </div>
  </div>
  ${FOOTER_HTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const baseDir = __dirname;
const outputDir = path.join(baseDir, 'output');
const teamsDir = path.join(outputDir, 'teams');
const locationsDir = path.join(outputDir, 'locations');

fs.mkdirSync(teamsDir, { recursive: true });
fs.mkdirSync(locationsDir, { recursive: true });

console.log('Parsing team key...');
const keyContent = fs.readFileSync(path.join(baseDir, '2026 D7 Original Schedule - Key.csv'), 'utf8');
const teams = parseKey(keyContent);
console.log(`  Loaded ${Object.keys(teams).length} teams`);

console.log('Parsing week schedules...');
const allGames = [];
for (let w = 1; w <= 52; w++) {
  const weekFile = path.join(baseDir, `2026 D7 Original Schedule - Week ${w}.csv`);
  if (fs.existsSync(weekFile)) {
    const content = fs.readFileSync(weekFile, 'utf8');
    const games = parseWeek(content, w);
    allGames.push(...games);
    console.log(`  Week ${w}: ${games.length} games`);
  }
}
console.log(`  Total: ${allGames.length} games across all weeks`);

// Assign default times for Saturday games without an explicit time.
// Group timeless Saturday games by date+location; first game → 12:30, second → 3:00.
const satGroups = {};
for (const g of allGames) {
  if (g.time || parseDate(g.date).getDay() !== 6) continue;
  const key = `${g.date}|${g.location}`;
  if (!satGroups[key]) satGroups[key] = [];
  satGroups[key].push(g);
}
for (const games of Object.values(satGroups)) {
  if (games[0]) games[0].time = '12:30';
  if (games[1]) games[1].time = '3:00';
}

console.log('Generating team schedules...');
for (const team of Object.values(teams)) {
  const html = injectGate(generateTeamHTML(team, allGames, teams), gateSnippet);
  const filename = `${team.num}_${team.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
  fs.writeFileSync(path.join(teamsDir, filename), html);
}
console.log(`  Generated ${Object.keys(teams).length} team files`);

console.log('Generating location schedules...');
const locations = [...new Set(allGames.map(g => g.location))];
for (const loc of locations) {
  const html = injectGate(generateLocationHTML(loc, allGames, teams), gateSnippet);
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
