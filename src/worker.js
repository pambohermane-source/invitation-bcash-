// BCEG · Lancement B-Cash — Worker : invitation (fichiers statiques) + enregistrement des réponses.
// Routes : POST/GET /api/rsvp · GET /api/export?key= · GET /admin?key= · le reste = fichiers de /public

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const m = request.method;
    if (pathname === '/api/rsvp') {
      if (m === 'POST') return rsvpPost(request, env);
      if (m === 'GET') return rsvpGet(env);
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (pathname === '/api/export' && m === 'GET') return exportCsv(request, env);
    if ((pathname === '/admin' || pathname === '/admin/') && m === 'GET') return adminPage(request, env);
    return env.ASSETS.fetch(request);
  }
};

// Outils partagés : lecture de toutes les réponses + contrôle d'accès admin.

async function allRsvps(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.RSVP.list({ prefix: 'rsvp:', cursor });
    const vals = await Promise.all(page.keys.map(k => env.RSVP.get(k.name, 'json')));
    out.push(...vals.filter(Boolean));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.creeLe || '').localeCompare(b.creeLe || ''));
}

async function authorized(request, env) {
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!key) return false;
  if (env.ADMIN_KEY && key === env.ADMIN_KEY) return true;
  if (!env.ADMIN_HASH) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === env.ADMIN_HASH;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// POST /api/rsvp — enregistre (ou met à jour) la réponse d'un invité dans Cloudflare KV.
// Liaison KV requise : variable « RSVP » (Settings › Bindings du projet Pages).

const FIELDS = ['ref', 'presence', 'civilite', 'nom', 'nomCarton', 'fonction',
  'structure', 'telephone', 'email', 'accompagnant', 'appareil'];

// GET /api/rsvp — diagnostic : ouvrez cette adresse dans le navigateur pour vérifier la configuration.
async function rsvpGet(env) {
  return json({
    service: 'OK — la fonction est bien déployée',
    stockage: env.RSVP ? 'OK — KV « RSVP » relié' : 'MANQUANT — reliez le KV avec le nom de variable RSVP, puis redéployez',
    admin: (env.ADMIN_KEY || env.ADMIN_HASH) ? 'OK — code admin défini' : 'MANQUANT'
  });
}

async function rsvpPost(request, env) {
  try {
    if (!env.RSVP) return json({ ok: false, error: 'KV non configuré' }, 500);
    const body = await request.json();

    const d = {};
    for (const k of FIELDS) d[k] = String(body[k] ?? '').trim().slice(0, 200);
    if (!/^BC-[A-Z0-9]{4}$/.test(d.ref)) return json({ ok: false, error: 'Référence invalide' }, 400);
    if (d.nom.length < 3) return json({ ok: false, error: 'Nom manquant' }, 400);
    if (d.telephone.replace(/\D/g, '').length < 8) return json({ ok: false, error: 'Téléphone invalide' }, 400);

    const key = 'rsvp:' + d.ref;
    const prev = await env.RSVP.get(key, 'json');
    d.creeLe = prev?.creeLe || new Date().toISOString();
    d.modifieLe = new Date().toISOString();
    d.pays = request.cf?.country || '';

    await env.RSVP.put(key, JSON.stringify(d));
    return json({ ok: true, updated: !!prev });
  } catch (e) {
    return json({ ok: false, error: 'Requête invalide' }, 400);
  }
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

// GET /api/export?key=VOTRE_CLE — télécharge la liste des invités (CSV lisible par Excel).

const COLS = [
  ['N° invitation', 'ref'], ['Réponse', 'presence'], ['Civilité', 'civilite'], ['Nom', 'nom'],
  ['Nom sur carton', 'nomCarton'], ['Fonction', 'fonction'], ['Institution', 'structure'],
  ['Téléphone', 'telephone'], ['E-mail', 'email'], ['Accompagnant(e)', 'accompagnant'],
  ['Reçu le', 'creeLe'], ['Modifié le', 'modifieLe']
];

async function exportCsv(request, env) {
  if (!(await authorized(request, env))) return new Response('Accès refusé', { status: 401 });
  const rows = await allRsvps(env);
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;          // pas de formules
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [COLS.map(c => cell(c[0])).join(';')];
  for (const r of rows) lines.push(COLS.map(([, k]) => cell(r[k])).join(';'));
  // BOM UTF-8 + séparateur « ; » pour un affichage correct dans Excel (français)
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="invites-lancement-b-cash.csv"'
    }
  });
}

// GET /admin?key=VOTRE_CLE — tableau de bord des confirmations.

async function adminPage(request, env) {
  if (!(await authorized(request, env))) {
    return new Response('<!doctype html><meta charset=utf-8><body style="background:#070A07;color:#A6AA9E;font-family:system-ui;display:grid;place-items:center;height:100vh">Accès réservé.</body>',
      { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const key = new URL(request.url).searchParams.get('key');
  const rows = (await allRsvps(env)).reverse();
  const yes = rows.filter(r => r.presence.startsWith('Présent'));
  const plus = yes.filter(r => r.accompagnant).length;
  const fmt = iso => iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Libreville', dateStyle: 'short', timeStyle: 'short' }) : '';

  const tr = rows.map(r => `<tr>
    <td><span class="pill ${r.presence.startsWith('Présent') ? 'ok' : 'no'}">${r.presence.startsWith('Présent') ? 'Présent' : 'Absent'}</span></td>
    <td><b>${esc(r.nomCarton)}</b>${r.accompagnant ? `<div class="sub">+ ${esc(r.accompagnant)}</div>` : ''}</td>
    <td>${esc(r.fonction)}${r.structure ? `<div class="sub">${esc(r.structure)}</div>` : ''}</td>
    <td>${esc(r.telephone)}${r.email ? `<div class="sub">${esc(r.email)}</div>` : ''}</td>
    <td class="mono">${esc(r.ref)}</td><td class="sub">${fmt(r.modifieLe)}</td></tr>`).join('');

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirmations · Lancement B-Cash</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600&family=Sora:wght@300;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;background:#070A07;color:#E9ECE4;font-family:Manrope,system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 18px 60px}
h1{font-family:Sora;font-weight:600;letter-spacing:-.03em;margin:0;font-size:26px}.eb{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#A6AA9E}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:22px 0}
.k{background:#121811;border:1px solid rgba(166,170,158,.14);border-radius:18px;padding:16px}.k b{display:block;font-family:Sora;font-weight:300;font-size:34px;letter-spacing:-.04em;margin-top:6px}
.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
input{flex:1;min-width:200px;height:44px;border-radius:14px;border:1px solid rgba(166,170,158,.2);background:#0d120c;color:#E9ECE4;padding:0 14px;font-size:15px}
a.btn{height:44px;display:inline-flex;align-items:center;padding:0 18px;border-radius:14px;background:#B9E07A;color:#0B1006;font-weight:600;text-decoration:none}
.tbl{overflow:auto;border:1px solid rgba(166,170,158,.14);border-radius:18px;background:#0c110b}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:760px}th{text-align:left;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#A6AA9E;padding:12px 14px;border-bottom:1px solid rgba(166,170,158,.14)}
td{padding:12px 14px;border-bottom:1px solid rgba(166,170,158,.08);vertical-align:top}.sub{color:#A6AA9E;font-size:12px;margin-top:2px}.mono{font-family:ui-monospace,monospace;font-size:12px;color:#A6AA9E}
.pill{font-size:11px;font-weight:600;padding:4px 9px;border-radius:99px}.ok{background:rgba(185,224,122,.15);color:#B9E07A}.no{background:rgba(166,170,158,.12);color:#A6AA9E}
</style></head><body><div class="wrap">
<div class="eb">BCEG · Lancement B-Cash</div><h1>Confirmations</h1>
<div class="kpis">
  <div class="k"><span class="eb">Réponses</span><b>${rows.length}</b></div>
  <div class="k"><span class="eb">Présents</span><b>${yes.length}</b></div>
  <div class="k"><span class="eb">Accompagnants</span><b>${plus}</b></div>
  <div class="k"><span class="eb">Cartons à imprimer</span><b>${yes.length + plus}</b></div>
  <div class="k"><span class="eb">Absents</span><b>${rows.length - yes.length}</b></div>
</div>
<div class="bar"><input id="q" placeholder="Rechercher un nom, une institution…"><a class="btn" href="/api/export?key=${encodeURIComponent(key)}">Télécharger (Excel)</a></div>
<div class="tbl"><table><thead><tr><th>Réponse</th><th>Nom sur carton</th><th>Fonction</th><th>Contact</th><th>N°</th><th>Mis à jour</th></tr></thead>
<tbody id="tb">${tr || '<tr><td colspan="6" class="sub" style="padding:28px;text-align:center">Aucune réponse pour le moment.</td></tr>'}</tbody></table></div>
</div><script>
document.getElementById('q').addEventListener('input',e=>{const v=e.target.value.toLowerCase();document.querySelectorAll('#tb tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(v)?'':'none')});
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
