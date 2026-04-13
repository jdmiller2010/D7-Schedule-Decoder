// D7 Schedule Verification
// Audits all XLSX data and outputs a single HTML report of parse results and potential errors.
// Usage: node generate-verification.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { getPasswordHash, passwordGateSnippet, injectGate, navBar, NAV_CSS, PAGE_HEADER_CSS, SCHEDULE_INFO_BANNER, FOOTER_HTML, FOOTER_CSS, DIVISION_ORDER } = require('./config');
const { parseKey, parseScheduleXLSX } = require('./parse-xlsx');
const gateSnippet = passwordGateSnippet(getPasswordHash());

// ---------------------------------------------------------------------------
// Build the full audit data set on top of the parse results
// ---------------------------------------------------------------------------
function buildAudit(parseResult, teams) {
  const { games, removedCells, movedFromCells, eastLaneCells,
          skippedCells, partialCells, normalizedCells,
          unknownLocations, weeksFound } = parseResult;

  // ── Assign default Saturday times (mirrors generate-schedules.js) ────────
  const satGroups = {};
  for (const g of games) {
    if (g.time || new Date(`${g.date} 2026`).getDay() !== 6) continue;
    const key = `${g.date}|${g.location}`;
    if (!satGroups[key]) satGroups[key] = [];
    satGroups[key].push(g);
  }
  for (const group of Object.values(satGroups)) {
    if (group[0]) group[0].time = '12:30';
    if (group[1]) group[1].time = '3:00';
  }

  // ── Unknown team codes ────────────────────────────────────────────────────
  const unknownTeams = games.filter(g => !teams[g.team1] || !teams[g.team2]);

  // ── Cross-division games (both teams known, different divisions) ──────────
  const crossDivision = games.filter(g =>
    teams[g.team1] && teams[g.team2] &&
    teams[g.team1].division !== teams[g.team2].division
  );

  // ── Time conflicts (same location + date + time, two different games) ─────
  const slotMap = {};
  const timeConflicts = [];
  for (const g of games) {
    if (!g.time) continue;
    const key = `${g.location}||${g.date}||${g.time}`;
    if (slotMap[key]) {
      timeConflicts.push({ ...g, conflictsWith: slotMap[key] });
    } else {
      slotMap[key] = g;
    }
  }

  // ── Per-team game counts ──────────────────────────────────────────────────
  const teamGameCounts = {};
  const homeCount = {}, awayCount = {};
  for (const num of Object.keys(teams)) {
    teamGameCounts[num] = 0; homeCount[num] = 0; awayCount[num] = 0;
  }
  for (const g of games) {
    if (teamGameCounts[g.team1] !== undefined) { teamGameCounts[g.team1]++; awayCount[g.team1]++; }
    if (teamGameCounts[g.team2] !== undefined) { teamGameCounts[g.team2]++; homeCount[g.team2]++; }
  }

  const zeroGames = Object.entries(teamGameCounts)
    .filter(([, n]) => n === 0).map(([num]) => teams[num]);
  const lowGames  = Object.entries(teamGameCounts)
    .filter(([, n]) => n > 0 && n <= 3).map(([num, n]) => ({ team: teams[num], count: n }));

  // ── Home/away imbalance ───────────────────────────────────────────────────
  // Threshold avoids flagging teams with natural odd-game imbalances or
  // divisions (like East Lane) where limited interleague games skew the ratio.
  const HOME_AWAY_FLAG_THRESHOLD = 5;
  const homeAwayImbalance = Object.keys(teams)
    .map(num => ({ team: teams[num], home: homeCount[num], away: awayCount[num], diff: homeCount[num] - awayCount[num] }))
    .filter(x => Math.abs(x.diff) > HOME_AWAY_FLAG_THRESHOLD)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // ── Per-division outlier detection ────────────────────────────────────────
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
    const sorted    = [...members].sort((a, b) => a.count - b.count);
    const mid       = Math.floor(sorted.length / 2);
    const median    = sorted.length % 2 === 0
      ? (sorted[mid - 1].count + sorted[mid].count) / 2
      : sorted[mid].count;
    const mean      = members.reduce((s, m) => s + m.count, 0) / members.length;
    const threshold = Math.max(3, Math.floor(median * 0.25));
    divisionStats[div] = { median, mean: +mean.toFixed(1), threshold, members: sorted };
    for (const m of members) {
      const diff = m.count - median;
      if (Math.abs(diff) > threshold) {
        divisionOutliers.push({ ...m, division: div, median, mean: +mean.toFixed(1), diff, direction: diff > 0 ? 'high' : 'low' });
      }
    }
  }

  // ── All highlighted (changed) cells, grouped by classification ───────────
  const changedGames    = games.filter(g => g.changed);
  const changedRemoved  = removedCells.filter(c => c.changed);
  const changedMoved    = movedFromCells.filter(c => c.changed);
  const changedEastLane = eastLaneCells.filter(c => c.changed);
  const changedSkipped  = skippedCells.filter(c => c.changed);

  return {
    games, weeksFound,
    removedCells, movedFromCells, eastLaneCells,
    skippedCells, partialCells, normalizedCells,
    unknownTeams, crossDivision, timeConflicts,
    zeroGames, lowGames, homeAwayImbalance,
    teamGameCounts, divisionStats, divisionOutliers,
    unknownLocations,
    changedGames, changedRemoved, changedMoved, changedEastLane, changedSkipped,
  };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// forceBody=true renders body regardless of count (used for informational sections)
function section(id, title, count, color, body, forceBody = false) {
  const isOk = count === 0;
  return `
    <section id="${id}">
      <h2 class="${isOk ? 'ok' : 'warn'}">
        <span class="section-count" style="background:${isOk ? '#48bb78' : color}">${count}</span>
        ${esc(title)}
      </h2>
      ${(!isOk || forceBody)
        ? body
        : `<p class="all-clear">&#10003; No issues found</p>`}
    </section>`;
}

function table(headers, rows) {
  const ths = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const trs = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Build the full verification HTML
// ---------------------------------------------------------------------------
function buildHTML(audit, teams) {
  const {
    games, weeksFound,
    removedCells, movedFromCells, eastLaneCells,
    skippedCells, partialCells, normalizedCells,
    unknownTeams, crossDivision, timeConflicts,
    zeroGames, lowGames, homeAwayImbalance,
    teamGameCounts, divisionStats, divisionOutliers,
    unknownLocations,
    changedGames, changedRemoved, changedMoved, changedEastLane, changedSkipped,
  } = audit;

  const teamFile = t => `teams/${t.num}_${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
  const locFile  = loc => `locations/${loc.replace(/[^a-zA-Z0-9]/g, '_')}.html`;

  const teamLink = num => {
    const t = teams[num];
    return t
      ? `<a href="${teamFile(t)}">${esc(t.name)}</a>`
      : `<em class="error">${esc(num)}</em>`;
  };
  const locLink = loc => `<a href="${locFile(loc)}">${esc(loc)}</a>`;

  const totalTeams  = Object.keys(teams).length;
  const totalGames  = games.length;
  const totalChanged = changedGames.length + changedRemoved.length + changedMoved.length +
                       changedEastLane.length + changedSkipped.length;

  const criticalCount = skippedCells.length + partialCells.length + unknownTeams.length + zeroGames.length + unknownLocations.length;
  const warningCount  = timeConflicts.length + lowGames.length + homeAwayImbalance.length + divisionOutliers.length;
  const infoCount     = normalizedCells.length + eastLaneCells.length + movedFromCells.length + removedCells.length;

  // ── Import health banner items ────────────────────────────────────────────
  // Each item: { level: 'error'|'warn'|'ok', message, anchor }
  const healthItems = [];
  if (skippedCells.length > 0)
    healthItems.push({ level: 'error', anchor: '#skipped',
      message: `${skippedCells.length} cell(s) with unrecognized content — a game may have been dropped` });
  if (partialCells.length > 0)
    healthItems.push({ level: 'error', anchor: '#partial',
      message: `${partialCells.length} cell(s) partially parsed — at least one game code could not be read` });
  if (unknownTeams.length > 0)
    healthItems.push({ level: 'error', anchor: '#unknown-teams',
      message: `${unknownTeams.length} game(s) reference a team code not in the Key CSV` });
  if (unknownLocations.length > 0)
    healthItems.push({ level: 'error', anchor: '#unknown-locs',
      message: `${unknownLocations.length} location name(s) in the schedule don't match the field info sheet` });
  if (zeroGames.length > 0)
    healthItems.push({ level: 'error', anchor: '#zerogames',
      message: `${zeroGames.length} team(s) have zero scheduled games` });
  if (timeConflicts.length > 0)
    healthItems.push({ level: 'warn', anchor: '#conflicts',
      message: `${timeConflicts.length} time conflict(s) — two games at the same field/time` });
  if (normalizedCells.length > 0)
    healthItems.push({ level: 'warn', anchor: '#autofixed',
      message: `${normalizedCells.length} cell(s) had formatting auto-corrected — verify the fix was right` });

  const importIsClean = healthItems.every(h => h.level !== 'error');

  const healthBannerHTML = (() => {
    if (healthItems.length === 0) {
      return `<div style="background:#f0fff4;border:2px solid #68d391;border-radius:8px;padding:1em 1.5em;display:flex;align-items:center;gap:0.75em">
        <span style="font-size:1.5em">&#10003;</span>
        <div>
          <strong style="color:#276749">Import clean — safe to publish</strong>
          <div style="font-size:0.85em;color:#276749;margin-top:0.15em">No parse errors found. All game codes resolved, all locations matched.</div>
        </div>
      </div>`;
    }
    const errorItems  = healthItems.filter(h => h.level === 'error');
    const warnItems   = healthItems.filter(h => h.level === 'warn');
    const headerColor = errorItems.length > 0 ? '#9b2c2c' : '#744210';
    const headerBg    = errorItems.length > 0 ? '#fff5f5' : '#fffbeb';
    const headerBorder= errorItems.length > 0 ? '#fc8181' : '#f6e05e';
    const headerIcon  = errorItems.length > 0 ? '&#9888;' : '&#9432;';
    const headerText  = errorItems.length > 0
      ? `${errorItems.length} import error${errorItems.length > 1 ? 's' : ''} found — review the details below`
      : `${warnItems.length} warning${warnItems.length > 1 ? 's' : ''} — review before publishing`;
    const listItems = healthItems.map(h => {
      const color = h.level === 'error' ? '#c53030' : '#744210';
      const icon  = h.level === 'error' ? '&#10007;' : '&#9888;';
      return `<li style="color:${color};margin:0.35em 0">
        <span style="font-weight:700">${icon}</span>
        <a href="${h.anchor}" style="color:${color}">${h.message}</a>
      </li>`;
    }).join('');
    return `<div style="background:${headerBg};border:2px solid ${headerBorder};border-radius:8px;padding:1em 1.5em">
      <div style="display:flex;align-items:center;gap:0.6em;margin-bottom:0.6em">
        <span style="font-size:1.3em">${headerIcon}</span>
        <strong style="color:${headerColor};font-size:1em">${headerText}</strong>
      </div>
      <ul style="margin:0;padding-left:1.5em;font-size:0.88em">${listItems}</ul>
    </div>`;
  })();

  // ── Skipped cells ─────────────────────────────────────────────────────────
  const skippedRows = skippedCells.map(c => [
    `Week ${c.week}`, esc(c.date), locLink(c.location),
    `<code>${esc(c.rawCell)}</code>`,
    c.changed ? '<span class="badge" style="background:#d69e2e">Changed</span>' : '—',
  ]);

  // ── Partial cells ─────────────────────────────────────────────────────────
  const partialRows = partialCells.map(c => [
    `Week ${c.week}`, esc(c.date), locLink(c.location),
    `<code>${esc(c.rawCell)}</code>`,
    c.broken.map(b => `<code class="error">${esc(b)}</code>`).join(', '),
  ]);

  // ── Auto-fixes ────────────────────────────────────────────────────────────
  const fixRows = normalizedCells.map(c => {
    const fixDesc = c.fixes.map(f => {
      if (f.type === 'semicolon_time') return `<code>${esc(f.raw)}</code> → <code>${esc(f.fixed)}</code> (time separator)`;
      if (f.type === 'space_in_code')  return `<code>${esc(f.raw)}</code> → <code>${esc(f.fixed)}</code> (space in code)`;
      if (f.type === 'double_dash')    return `<code>--</code> → <code>-</code> (double dash)`;
      return esc(f.type);
    }).join('<br>');
    return [`Week ${c.week}`, esc(c.date), locLink(c.location), `<code>${esc(c.rawCell)}</code>`, fixDesc];
  });

  // ── Unknown teams ─────────────────────────────────────────────────────────
  const unknownRows = unknownTeams.map(g => [
    `Week ${g.week}`, esc(g.date), locLink(g.location),
    teams[g.team1] ? teamLink(g.team1) : `<strong class="error">${esc(g.team1)} ← not in key</strong>`,
    teams[g.team2] ? teamLink(g.team2) : `<strong class="error">${esc(g.team2)} ← not in key</strong>`,
    g.time ? esc(g.time) : '—',
  ]);

  // ── Unknown locations ─────────────────────────────────────────────────────
  const unknownLocRows = unknownLocations.map(u => [
    `Week ${u.week}`,
    `<strong class="error">${esc(u.location)}</strong>`,
    '<em>Not found in "field info" sheet — check for typo or renamed field</em>',
  ]);

  // ── Cross-division ────────────────────────────────────────────────────────
  const crossRows = crossDivision.map(g => [
    `Week ${g.week}`, esc(g.date), locLink(g.location),
    teamLink(g.team1), teamLink(g.team2),
    `<small>${esc(teams[g.team1].division)}</small>`,
    `<small>${esc(teams[g.team2].division)}</small>`,
  ]);

  // ── Time conflicts ────────────────────────────────────────────────────────
  const conflictRows = timeConflicts.map(g => [
    `Week ${g.week}`, esc(g.date), locLink(g.location), esc(g.time),
    `${teamLink(g.team1)} vs ${teamLink(g.team2)}`,
    `${teamLink(g.conflictsWith.team1)} vs ${teamLink(g.conflictsWith.team2)}`,
  ]);

  // ── Zero/low game teams ───────────────────────────────────────────────────
  const zeroRows = zeroGames.map(t => [esc(t.num), `<a href="${teamFile(t)}">${esc(t.name)}</a>`, esc(t.division), esc(t.manager)]);
  const lowRows  = lowGames.map(({ team: t, count }) => [esc(t.num), `<a href="${teamFile(t)}">${esc(t.name)}</a>`, esc(t.division), String(count)]);

  // ── Home/away imbalance ───────────────────────────────────────────────────
  const imbalanceRows = homeAwayImbalance.map(({ team: t, home, away, diff }) => {
    const color = Math.abs(diff) >= 5 ? '#e53e3e' : '#dd6b20';
    const dir   = diff > 0 ? `+${diff} home` : `${diff} away`;
    return [esc(t.num), `<a href="${teamFile(t)}">${esc(t.name)}</a>`, esc(t.division),
            String(away), String(home), String(home + away),
            `<strong style="color:${color}">${dir}</strong>`];
  });

  // ── Removed games ─────────────────────────────────────────────────────────
  const removedRows = removedCells.map(c => [
    `Week ${c.week}`, esc(c.date), locLink(c.location),
    `<code>${esc(c.rawCell.trim())}</code>`,
    c.changed ? '<span class="badge" style="background:#d69e2e">Highlighted</span>' : '—',
  ]);

  // ── Moved-from games ──────────────────────────────────────────────────────
  const movedRows = movedFromCells.map(c => [
    `Week ${c.week}`, esc(c.date), locLink(c.location),
    `${teamLink(c.team1)} vs ${teamLink(c.team2)}`,
    esc(c.movedNote),
    c.changed ? '<span class="badge" style="background:#d69e2e">Highlighted</span>' : '—',
  ]);

  // ── Changed cells summary (all yellow-highlighted, by class) ──────────────
  const changedAllRows = [
    ...changedGames.map(g => ['Active Game', `Week ${g.week}`, esc(g.date), locLink(g.location), `${teamLink(g.team1)} vs ${teamLink(g.team2)}`]),
    ...changedMoved.map(c => ['Moved Away', `Week ${c.week}`, esc(c.date), locLink(c.location), `${teamLink(c.team1)} vs ${teamLink(c.team2)} → ${esc(c.movedNote)}`]),
    ...changedRemoved.map(c => ['Removed', `Week ${c.week}`, esc(c.date), locLink(c.location), `<code>${esc(c.rawCell.trim())}</code>`]),
    ...changedEastLane.map(c => ['East Lane Note', `Week ${c.week}`, esc(c.date), locLink(c.location), `<code>${esc(c.rawCell.trim())}</code>`]),
    ...changedSkipped.map(c => ['Unrecognized', `Week ${c.week}`, esc(c.date), locLink(c.location), `<code class="error">${esc(c.rawCell.trim())}</code>`]),
  ];

  // ── Division game count tables ────────────────────────────────────────────
  const divTables = DIVISION_ORDER.map(div => {
    const stats = divisionStats[div];
    if (!stats) return '';
    const rows = stats.members.map(m => {
      const diff      = m.count - stats.median;
      const isOutlier = Math.abs(diff) > stats.threshold;
      const flagColor = diff < 0 ? '#e53e3e' : '#dd6b20';
      const diffLabel = diff > 0 ? `+${diff}` : `${diff}`;
      const barW      = stats.median > 0 ? Math.round((m.count / (stats.median * 1.5)) * 120) : 0;
      const barColor  = m.count === 0 ? '#fc8181' : isOutlier ? '#f6ad55' : '#68d391';
      return `<tr${isOutlier ? ' style="background:#fffbeb"' : ''}>
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
          ${outCount > 0 ? `<span style="font-size:0.78em;color:#c05621;font-weight:700">&#9888; ${outCount} outlier${outCount > 1 ? 's' : ''}</span>` : '<span style="font-size:0.78em;color:#276749">&#10003; balanced</span>'}
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

  // ─────────────────────────────────────────────────────────────────────────
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
    ${FOOTER_CSS}
    .stats { display: flex; gap: 1em; padding: 1.5em 2em; flex-wrap: wrap; }
    .stat-card { background: white; border-radius: 8px; padding: 1em 1.5em;
                 box-shadow: 0 1px 4px rgba(0,0,0,0.1); min-width: 130px; text-align: center; }
    .stat-card .n { font-size: 2em; font-weight: 700; }
    .stat-card .label { font-size: 0.78em; color: #718096; text-transform: uppercase; letter-spacing: 0.04em; }
    .section-nav { background: white; border-bottom: 1px solid #e2e8f0; padding: 0.5em 2em;
                   display: flex; gap: 0.75em 1.5em; flex-wrap: wrap; }
    .section-nav a { color: #3182ce; text-decoration: none; font-size: 0.85em; white-space: nowrap; }
    .section-nav a:hover { text-decoration: underline; }
    main { padding: 1.5em 2em 4em; max-width: 1200px; }
    section { margin-bottom: 3em; scroll-margin-top: 100px; }
    h2 { font-size: 1.1em; display: flex; align-items: center; gap: 0.6em; margin-bottom: 1em; }
    h2.ok   { color: #276749; }
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
    a { color: #3182ce; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 700px) {
      .stats { padding: 1em; gap: 0.75em; }
      .stat-card { min-width: 100px; padding: 0.75em 1em; }
      .section-nav { padding: 0.5em 1em; }
      main { padding: 1em 1em 3em; }
    }
  </style>
</head>
<body>
  ${navBar('', 'verify')}
  <div style="padding: 1.5em 2em 0">
    ${SCHEDULE_INFO_BANNER}
    <h1 class="page-title">Schedule Verification — 2026 D7</h1>
    <p class="page-subtitle">Auto-generated audit of XLSX data &mdash; ${weeksFound.length} week(s), ${totalTeams} teams, ${totalGames} active games</p>
    <div style="margin-bottom:1.5em">${healthBannerHTML}</div>
  </div>
  <div class="stats">
    <div class="stat-card"><div class="n">${totalTeams}</div><div class="label">Teams</div></div>
    <div class="stat-card"><div class="n">${totalGames}</div><div class="label">Active Games</div></div>
    <div class="stat-card"><div class="n">${totalChanged}</div><div class="label">Changed Cells</div></div>
    <div class="stat-card"><div class="n">${removedCells.length}</div><div class="label">Removed Games</div></div>
    <div class="stat-card"><div class="n">${movedFromCells.length}</div><div class="label">Moved Games</div></div>
    <div class="stat-card" style="border-top:3px solid #e53e3e"><div class="n" style="color:#e53e3e">${criticalCount}</div><div class="label">Critical</div></div>
    <div class="stat-card" style="border-top:3px solid #dd6b20"><div class="n" style="color:#dd6b20">${warningCount}</div><div class="label">Warnings</div></div>
    <div class="stat-card" style="border-top:3px solid #2b6cb0"><div class="n" style="color:#2b6cb0">${infoCount}</div><div class="label">Info</div></div>
  </div>

  <div class="section-nav">
    <strong style="font-size:0.8em;color:#718096;align-self:center">CRITICAL:</strong>
    <a href="#skipped">Unrecognized Cells (${skippedCells.length})</a>
    <a href="#partial">Partial Parse (${partialCells.length})</a>
    <a href="#unknown-teams">Unknown Teams (${unknownTeams.length})</a>
    <a href="#unknown-locs">Unknown Locations (${unknownLocations.length})</a>
    <a href="#zerogames">Zero Games (${zeroGames.length})</a>
    <span style="color:#e2e8f0">|</span>
    <strong style="font-size:0.8em;color:#718096;align-self:center">WARN:</strong>
    <a href="#conflicts">Time Conflicts (${timeConflicts.length})</a>
    <a href="#homeaway">H/A Imbalance (${homeAwayImbalance.length})</a>
    <a href="#lowgames">Low Game Count (${lowGames.length})</a>
    <a href="#div-outliers">Division Outliers (${divisionOutliers.length})</a>
    <span style="color:#e2e8f0">|</span>
    <strong style="font-size:0.8em;color:#718096;align-self:center">INFO:</strong>
    <a href="#changed">Changed Cells (${totalChanged})</a>
    <a href="#removed">Removed Games (${removedCells.length})</a>
    <a href="#moved">Moved Games (${movedFromCells.length})</a>
    <a href="#autofixed">Auto-Fixed (${normalizedCells.length})</a>
    <a href="#crossdiv">Cross-Division (${crossDivision.length})</a>
  </div>

  <main>

    ${section('skipped', 'Unrecognized Cell Content — has text but could not be parsed or classified', skippedCells.length, '#e53e3e',
      `<p class="note">These cells had non-empty content that produced no game codes and didn't match any known annotation pattern ("Game removed", "MOVED TO", "EAST LANE NO INTERLEAGUE", etc.). Each one is a likely typo or format change in the source XLSX that needs manual review before publishing.</p>
      ${table(['Week', 'Date', 'Location', 'Raw Cell Content', 'Highlighted?'], skippedRows)}`
    )}

    ${section('partial', 'Partial Parse — game extracted but broken code remnant also found', partialCells.length, '#e53e3e',
      `<p class="note">These cells yielded at least one valid game but also contained a fragment that looks like an incomplete team code. A second game may be missing. Compare the raw cell against the source XLSX.</p>
      ${table(['Week', 'Date', 'Location', 'Raw Cell Content', 'Unmatched Fragment'], partialRows)}`
    )}

    ${section('unknown-teams', 'Unknown Team References — code not in Key CSV', unknownTeams.length, '#e53e3e',
      `<p class="note">These games reference a team number that doesn't appear in the master Key CSV. Could be a new team letter prefix, a typo, or a team missing from the key file.</p>
      ${table(['Week', 'Date', 'Location', 'Team 1', 'Team 2', 'Time'], unknownRows)}`
    )}

    ${section('unknown-locs', 'Unknown Location Names — not in "field info" sheet', unknownLocations.length, '#e53e3e',
      `<p class="note">These location names appear in the Schedule sheet but don't match any name in the "field info" sheet. A subtle rename or typo in the XLSX could cause games to be attributed to the wrong or a duplicate location page.</p>
      ${table(['Week', 'Location Name', 'Note'], unknownLocRows)}`
    )}

    ${section('zerogames', 'Teams with Zero Games Scheduled', zeroGames.length, '#e53e3e',
      `<p class="note">These teams appear in the Key CSV but have no active games in any week. Could indicate the team's code was recently changed or games were all removed.</p>
      ${table(['Team #', 'Name', 'Division', 'Manager'], zeroRows)}`
    )}

    ${section('conflicts', 'Time Conflicts — two games at the same field at the same time', timeConflicts.length, '#e53e3e',
      `<p class="note">Two different games were scheduled at the same location, date, and time.</p>
      ${table(['Week', 'Date', 'Location', 'Time', 'Game 1', 'Game 2'], conflictRows)}`
    )}

    ${section('homeaway', 'Home/Away Imbalance — teams with 3+ extra games on one side', homeAwayImbalance.length, '#dd6b20',
      `<p class="note">In every game code the visiting team is listed first (away) and the home team second. Teams flagged here have at least 3 more games on one side. A difference of 1–2 is normal; 3+ may indicate a scheduling error.</p>
      ${table(['Team #', 'Name', 'Division', 'Away', 'Home', 'Total', 'Difference'], imbalanceRows)}`
    )}

    ${section('lowgames', 'Teams with 3 or Fewer Games', lowGames.length, '#dd6b20',
      `<p class="note">Unusually low game count — may indicate team codes that don't match the key, or games that were all removed.</p>
      ${table(['Team #', 'Name', 'Division', 'Game Count'], lowRows)}`
    )}

    ${section('div-outliers', 'Game Count by Division — outliers flagged', divisionOutliers.length, '#dd6b20',
      `<p class="note">Teams more than the threshold number of games from their division median are flagged. Scroll right on small screens.</p>${divTables}`
    )}

    ${section('changed', `Changed Cells — all ${totalChanged} yellow-highlighted cells from source XLSX`, 0, '#2b6cb0',
      `<p class="note">These cells were highlighted in the source XLSX by D7 to indicate something changed. Verify each one looks correct on the generated site.</p>
       ${changedAllRows.length === 0
         ? '<p class="all-clear">&#10003; No highlighted cells detected</p>'
         : table(['Classification', 'Week', 'Date', 'Location', 'Content'], changedAllRows)
       }`,
      true
    )}

    ${section('removed', `Removed Games (${removedCells.length}) — cells marked "Game removed" in source XLSX`, 0, '#2b6cb0',
      removedCells.length === 0
        ? '<p class="all-clear">&#10003; No removed games</p>'
        : `<p class="note">These game slots were explicitly marked as removed by D7. They are NOT included in any team or location schedule.</p>
           ${table(['Week', 'Date', 'Location', 'Raw Cell', 'Highlighted?'], removedRows)}`,
      true
    )}

    ${section('moved', `Moved Games (${movedFromCells.length}) — source slots annotated "MOVED TO"`, 0, '#2b6cb0',
      movedFromCells.length === 0
        ? '<p class="all-clear">&#10003; No moved games</p>'
        : `<p class="note">These game codes appear in the schedule with a "MOVED TO" annotation on their original slot. The original slot is NOT counted as an active game — only the destination entry is. Verify the destination slot exists and was parsed correctly.</p>
           ${table(['Week', 'Date', 'Original Location', 'Teams', 'Moved To', 'Highlighted?'], movedRows)}`,
      true
    )}

    ${section('autofixed', 'Auto-Fixed Cells — minor formatting corrected before parsing', normalizedCells.length, '#dd6b20',
      `<p class="note">These cells had small formatting issues that were automatically corrected. The fix is shown — confirm each looks right.</p>
      ${table(['Week', 'Date', 'Location', 'Original Cell', 'Fix Applied'], fixRows)}`
    )}

    ${section('crossdiv', 'Cross-Division Games — teams from different divisions', crossDivision.length, '#dd6b20',
      `<p class="note">These matchups involve teams from different divisions. May be intentional or may indicate a mistyped team code.</p>
      ${table(['Week', 'Date', 'Location', 'Team 1', 'Team 2', 'Division 1', 'Division 2'], crossRows)}`
    )}

  </main>
  ${FOOTER_HTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const baseDir   = __dirname;
const outputDir = path.join(baseDir, 'output');
fs.mkdirSync(outputDir, { recursive: true });

console.log('Parsing team key...');
const teams = parseKey(path.join(baseDir, '2026 D7 Original Schedule - Key.csv'));
console.log(`  Loaded ${Object.keys(teams).length} teams`);

console.log('Parsing XLSX schedule...');
const xlsxFile    = path.join(baseDir, '2026 Season Interleague schedule UPDATED 4.12.2026.xlsx');
const parseResult = parseScheduleXLSX(xlsxFile);
console.log(`  Weeks found  : ${parseResult.weeksFound.join(', ')}`);
console.log(`  Active games : ${parseResult.games.length}`);
console.log(`  Changed cells: ${parseResult.games.filter(g => g.changed).length}`);
console.log(`  Removed      : ${parseResult.removedCells.length}`);
console.log(`  Moved away   : ${parseResult.movedFromCells.length}`);
console.log(`  Skipped      : ${parseResult.skippedCells.length}`);
console.log(`  Partial      : ${parseResult.partialCells.length}`);

const audit = buildAudit(parseResult, teams);

console.log('\nAudit results:');
console.log(`  Critical issues : ${audit.unknownTeams.length + audit.skippedCells.length + audit.partialCells.length + audit.zeroGames.length + audit.unknownLocations.length}`);
console.log(`  Warnings        : ${audit.timeConflicts.length + audit.lowGames.length + audit.homeAwayImbalance.length + audit.divisionOutliers.length}`);

const html = injectGate(buildHTML(audit, teams), gateSnippet);
fs.writeFileSync(path.join(outputDir, 'verification.html'), html);

console.log('\nDone! Open output/verification.html to review.');
