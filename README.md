# D7 Schedule Decoder

Converts the 2026 District 7 Inter-League master schedule (CSV files exported from Excel) into human-readable HTML documents — one per team and one per field location — with an optional password gate for public hosting.

## Output

Run the generators and open `output/index.html` in any browser to browse everything.

| File/Folder | Contents |
|---|---|
| `output/index.html` | Landing page — all teams grouped by division, all locations |
| `output/teams/` | One HTML file per team |
| `output/locations/` | One HTML file per field/location |
| `output/verification.html` | Data audit report — flags edge cases and errors |

### Team schedules (`output/teams/`)

Each file shows:
- Team name, division, manager name, phone, and email (with clickable links)
- Full season schedule table: date, time, Home/Away, opponent name + manager contact info, field
- Download CSV button to export the schedule to Excel or Google Sheets

### Location schedules (`output/locations/`)

Each file shows all games at that field across all 8 weeks, with visiting and home teams, their managers' contact info, division, date, and time.

---

## Scheduling Rules

### Game times

| Day | Default start time |
|---|---|
| Monday – Friday | **6:00 PM** |
| Saturday | Listed explicitly (see below) |

Saturday double-headers are scheduled for **12:30 PM** (game 1) and **3:00 PM** (game 2). A small number of Saturdays have a game at **9:00 AM** — this is noted in the schedule.

> If both managers agree to start a Saturday double-header earlier than 12:30 PM, that is allowed. Be sure to give families enough advance notice to plan accordingly.

### Team order — Visiting vs. Home

In every game code, **the visiting (away) team is listed first and the home team is listed second.**

Example: `B7-4` means **B7 is visiting, B4 is at home.**

This matters for:
- Scheduling home field use
- Rainout calls (see below)
- Scorekeeping conventions

### Rainouts

Rainouts are called by **the home team** prior to game time, or by **the umpire** at game time.

When a game is rained out, **both managers are responsible for rescheduling** the game using the season schedule and available field slots. Contact your opposing manager to agree on a makeup date, then confirm field availability.

---

## Data Notes (Verification Report)

The verification report (`output/verification.html`) audits all 8 weeks of CSV data and flags:

| Check | What it catches |
|---|---|
| **Skipped cells** | Cells with content but no parseable game code — likely a typo |
| **Partial cells** | At least one game was found but a broken code remnant was also present — a second game may be missing |
| **Auto-fixed** | Minor formatting issues corrected automatically (e.g. `9;00` → `9:00`, `A 1` → `A1`, `--` → `-`) |
| **Unknown teams** | A team code in the schedule doesn't match any team in the key |
| **Cross-division** | Two teams from different divisions matched up — may be intentional or a typo |
| **Time conflicts** | Two games assigned to the same field, same date, and same time |
| **Zero-game teams** | A team in the key has no appearances in any week |
| **Low game count** | A team has 3 or fewer games scheduled |
| **Game count by division** | Per-division breakdown with median and outliers flagged |

### Known issues (2026 schedule)

| Week | Date | Location | Issue |
|---|---|---|---|
| 8 | June 7 (Sat) | Turner City Field | Cell `C3-6 12:30 C-3 3:00` — `C-3` is a broken team code; the 3:00 PM game may be missing. Likely a typo for `C6-3`. |
| 5 | May 16 (Sat) | Judson MS #2 | Cell contained `9;00` (semicolon) — auto-corrected to `9:00 AM`. Verify this game time is intentional. |
| 7 | May 26 (Tue) | Judson MS #2 | `A 1-10` (space in team code) — auto-corrected to `A1-10`. |
| 2 | April 21 (Tue) | Holland Youth Park #1 | `E8--2` (double dash) — auto-corrected to `E8-2`. |
| 7 or 8 | — | — | 1 time conflict detected — two games at the same field at the same time. See verification report for details. |
| — | — | — | 1 team has zero games scheduled across all 8 weeks. See verification report for details. |

---

## Running Locally

Node.js and npm are required.

```bash
# Install dependencies (first time only)
npm install

# Regenerate all HTML output from the CSVs
npm run generate

# Start the local dev server (serves output/ at http://localhost:3000)
npm run dev
```

The dev server is powered by [Vite](https://vite.dev) and serves the `output/` directory. Open `http://localhost:3000` in your browser after starting it.

If you update any CSV files, re-run `npm run generate` before refreshing the browser.

### Running the generators individually

```bash
# Schedules only
node generate-schedules.js

# Verification report only
node generate-verification.js
```

Both scripts read from the CSV files in the root directory and write to `output/`.

---

## Password Gate

When `SITE_PASSWORD` is set in `.env`, every generated page shows a login overlay before displaying any content. The password is hashed client-side (SHA-256) and compared against the hash baked into the HTML — no server required. Once entered correctly the session is remembered for the browser tab.

To disable the gate, leave `SITE_PASSWORD` blank or remove it from `.env`.

---

## Deploying to S3

The site is a folder of static HTML files and can be hosted on any static host. AWS S3 + CloudFront is the recommended setup.

### First-time setup

```bash
# Create and configure the S3 bucket for static website hosting
npm run setup-s3
```

### Deploy

```bash
npm run deploy
```

This syncs `output/` to the configured S3 bucket (via `aws s3 sync`). Requires the AWS CLI to be installed and configured with appropriate credentials.

### Configuration (`.env`)

Copy `.env.example` to `.env` and fill in your values:

```
SITE_PASSWORD=your-secret-password   # Leave blank to disable the login gate
S3_BUCKET=your-bucket-name           # Must be globally unique
AWS_REGION=us-east-1                 # Region where the bucket lives
```

> **Never commit `.env`** — it contains your site password and AWS bucket details. It is listed in `.gitignore`.

---

## Sensitive Data & `.gitignore`

The following are excluded from version control:

| Excluded | Why |
|---|---|
| `.env` | Contains site password and AWS credentials |
| `2026 D7 Original Schedule - Key.csv` | Contains manager PII: names, phone numbers, and email addresses |
| `output/` | Generated HTML embeds manager contact info from the Key file |
| `node_modules/` | Installed dependencies — restored with `npm install` |

The week CSV files (Week 1–8) contain only game codes and field/date data — no PII — and are safe to commit if you want to track schedule changes in git.

---

## Source Data

| File | Contents |
|---|---|
| `2026 D7 Original Schedule - Key.csv` | Master team list: team names, numbers, managers, phone, email — organized by division |
| `2026 D7 Original Schedule - Week 1.csv` | April 13–18 |
| `2026 D7 Original Schedule - Week 2.csv` | April 20–25 |
| `2026 D7 Original Schedule - Week 3.csv` | April 27 – May 2 |
| `2026 D7 Original Schedule - Week 4.csv` | May 4–9 |
| `2026 D7 Original Schedule - Week 5.csv` | May 11–16 |
| `2026 D7 Original Schedule - Week 6.csv` | May 18–23 |
| `2026 D7 Original Schedule - Week 7.csv` | May 25–30 |
| `2026 D7 Original Schedule - Week 8.csv` | June 1–6 |

### CSV structure

**Key file** rows follow the pattern `Team Name, Team#, Manager, Phone, Email` under division header rows.

**Week files** are a grid: rows = field locations, columns = days of the week (Monday–Saturday). Each cell contains one or more game codes.

### Game code format

```
[VisitingTeam]-[HomeTeam] [optional time]
```

- Team codes are a letter prefix (division) followed by a number, e.g. `B7`, `F12`
- The **letter identifies the division** (A = 3A Baseball, B = Major Baseball, C = 50/70 Baseball, D = JR Baseball, E = 2A Softball, F = 3A Softball, G = Major Softball, H = JR Softball)
- Multiple games in the same cell are separated by spaces (and sometimes newlines), each with their own optional time

Example cell: `D6-3 12:30 D3-6 3:00` → two games at that field on that day:
1. D6 visiting D3 at 12:30 PM
2. D3 visiting D6 at 3:00 PM

### Division key

| Prefix | Division |
|---|---|
| A | 3A Player Pitch Baseball |
| B | Major Baseball |
| C | 50/70 Baseball |
| D | JR Baseball |
| E | 2A Softball |
| F | 3A Softball |
| G | Major Softball |
| H | JR Softball |
