// D7 Schedule Verification
// Audits all CSV data and outputs a single HTML report of edge cases and potential errors.
// Usage: node generate-verification.js

const fs = require('fs');
const path = require('path');
const { getPasswordHash, passwordGateSnippet, injectGate, navBar, NAV_CSS, PAGE_HEADER_CSS, FOOTER_HTML, FOOTER_CSS } = require('./config');
const gateSnippet = passwordGateSnippet(getPasswordHash());

// ---------------------------------------------------------------------------
// CSV parser (same as generate-schedules.js)
// ---------------------------------------------------------------------------
function parseCSV(content) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      current.push(cell.trim()); cell = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip
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

function parseKey(content) {
  const rows = parseCSV(content);
  const teams = {};
  let currentDivision = '';
  const divisionHeaders = new Set([
    '3A Player Pitch Baseball', 'Major Baseball', '50/70 Baseball', 'JR Baseball',
    '2A Softball', '3A Softball', 'Major Softball', 'JR Softball',
  ]);
  for (const row of rows) {
    if (!row[0]) continue;
    const first = row[0];
    if (divisionHeaders.has(first)) { currentDivision = first; }
    else if (first === 'Team' || first.includes('Inter-League')) { continue; }
    else if (row[1] && /^[A-H]\d+$/.test(row[1])) {
      teams[row[1]] = { name: first, num: row[1], manager: row[2] || '', phone: row[3] || '', email: row[4] || '', division: currentDivision };
    }
  }
  return teams;
}

// ---------------------------------------------------------------------------
// Game parser — returns { games, skipped } where skipped = cells with content
// that yielded 0 games (potential data issues)
// ---------------------------------------------------------------------------
function parseGamesVerbose(cell) {
  if (!cell) return { games: [], normalized: '', issues: [] };

  const issues = [];
  let text = cell
    .replace(/[\r\n]+/g, ' ')
    .replace(/(\d+);(\d+)/g, (m, h, min) => { issues.push({ type: 'semicolon_time', raw: m, fixed: `${h}:${min}` }); return `${h}:${min}`; })
    .replace(/([A-H])\s+(\d)/g, (m, l, d) => { issues.push({ type: 'space_in_code', raw: m, fixed: l + d }); return l + d; })
    .replace(/--/g, () => { issues.push({ type: 'double_dash', raw: '--', fixed: '-' }); return '-'; })
    .trim();

  const games = [];
  const gameRe = /([A-H]\d+)-([A-H]?\d+)/g;
  let match;
  const found = [];
  while ((match = gameRe.exec(text)) !== null) {
    found.push({ team1raw: match[1], team2raw: match[2], index: match.index, end: match.index + match[0].length });
  }

  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    const prefix = m.team1raw[0];
    const team2 = /^[A-H]/.test(m.team2raw) ? m.team2raw : prefix + m.team2raw;
    const nextStart = i + 1 < found.length ? found[i + 1].index : text.length;
    const between = text.substring(m.end, nextStart);
    const timeMatch = between.match(/(\d{1,2}:\d{2})/);
    games.push({ team1: m.team1raw, team2, time: timeMatch ? timeMatch[1] : null });
  }

  // Look for broken team-code patterns left after all valid games are removed.
  // e.g. "C-3" (letter + dash + digits, missing the digit on the first half)
  //      "C3" alone (letter + digits with no match partner)
  const afterGames = text.replace(/([A-H]\d+)-([A-H]?\d+)/g, '').replace(/\d{1,2}:\d{2}/g, '');
  const brokenCode = afterGames.match(/[A-H]-\d+/);
  if (brokenCode) {
    issues.push({ type: 'broken_team_code', raw: brokenCode[0] });
  }

  return { games, normalized: text, issues };
}

// ---------------------------------------------------------------------------
// Parse all weeks, collecting rich audit data
// ---------------------------------------------------------------------------
function parseAllWeeks(baseDir, teams) {
  const allGames = [];
  const skippedCells = [];    // cells with content but 0 parsed games
  const partialCells = [];    // cells with ≥1 game but also broken/unparsed remnants
  const normalizedCells = []; // cells where auto-fixes were applied
  const unknownTeams = [];    // game refs to team codes not in the key
  const crossDivision = [];   // games between teams from different divisions
  const timeConflicts = [];   // two games at same field+date+time

  // location+date+time → game, for conflict detection
  const slotMap = {};

  for (let w = 1; w <= 52; w++) {
    const weekFile = path.join(baseDir, `2026 D7 Original Schedule - Week ${w}.csv`);
    if (!fs.existsSync(weekFile)) continue;

    const rows = parseCSV(fs.readFileSync(weekFile, 'utf8'));
    if (rows.length === 0) continue;

    const header = rows[0];
    const dates = header.slice(1).map(d => d.replace(/(\d+)(st|nd|rd|th)/i, '$1').trim());

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row[0]) continue;
      const location = row[0];

      for (let c = 1; c <= 6; c++) {
        const cell = row[c];
        if (!cell) continue;
        const date = dates[c - 1];
        if (!date) continue;

        const { games, normalized, issues } = parseGamesVerbose(cell);
        const context = { week: w, date, location, column: c, rawCell: cell, normalized };

        // Auto-fix issues found during normalization
        const autoFixes = issues.filter(i => i.type === 'semicolon_time' || i.type === 'space_in_code' || i.type === 'double_dash');
        if (autoFixes.length > 0) {
          normalizedCells.push({ ...context, fixes: autoFixes });
        }

        // Partial parse: cell had games but also a broken/unparsed code remnant
        const brokenCodes = issues.filter(i => i.type === 'broken_team_code');
        if (brokenCodes.length > 0 && games.length > 0) {
          partialCells.push({ ...context, broken: brokenCodes.map(i => i.raw) });
        }

        if (games.length === 0) {
          skippedCells.push({ ...context });
          continue;
        }

        for (const g of games) {
          const game = { week: w, date, location, team1: g.team1, team2: g.team2, time: g.time };
          allGames.push(game);

          // Unknown team check
          const t1Known = !!teams[g.team1];
          const t2Known = !!teams[g.team2];
          if (!t1Known || !t2Known) {
            unknownTeams.push({ ...game, t1Known, t2Known });
          }

          // Cross-division check (only flag if both teams are known)
          if (t1Known && t2Known && teams[g.team1].division !== teams[g.team2].division) {
            crossDivision.push({ ...game, div1: teams[g.team1].division, div2: teams[g.team2].division });
          }

          // Time conflict check
          if (g.time) {
            const slotKey = `${location}||${date}||${g.time}`;
            if (slotMap[slotKey]) {
              timeConflicts.push({ ...game, conflictsWith: slotMap[slotKey] });
            } else {
              slotMap[slotKey] = game;
            }
          }
        }
      }
    }
  }

  // Teams with zero games
  const teamGameCounts = {};
  const homeCount = {};
  const awayCount = {};
  for (const num of Object.keys(teams)) { teamGameCounts[num] = 0; homeCount[num] = 0; awayCount[num] = 0; }
  for (const g of allGames) {
    // team1 = visiting (away), team2 = home
    if (teamGameCounts[g.team1] !== undefined) { teamGameCounts[g.team1]++; awayCount[g.team1]++; }
    if (teamGameCounts[g.team2] !== undefined) { teamGameCounts[g.team2]++; homeCount[g.team2]++; }
  }
  const zeroGames = Object.entries(teamGameCounts).filter(([, n]) => n === 0).map(([num]) => teams[num]);
  const lowGames  = Object.entries(teamGameCounts).filter(([, n]) => n > 0 && n <= 3).map(([num, n]) => ({ team: teams[num], count: n }));

  // Home/away imbalance — flag teams where |home - away| > 2
  const homeAwayImbalance = Object.keys(teams)
    .map(num => ({ team: teams[num], home: homeCount[num], away: awayCount[num], diff: homeCount[num] - awayCount[num] }))
    .filter(x => Math.abs(x.diff) > 2)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Game count summary (all teams)
  const gameCounts = Object.entries(teamGameCounts)
    .map(([num, n]) => ({ team: teams[num], count: n }))
    .sort((a, b) => a.count - b.count);

  // Per-division outlier detection
  // Group by division, compute median, flag teams > 3 games from median
  const byDivision = {};
  for (const [num, count] of Object.entries(teamGameCounts)) {
    const div = teams[num]?.division;
    if (!div) continue;
    if (!byDivision[div]) byDivision[div] = [];
    byDivision[div].push({ team: teams[num], count });
  }

  const divisionStats = {};
  const divisionOutliers = [];
  for (const [div, members] of Object.entries(byDivision)) {
    const sorted = [...members].sort((a, b) => a.count - b.count);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1].count + sorted[mid].count) / 2
      : sorted[mid].count;
    const mean = members.reduce((s, m) => s + m.count, 0) / members.length;
    const threshold = Math.max(3, Math.floor(median * 0.25));
    divisionStats[div] = { median, mean: +mean.toFixed(1), threshold, members: sorted };
    for (const m of members) {
      const diff = m.count - median;
      if (Math.abs(diff) > threshold) {
        divisionOutliers.push({ ...m, division: div, median, mean: +mean.toFixed(1), diff, direction: diff > 0 ? 'high' : 'low' });
      }
    }
  }

  // Assign default times for Saturday games without an explicit time.
  // Group timeless Saturday games by date+location; first game → 12:30, second → 3:00.
  const satGroups = {};
  for (const g of allGames) {
    if (g.time || new Date(`${g.date} 2026`).getDay() !== 6) continue;
    const key = `${g.date}|${g.location}`;
    if (!satGroups[key]) satGroups[key] = [];
    satGroups[key].push(g);
  }
  for (const games of Object.values(satGroups)) {
    if (games[0]) games[0].time = '12:30';
    if (games[1]) games[1].time = '3:00';
  }

  return { allGames, skippedCells, partialCells, normalizedCells, unknownTeams, crossDivision, timeConflicts, zeroGames, lowGames, gameCounts, teamGameCounts, divisionStats, divisionOutliers, homeAwayImbalance };
}

// ---------------------------------------------------------------------------
// Time / HTML helpers
// ---------------------------------------------------------------------------

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


function section(id, title, count, color, body) {
  const severityClass = count === 0 ? 'ok' : 'warn';
  return `
    <section id="${id}">
      <h2 class="${severityClass}">
        <span class="section-count" style="background:${count === 0 ? '#48bb78' : color}">${count}</span>
        ${esc(title)}
      </h2>
      ${count === 0
        ? `<p class="all-clear">&#10003; No issues found</p>`
        : body}
    </section>`;
}

function table(headers, rows) {
  const ths = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const trs = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Build verification HTML
// ---------------------------------------------------------------------------
function buildHTML(audit, teams) {
  const { skippedCells, partialCells, normalizedCells, unknownTeams, crossDivision, timeConflicts, zeroGames, lowGames, allGames, divisionStats, divisionOutliers, homeAwayImbalance } = audit;

  // Link helpers — paths are relative to output/ root (where verification.html lives)
  const teamFile = t => `teams/${t.num}_${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
  const locFile  = loc => `locations/${loc.replace(/[^a-zA-Z0-9]/g, '_')}.html`;

  const teamLink = num => {
    const t = teams[num];
    return t
      ? `<a href="${teamFile(t)}">${esc(t.name)}</a>`
      : `<em class="error">${esc(num)}</em>`;
  };
  const locLink = loc => `<a href="${locFile(loc)}">${esc(loc)}</a>`;

  // --- Skipped cells ---
  const skippedRows = skippedCells.map(c => [
    `Week ${c.week}`,
    esc(c.date),
    locLink(c.location),
    `<code>${esc(c.rawCell)}</code>`,
  ]);

  // --- Partial cells (some games parsed, but broken remnant found) ---
  const partialRows = partialCells.map(c => [
    `Week ${c.week}`,
    esc(c.date),
    locLink(c.location),
    `<code>${esc(c.rawCell)}</code>`,
    c.broken.map(b => `<strong class="error"><code>${esc(b)}</code></strong>`).join(', '),
  ]);

  // --- Auto-fixes applied ---
  const fixRows = normalizedCells.map(c => {
    const fixDesc = c.fixes.map(f => {
      if (f.type === 'semicolon_time') return `<code>${esc(f.raw)}</code> → <code>${esc(f.fixed)}</code> (time separator)`;
      if (f.type === 'space_in_code') return `<code>${esc(f.raw)}</code> → <code>${esc(f.fixed)}</code> (space in team code)`;
      if (f.type === 'double_dash') return `<code>--</code> → <code>-</code> (double dash)`;
      return esc(f.type);
    }).join('<br>');
    return [
      `Week ${c.week}`,
      esc(c.date),
      locLink(c.location),
      `<code>${esc(c.rawCell)}</code>`,
      fixDesc,
    ];
  });

  // --- Unknown teams ---
  const unknownRows = unknownTeams.map(g => [
    `Week ${g.week}`,
    esc(g.date),
    locLink(g.location),
    g.t1Known ? teamLink(g.team1) : `<strong class="error">${esc(g.team1)} ← not in key</strong>`,
    g.t2Known ? teamLink(g.team2) : `<strong class="error">${esc(g.team2)} ← not in key</strong>`,
    g.time ? esc(g.time) : '—',
  ]);

  // --- Cross-division ---
  const crossRows = crossDivision.map(g => [
    `Week ${g.week}`,
    esc(g.date),
    locLink(g.location),
    teamLink(g.team1),
    teamLink(g.team2),
    `<small>${esc(g.div1)}</small>`,
    `<small>${esc(g.div2)}</small>`,
  ]);

  // --- Time conflicts ---
  const conflictRows = timeConflicts.map(g => [
    `Week ${g.week}`,
    esc(g.date),
    locLink(g.location),
    esc(g.time),
    `${teamLink(g.team1)} vs ${teamLink(g.team2)}`,
    `${teamLink(g.conflictsWith.team1)} vs ${teamLink(g.conflictsWith.team2)}`,
  ]);

  // --- Zero game teams ---
  const zeroRows = zeroGames.map(t => [
    esc(t.num), `<a href="${teamFile(t)}">${esc(t.name)}</a>`, esc(t.division), esc(t.manager),
  ]);

  // --- Low game count teams ---
  const lowRows = lowGames.map(({ team: t, count }) => [
    esc(t.num), `<a href="${teamFile(t)}">${esc(t.name)}</a>`, esc(t.division), String(count),
  ]);

  // --- Home/away imbalance ---
  const imbalanceRows = homeAwayImbalance.map(({ team: t, home, away, diff }) => {
    const total = home + away;
    const direction = diff > 0 ? `+${diff} home` : `${diff} away`;
    const color = Math.abs(diff) >= 5 ? '#e53e3e' : '#dd6b20';
    return [
      esc(t.num),
      `<a href="${teamFile(t)}">${esc(t.name)}</a>`,
      esc(t.division),
      String(away),
      String(home),
      String(total),
      `<strong style="color:${color}">${direction}</strong>`,
    ];
  });

  // ---------------------------------------------------------------------------
  // Recommended Changes — one actionable item per issue
  // ---------------------------------------------------------------------------
  const recs = [];

  for (const c of partialCells) {
    recs.push({
      level: 'critical',
      label: 'Missing game',
      detail: `<strong>Week ${c.week}, ${esc(c.date)}</strong> at ${locLink(c.location)} — cell <code>${esc(c.rawCell)}</code> contains broken code ${c.broken.map(b=>`<code>${esc(b)}</code>`).join(', ')}. A game may be missing from the schedule. Fix the team code in the source CSV and re-run the schedule generator.`,
    });
  }

  for (const g of timeConflicts) {
    recs.push({
      level: 'critical',
      label: 'Time conflict',
      detail: `<strong>Week ${g.week}, ${esc(g.date)}</strong> at ${locLink(g.location)} — two games both listed at <strong>${esc(g.time)}</strong>: ${teamLink(g.team1)} vs ${teamLink(g.team2)} and ${teamLink(g.conflictsWith.team1)} vs ${teamLink(g.conflictsWith.team2)}. One game needs a different time or field.`,
    });
  }

  for (const c of skippedCells) {
    recs.push({
      level: 'critical',
      label: 'Unparseable cell',
      detail: `<strong>Week ${c.week}, ${esc(c.date)}</strong> at ${locLink(c.location)} — cell <code>${esc(c.rawCell)}</code> could not be parsed. No game was recorded. Fix the format in the source CSV and re-run the schedule generator.`,
    });
  }

  for (const { team: t, home, away, diff } of homeAwayImbalance) {
    const direction = diff > 0 ? `${diff} more home than away` : `${Math.abs(diff)} more away than home`;
    recs.push({
      level: 'warning',
      label: 'Home/away imbalance',
      detail: `<a href="${teamFile(t)}">${esc(t.name)}</a> (${esc(t.num)}, ${esc(t.division)}) — <strong>${away} away, ${home} home</strong> (${direction}). Review the schedule to see if this can be balanced.`,
    });
  }

  for (const t of zeroGames) {
    recs.push({
      level: 'warning',
      label: 'No games scheduled',
      detail: `<a href="${teamFile(t)}">${esc(t.name)}</a> (${esc(t.num)}, ${esc(t.division)}) — manager <strong>${esc(t.manager)}</strong> — has zero games across all 8 weeks. Verify this team should be in the schedule.`,
    });
  }

  for (const c of normalizedCells) {
    const fixDesc = c.fixes.map(f => {
      if (f.type === 'semicolon_time') return `<code>${esc(f.raw)}</code> → <code>${esc(f.fixed)}</code>`;
      if (f.type === 'space_in_code') return `<code>${esc(f.raw)}</code> → <code>${esc(f.fixed)}</code>`;
      if (f.type === 'double_dash') return `<code>--</code> → <code>-</code>`;
      return esc(f.type);
    }).join(', ');
    recs.push({
      level: 'info',
      label: 'Auto-corrected typo',
      detail: `<strong>Week ${c.week}, ${esc(c.date)}</strong> at ${locLink(c.location)} — auto-fixed ${fixDesc} in <code>${esc(c.rawCell)}</code>. Update the source CSV to match so future runs don't rely on auto-correction.`,
    });
  }

  const levelMeta = {
    critical: { color: '#e53e3e', bg: '#fff5f5', border: '#feb2b2', icon: '✕' },
    warning:  { color: '#c05621', bg: '#fffaf0', border: '#fbd38d', icon: '⚠' },
    info:     { color: '#2b6cb0', bg: '#ebf8ff', border: '#90cdf4', icon: 'ℹ' },
  };

  const recItems = recs.length === 0
    ? `<p class="all-clear">&#10003; No recommended changes — schedule looks clean!</p>`
    : recs.map(r => {
        const m = levelMeta[r.level];
        return `
        <div class="rec-item" style="border-left: 4px solid ${m.color}; background: ${m.bg}; border: 1px solid ${m.border}; border-left: 4px solid ${m.color}; border-radius: 6px; padding: 0.75em 1em; margin-bottom: 0.6em; display:flex; gap:0.75em; align-items:flex-start">
          <span style="color:${m.color}; font-weight:700; font-size:1em; flex-shrink:0; margin-top:0.05em">${m.icon}</span>
          <div>
            <span style="font-weight:700; color:${m.color}; font-size:0.8em; text-transform:uppercase; letter-spacing:0.05em">${r.label}</span>
            <div style="margin-top:0.2em; font-size:0.88em; color:#2d3748">${r.detail}</div>
          </div>
        </div>`;
      }).join('');

  // Summary stats
  const totalTeams = Object.keys(teams).length;
  const totalGames = allGames.length;
  const issueCount = skippedCells.length + partialCells.length + unknownTeams.length + timeConflicts.length + zeroGames.length;
  const criticalCount = recs.filter(r => r.level === 'critical').length;
  const warningCount  = recs.filter(r => r.level === 'warning').length;
  const infoCount     = recs.filter(r => r.level === 'info').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Schedule Verification — 2026 D7</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
           margin: 0; padding: 0; background: #f0f4f8; color: #2d3748; }
    ${NAV_CSS}
    ${PAGE_HEADER_CSS}
    .stats { display: flex; gap: 1em; padding: 1.5em 2em; flex-wrap: wrap; }
    .stat-card { background: white; border-radius: 8px; padding: 1em 1.5em;
                 box-shadow: 0 1px 4px rgba(0,0,0,0.1); min-width: 140px; text-align: center; }
    .stat-card .n { font-size: 2em; font-weight: 700; }
    .stat-card .label { font-size: 0.78em; color: #718096; text-transform: uppercase; letter-spacing: 0.04em; }
    .stat-card.issues .n { color: ${issueCount > 0 ? '#e53e3e' : '#38a169'}; }
    .section-nav { background: white; border-bottom: 1px solid #e2e8f0; padding: 0.5em 2em;
          display: flex; gap: 1em; flex-wrap: wrap; }
    .section-nav a { color: #3182ce; text-decoration: none; font-size: 0.88em; white-space: nowrap; }
    .section-nav a:hover { text-decoration: underline; }
    main { padding: 1.5em 2em 4em; max-width: 1200px; }
    section { margin-bottom: 3em; scroll-margin-top: 100px; }
    h2 { font-size: 1.1em; display: flex; align-items: center; gap: 0.6em; margin-bottom: 1em; }
    h2.ok  { color: #276749; }
    h2.warn { color: #c05621; }
    .section-count { display: inline-flex; align-items: center; justify-content: center;
                     width: 1.8em; height: 1.8em; border-radius: 50%;
                     color: white; font-size: 0.9em; font-weight: 700; flex-shrink: 0; }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch;
                    border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); margin-bottom: 0.5em; }
    table { width: 100%; border-collapse: collapse; background: white;
            border-radius: 0; overflow: hidden; box-shadow: none; min-width: 480px; }
    th { background: #2d3748; color: white; padding: 0.6em 1em;
         text-align: left; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; }
    td { padding: 0.55em 1em; border-bottom: 1px solid #edf2f7; font-size: 0.88em; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f7faff; }
    code { background: #edf2f7; padding: 0.1em 0.4em; border-radius: 3px;
           font-family: monospace; font-size: 0.9em; word-break: break-all; }
    .badge { display: inline-block; padding: 0.15em 0.55em; border-radius: 9999px;
             font-size: 0.75em; font-weight: 600; color: white; }
    .error { color: #e53e3e; }
    .all-clear { color: #276749; background: #f0fff4; border: 1px solid #9ae6b4;
                 padding: 0.75em 1.25em; border-radius: 6px; display: inline-block; }
    .note { font-size: 0.82em; color: #718096; margin-bottom: 0.75em; font-style: italic; }
    @media (max-width: 700px) {
      .stats { padding: 1em; gap: 0.75em; }
      .stat-card { min-width: 100px; padding: 0.75em 1em; }
      .section-nav { padding: 0.5em 1em; }
      main { padding: 1em 1em 3em; }
      h1.page-title { font-size: 1.35em; }
    }
    ${FOOTER_CSS}
  </style>
</head>
<body>
  ${navBar('', 'verify')}
  <div style="padding: 1.5em 2em 0">
    <h1 class="page-title">Schedule Verification — 2026 D7</h1>
    <p class="page-subtitle">Auto-generated audit of all 8 weeks of CSV data</p>
  </div>
  <div class="stats">
    <div class="stat-card"><div class="n">${totalTeams}</div><div class="label">Teams</div></div>
    <div class="stat-card"><div class="n">${totalGames}</div><div class="label">Games Parsed</div></div>
    <div class="stat-card" style="border-top: 3px solid #e53e3e"><div class="n" style="color:#e53e3e">${criticalCount}</div><div class="label">Critical</div></div>
    <div class="stat-card" style="border-top: 3px solid #dd6b20"><div class="n" style="color:#dd6b20">${warningCount}</div><div class="label">Warnings</div></div>
    <div class="stat-card" style="border-top: 3px solid #2b6cb0"><div class="n" style="color:#2b6cb0">${infoCount}</div><div class="label">Info</div></div>
  </div>

  <div class="section-nav">
    <a href="#skipped">Skipped Cells (${skippedCells.length})</a>
    <a href="#partial">Partial Cells (${partialCells.length})</a>
    <a href="#autofixed">Auto-Fixed (${normalizedCells.length})</a>
    <a href="#unknown">Unknown Teams (${unknownTeams.length})</a>
    <a href="#crossdiv">Cross-Division (${crossDivision.length})</a>
    <a href="#conflicts">Time Conflicts (${timeConflicts.length})</a>
    <a href="#zerogames">Zero Games (${zeroGames.length})</a>
    <a href="#lowgames">Low Game Count (${lowGames.length})</a>
    <a href="#homeaway">Home/Away Imbalance (${homeAwayImbalance.length})</a>
    <span style="color:#cbd5e0">|</span>
    <a href="#recommendations">&#9733; Recommended Changes (${recs.length})</a>
  </div>

  <main>

    ${section('skipped', 'Skipped Cells — content present but no game could be parsed', skippedCells.length, '#e53e3e',
      `<p class="note">These cells had non-empty content but zero valid game codes were extracted. Each one likely contains a typo or non-standard format that needs manual review.</p>
      ${table(['Week', 'Date', 'Location', 'Raw Cell Content'], skippedRows)}`
    )}

    ${section('partial', 'Partial Cells — game partially parsed but broken code remnant found', partialCells.length, '#e53e3e',
      `<p class="note">These cells had at least one valid game extracted, but also contained a broken team code pattern that couldn't be parsed. A second game may be missing from the schedule. The raw cell content is shown so you can identify the intended team code.</p>
      ${table(['Week', 'Date', 'Location', 'Raw Cell Content', 'Unparsed Fragment'], partialRows)}`
    )}

    ${section('autofixed', 'Auto-Fixed — data normalized before parsing', normalizedCells.length, '#dd6b20',
      `<p class="note">These cells had minor formatting issues that were automatically corrected. Verify the fixes look right — the schedule output used the corrected version.</p>
      ${table(['Week', 'Date', 'Location', 'Original Cell', 'Fix Applied'], fixRows)}`
    )}

    ${section('unknown', 'Unknown Team References — team code not found in Key', unknownTeams.length, '#e53e3e',
      `<p class="note">These games reference a team number that doesn't appear in the master team list. Could be a typo in the team code or a team missing from the key.</p>
      ${table(['Week', 'Date', 'Location', 'Team 1', 'Team 2', 'Time'], unknownRows)}`
    )}

    ${section('crossdiv', 'Cross-Division Games — two teams from different divisions', crossDivision.length, '#dd6b20',
      `<p class="note">These matchups involve teams from different divisions. This may be intentional (exhibition games, scheduling constraints) or may indicate a mistyped team code.</p>
      ${table(['Week', 'Date', 'Location', 'Team 1', 'Team 2', 'Division 1', 'Division 2'], crossRows)}`
    )}

    ${section('conflicts', 'Time Conflicts — two games at the same field at the same time', timeConflicts.length, '#e53e3e',
      `<p class="note">Two games were found with the same location, date, and time. One of the times may be wrong.</p>
      ${table(['Week', 'Date', 'Location', 'Time', 'Game 1', 'Game 2'], conflictRows)}`
    )}

    ${section('zerogames', 'Teams with Zero Games Scheduled', zeroGames.length, '#e53e3e',
      `<p class="note">These teams appear in the master team list but have no games in any of the 8 weeks.</p>
      ${table(['Team #', 'Name', 'Division', 'Manager'], zeroRows)}`
    )}

    ${section('lowgames', 'Teams with 3 or Fewer Games', lowGames.length, '#dd6b20',
      `<p class="note">These teams have an unusually low number of scheduled games. Could indicate missing data or team codes that don't match the key.</p>
      ${table(['Team #', 'Name', 'Division', 'Game Count'], lowRows)}`
    )}

    ${(() => {
      const divOrder = ['3A Player Pitch Baseball','Major Baseball','50/70 Baseball','JR Baseball','2A Softball','3A Softball','Major Softball','JR Softball'];
      const divTables = divOrder.map(div => {
        const stats = divisionStats[div];
        if (!stats) return '';
        const teamFile = t => `teams/${t.num}_${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
        const rows = stats.members.map(m => {
          const diff = m.count - stats.median;
          const isOutlier = Math.abs(diff) > stats.threshold;
          const flagColor = diff < 0 ? '#e53e3e' : '#dd6b20';
          const diffLabel = diff > 0 ? `+${diff}` : `${diff}`;
          const barW = stats.median > 0 ? Math.round((m.count / (stats.median * 1.5)) * 120) : 0;
          const barColor = m.count === 0 ? '#fc8181' : isOutlier ? '#f6ad55' : '#68d391';
          return `<tr${isOutlier ? ` style="background:#fffbeb"` : ''}>
            <td><a href="${teamFile(m.team)}">${esc(m.team.name)}</a></td>
            <td style="text-align:center">${esc(m.team.num)}</td>
            <td>
              <div style="display:flex;align-items:center;gap:0.5em">
                <div style="background:${barColor};width:${barW}px;height:12px;border-radius:3px;min-width:2px;flex-shrink:0"></div>
                <strong>${m.count}</strong>
                ${isOutlier ? `<span style="color:${flagColor};font-size:0.78em;font-weight:700">(${diffLabel} vs median)</span>` : ''}
              </div>
            </td>
          </tr>`;
        }).join('');
        const outCount = stats.members.filter(m => Math.abs(m.count - stats.median) > stats.threshold).length;
        return `
          <div style="margin-bottom:1.5em">
            <div style="display:flex;align-items:baseline;gap:1em;margin-bottom:0.4em">
              <strong style="font-size:0.95em">${esc(div)}</strong>
              <span style="font-size:0.8em;color:#718096">median ${stats.median} games &middot; mean ${stats.mean}</span>
              ${outCount > 0 ? `<span style="font-size:0.78em;color:#c05621;font-weight:700">&#9888; ${outCount} outlier${outCount>1?'s':''}</span>` : '<span style="font-size:0.78em;color:#276749">&#10003; balanced</span>'}
            </div>
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
              <thead><tr style="background:#2d3748;color:white;font-size:0.78em;text-transform:uppercase;letter-spacing:0.04em">
                <th style="padding:0.4em 0.75em;text-align:left">Team</th>
                <th style="padding:0.4em 0.75em;text-align:center">#</th>
                <th style="padding:0.4em 0.75em;text-align:left">Games</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }).join('');
      const outlierCount = divisionOutliers.length;
      return section('div-outliers', 'Game Count by Division — outliers flagged', outlierCount, '#dd6b20',
        `<p class="note">Teams flagged in orange are more than ${Object.values(divisionStats)[0]?.threshold ?? 3} games from their division median. Scroll right if needed on small screens.</p>${divTables}`
      );
    })()}

    ${section('homeaway', 'Home/Away Imbalance — teams with 3+ more games on one side', homeAwayImbalance.length, '#dd6b20',
      `<p class="note">In every game code the visiting team is listed first (away) and the home team is listed second. Teams flagged here have at least 3 more games on one side than the other. A difference of 1–2 is normal when a team has an odd number of games; 3+ may indicate a scheduling imbalance worth correcting.</p>
      ${table(['Team #', 'Name', 'Division', 'Away', 'Home', 'Total', 'Difference'], imbalanceRows)}`
    )}

    <section id="recommendations" style="margin-top:2em">
      <h2 style="display:flex; align-items:center; gap:0.6em; font-size:1.1em; margin-bottom:1em">
        <span class="section-count" style="background:${recs.length === 0 ? '#48bb78' : '#e53e3e'}">${recs.length}</span>
        Recommended Changes to Source CSV
      </h2>
      <p class="note">Each item below is a specific action to take in the original Excel/CSV files. After fixing, re-run the schedule generator to rebuild all HTML files.</p>
      ${recItems}
    </section>

  </main>
  ${FOOTER_HTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const baseDir = __dirname;
const outputDir = path.join(baseDir, 'output');
fs.mkdirSync(outputDir, { recursive: true });

console.log('Parsing team key...');
const keyContent = fs.readFileSync(path.join(baseDir, '2026 D7 Original Schedule - Key.csv'), 'utf8');
const teams = parseKey(keyContent);
console.log(`  Loaded ${Object.keys(teams).length} teams`);

console.log('Auditing week schedules...');
const audit = parseAllWeeks(baseDir, teams);

console.log(`\nResults:`);
console.log(`  Games parsed:      ${audit.allGames.length}`);
console.log(`  Skipped cells:     ${audit.skippedCells.length}`);
console.log(`  Partial cells:     ${audit.partialCells.length}`);
console.log(`  Auto-fixed cells:  ${audit.normalizedCells.length}`);
console.log(`  Unknown teams:     ${audit.unknownTeams.length}`);
console.log(`  Cross-division:    ${audit.crossDivision.length}`);
console.log(`  Time conflicts:    ${audit.timeConflicts.length}`);
console.log(`  Zero-game teams:   ${audit.zeroGames.length}`);
console.log(`  Low-game teams:    ${audit.lowGames.length}`);

const html = injectGate(buildHTML(audit, teams), gateSnippet);
fs.writeFileSync(path.join(outputDir, 'verification.html'), html);

console.log('\nDone! Open output/verification.html to review.');
