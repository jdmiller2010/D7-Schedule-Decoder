// Shared config helpers — env loading and optional password gate injection
// Used by generate-schedules.js and generate-verification.js

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// .env loader (no external dependencies)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return {};
  const result = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Returns SHA-256 hex of the SITE_PASSWORD from .env, or null if not set
// ---------------------------------------------------------------------------
function getPasswordHash() {
  const env = loadEnv();
  const pw  = env.SITE_PASSWORD || process.env.SITE_PASSWORD || '';
  if (!pw) return null;
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// ---------------------------------------------------------------------------
// Returns the password-gate overlay HTML+script to inject into every page,
// or '' if no password is configured.
// ---------------------------------------------------------------------------
function passwordGateSnippet(hash) {
  if (!hash) return '';
  return `
<div id="pw-gate" style="position:fixed;inset:0;background:#1a202c;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
  <div style="background:white;border-radius:12px;padding:2em 2.5em;text-align:center;max-width:320px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
    <div style="margin-bottom:0.5em;display:flex;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41.853493 43.774906" width="64" height="64"><g transform="translate(-90.222916,-114.82916)"><g transform="matrix(1.1555538,0,0,1.1555538,78.426853,97.349589)"><g transform="matrix(0.49727409,0,0,0.49727409,-19.810891,-97.191323)"><path style="fill:#00053d;fill-opacity:1;stroke:none" d="m 60.367188,234.01172 c -10e-7,10.54232 0,21.08463 0,31.62695 12.133051,12.13778 24.269449,24.27222 36.404296,36.40821 12.143206,-12.1361 24.289556,-24.26904 36.431636,-36.40626 0,-13.25781 10e-6,-26.51562 0,-39.77343 -24.27864,0 -48.557287,0 -72.835932,0 0,2.71484 -10e-7,5.42968 0,8.14453 z"/><path d="m 68.51081,234.01103 v 28.25554 l 28.261782,28.26179 28.286758,-28.26179 v -28.25554 z m 56.54854,28.25554 v -28.25554 z" style="fill:#00053d;fill-opacity:1;stroke:#ce153f;stroke-width:3.71828;stroke-opacity:1"/></g><text style="font-weight:900;font-size:9.2471px;font-family:sans-serif;text-anchor:middle;fill:#ffffff" x="28.146749" y="32.846935">D7</text><text style="font-weight:900;font-size:2.876px;font-family:sans-serif;text-anchor:middle;fill:#ffffff" x="28" y="38.5">OREGON</text></g></g></svg></div>
    <h2 style="margin:0 0 0.3em;color:#1a202c;font-size:1.15em">District 7 — 2026 Schedule</h2>
    <p style="color:#718096;font-size:0.85em;margin:0 0 1.25em">Enter the password to view</p>
    <input id="pw-input" type="password" placeholder="Password"
      style="width:100%;padding:0.55em 0.75em;border:2px solid #e2e8f0;border-radius:6px;font-size:0.95em;margin-bottom:0.75em;outline:none;box-sizing:border-box"
      onfocus="this.style.borderColor='#68d391'" onblur="this.style.borderColor='#e2e8f0'">
    <button onclick="d7CheckPw()"
      style="width:100%;padding:0.6em;background:#276749;color:white;border:none;border-radius:6px;font-size:0.95em;font-weight:600;cursor:pointer">
      Enter
    </button>
    <p id="pw-error" style="color:#e53e3e;font-size:0.82em;margin:0.6em 0 0;visibility:hidden">Incorrect password — try again</p>
  </div>
</div>
<script>
// Pure-JS SHA-256 — works on HTTP (no Web Crypto required)
function d7sha256(msg){
  var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
         0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
         0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
         0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
         0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
         0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
         0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
         0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  function rr(n,d){return(n>>>d)|(n<<(32-d));}
  // UTF-8 encode
  var utf=unescape(encodeURIComponent(msg)),len=utf.length,bytes=[],i,t;
  for(i=0;i<len;i++)bytes.push(utf.charCodeAt(i));
  bytes.push(0x80);
  while(bytes.length%64!==56)bytes.push(0);
  var bl=len*8;
  bytes.push(0,0,0,0,(bl>>>24)&0xff,(bl>>>16)&0xff,(bl>>>8)&0xff,bl&0xff);
  for(var off=0;off<bytes.length;off+=64){
    var w=[];
    for(t=0;t<16;t++)w[t]=(bytes[off+t*4]<<24)|(bytes[off+t*4+1]<<16)|(bytes[off+t*4+2]<<8)|bytes[off+t*4+3];
    for(t=16;t<64;t++){var s0=rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3),s1=rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);w[t]=(w[t-16]+s0+w[t-7]+s1)|0;}
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(t=0;t<64;t++){
      var S1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^(~e&g),t1=(h+S1+ch+K[t]+w[t])|0;
      var S0=rr(a,2)^rr(a,13)^rr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(S0+maj)|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
  }
  var hex='';for(i=0;i<8;i++)hex+=('00000000'+(H[i]>>>0).toString(16)).slice(-8);
  return hex;
}
(function(){
  var HASH='${hash}',KEY='d7_auth_2026';
  if(sessionStorage.getItem(KEY)===HASH){document.getElementById('pw-gate').style.display='none';return;}
  document.getElementById('pw-input').addEventListener('keydown',function(e){if(e.key==='Enter')d7CheckPw();});
  setTimeout(function(){document.getElementById('pw-input').focus();},50);
})();
window.d7CheckPw=function(){
  var inp=document.getElementById('pw-input'),err=document.getElementById('pw-error');
  var hex=d7sha256(inp.value);
  if(hex==='${hash}'){sessionStorage.setItem('d7_auth_2026',hex);document.getElementById('pw-gate').style.display='none';}
  else{err.style.visibility='visible';inp.value='';inp.focus();}
};
</script>`;
}

// ---------------------------------------------------------------------------
// Inject the gate snippet just before </body> in an HTML string
// ---------------------------------------------------------------------------
function injectGate(html, snippet) {
  if (!snippet) return html;
  return html.replace('</body>', snippet + '\n</body>');
}

// ---------------------------------------------------------------------------
// Shared SVG logo (inline, no external file dependency)
// ---------------------------------------------------------------------------
const D7_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41.853493 43.774906" width="80" height="84"><g transform="translate(-90.222916,-114.82916)"><g transform="matrix(1.1555538,0,0,1.1555538,78.426853,97.349589)"><g transform="matrix(0.49727409,0,0,0.49727409,-19.810891,-97.191323)"><path style="fill:#00053d;fill-opacity:1;stroke:none" d="m 60.367188,234.01172 c -10e-7,10.54232 0,21.08463 0,31.62695 12.133051,12.13778 24.269449,24.27222 36.404296,36.40821 12.143206,-12.1361 24.289556,-24.26904 36.431636,-36.40626 0,-13.25781 10e-6,-26.51562 0,-39.77343 -24.27864,0 -48.557287,0 -72.835932,0 0,2.71484 -10e-7,5.42968 0,8.14453 z"/><path d="m 68.51081,234.01103 v 28.25554 l 28.261782,28.26179 28.286758,-28.26179 v -28.25554 z m 56.54854,28.25554 v -28.25554 z" style="fill:#00053d;fill-opacity:1;stroke:#ce153f;stroke-width:3.71828;stroke-opacity:1"/></g><text style="font-weight:900;font-size:9.2471px;font-family:sans-serif;text-anchor:middle;fill:#ffffff" x="28.146749" y="32.846935">D7</text><text style="font-weight:900;font-size:2.876px;font-family:sans-serif;text-anchor:middle;fill:#ffffff" x="28" y="38.5">OREGON</text></g></g></svg>`;

// ---------------------------------------------------------------------------
// Shared nav bar
// prefix = '' for root pages, '../' for pages one level deep (teams/, locations/)
// active = 'home' | 'coaches' | 'verify'
// ---------------------------------------------------------------------------
function navBar(prefix, active) {
  const tabs = [
    { id: 'home',    label: 'Home',         href: `${prefix}index.html` },
    { id: 'coaches', label: 'Coaches',      href: `${prefix}coaches.html` },
    { id: 'verify',  label: 'Verification', href: `${prefix}verification.html` },
  ];
  const logo = `<a href="${prefix}index.html" class="nav-logo" aria-label="Home">${D7_LOGO_SVG}</a>`;
  const links = tabs.map(t =>
    `<a href="${t.href}" class="nav-tab${t.id === active ? ' nav-active' : ''}">${t.label}</a>`
  ).join('');
  const disclaimer = `<span class="nav-disclaimer">Provided as-is &mdash; no warranty. Schedule subject to change.</span>`;
  return `<nav class="nav-bar">${logo}${links}${disclaimer}</nav>`;
}

// Shared page title CSS — use <h1 class="page-title"> and <p class="page-subtitle">
const PAGE_HEADER_CSS = `
  h1.page-title { font-size: 1.7em; margin: 0.6em 0 0.15em; color: #1a202c; }
  p.page-subtitle { color: #718096; font-size: 0.9em; margin: 0 0 1.25em; }`;

// Shared nav-bar CSS (paste into any page's <style> block)
const NAV_CSS = `
  .nav-bar { display: flex; align-items: center; background: #1a202c; padding: 0 1em;
             position: sticky; top: 0; z-index: 100; overflow: visible;
             box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
  .nav-logo { display: flex; align-items: flex-start; padding: 0.25em 0.75em 0 0;
              text-decoration: none; align-self: flex-start; margin-bottom: -24px; }
  .nav-logo svg { display: block; }
  .nav-tab { color: rgba(255,255,255,0.65); text-decoration: none;
             padding: 0.75em 1.1em; font-size: 0.88em; font-weight: 500;
             border-bottom: 3px solid transparent; transition: color 0.15s; white-space: nowrap; }
  .nav-tab:hover { color: white; }
  .nav-active { color: white !important; border-bottom-color: #68d391; }
  .nav-disclaimer { margin-left: auto; font-size: 0.85em; color: rgba(255,255,255,0.65);
                    white-space: nowrap; padding-right: 0.5em; }
  @media (max-width: 700px) {
    .nav-bar { padding: 0 0.5em; }
    .nav-logo { padding-right: 0.4em; margin-bottom: -20px; }
    .nav-logo svg { width: 42px; height: 44px; }
    .nav-tab { padding: 0.75em 0.7em; font-size: 0.82em; }
    .nav-disclaimer { display: none; }
  }`;

// ---------------------------------------------------------------------------
// Shared footer
// ---------------------------------------------------------------------------
const FOOTER_CSS = `
  .site-footer { background: #1a202c; color: rgba(255,255,255,0.45); font-size: 0.75em;
                 padding: 1em 2em; display: flex; flex-wrap: wrap; gap: 0.4em 2em;
                 align-items: center; margin-top: 3em; }
  .site-footer a { color: rgba(255,255,255,0.55); text-decoration: none; }
  .site-footer a:hover { color: white; }
  .site-footer .sep { color: rgba(255,255,255,0.2); }`;

const FOOTER_HTML = `
  <footer class="site-footer">
    <span>&copy; 2026 StratLeague. All rights reserved.</span>
    <span class="sep">&middot;</span>
    <span>Contact: Jordan Miller &mdash; <a href="mailto:jdmiller2010@gmail.com">jdmiller2010@gmail.com</a></span>
  </footer>`;

module.exports = { loadEnv, getPasswordHash, passwordGateSnippet, injectGate, navBar, NAV_CSS, PAGE_HEADER_CSS, FOOTER_HTML, FOOTER_CSS };
