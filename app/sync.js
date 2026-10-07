// 담임의 노트 — 여러 컴퓨터 동기화 (Firebase: 이메일 로그인 + Firestore, REST 직접 호출)
//
// 번들의 저장 래퍼(Et)가 localStorage 를 그대로 읽고 쓰고, 이 스크립트는
//   · 로그인 화면
//   · 앱 시작 시 서버 → 이 브라우저로 내려받기 (Et.get 은 api.ready 를 기다림)
//   · 변경된 키를 서버로 올리기 (Et.set/del 이 api.touch/remove 를 호출)
// 만 담당합니다. 충돌은 "나중에 저장한 쪽이 이김"(키 단위)입니다.
// config.js 가 비어 있으면 아무것도 하지 않습니다.
(function () {
  'use strict';

  var cfg = window.CM_SYNC_CONFIG || {};
  var noop = function () {};
  var api = { enabled: false, ready: Promise.resolve(), touch: noop, remove: noop };
  window.cmSync = api;
  if (!cfg.apiKey || !cfg.projectId) return;
  api.enabled = true;

  // 엔드포인트 (테스트용으로 config.js 에서 바꿀 수 있음)
  var IDENTITY = cfg.identityUrl || 'https://identitytoolkit.googleapis.com';
  var SECURETOKEN = cfg.tokenUrl || 'https://securetoken.googleapis.com';
  var FIRESTORE = cfg.firestoreUrl || 'https://firestore.googleapis.com';
  var DB = 'projects/' + cfg.projectId + '/databases/(default)/documents';
  var PREFIXES = ['students:', 'seating:', 'grades:', 'relations:', 'counsel:'];
  var SESSION_KEY = 'cmsync:session';
  var META_KEY = 'cmsync:meta';

  var session = null;
  var meta = readJSON(META_KEY) || {};
  meta.user = meta.user || null;
  meta.ts = meta.ts || {};     // 키 → 마지막 수정 시각(ms)
  meta.dirty = meta.dirty || {}; // 키 → 'set' | 'del' (서버에 아직 반영 안 됨)

  function readJSON(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.error('sync: 저장 실패', k, e); }
  }
  function saveMeta() { writeJSON(META_KEY, meta); }
  function isSynced(key) {
    for (var i = 0; i < PREFIXES.length; i++) if (key.indexOf(PREFIXES[i]) === 0) return true;
    return false;
  }
  function localKeys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (isSynced(k)) out.push(k);
    }
    return out;
  }
  // Postgres jsonb 는 키 순서를 바꿔 돌려주므로, 문자열이 아니라 내용으로 비교한다.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  function sameAsLocal(raw, value) {
    if (raw === null) return false;
    try { return canon(JSON.parse(raw)) === canon(value); } catch (e) { return false; }
  }
  function fail(kind, msg) { var e = new Error(msg || kind); e.kind = kind; return e; }

  // ───────────── 인증 ─────────────
  function setSession(j) {
    session = {
      access_token: j.idToken || j.id_token,
      refresh_token: j.refreshToken || j.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (parseInt(j.expiresIn || j.expires_in, 10) || 3600),
      user: { id: j.localId || j.user_id, email: j.email || (session && session.user.email) || '' }
    };
    writeJSON(SESSION_KEY, session);
  }
  function clearSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  async function http(url, opts) {
    try { return await fetch(url, opts); } catch (e) { throw fail('net', '네트워크 오류'); }
  }
  async function errorCode(r) {
    try { return ((await r.json()).error || {}).message || ''; } catch (e) { return ''; }
  }
  async function signIn(email, password) {
    var r = await http(IDENTITY + '/v1/accounts:signInWithPassword?key=' + encodeURIComponent(cfg.apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
    });
    if (!r.ok) {
      var code = await errorCode(r);
      if (r.status >= 500) throw fail('net', '서버 오류');
      if (/TOO_MANY_ATTEMPTS/.test(code)) throw fail('auth', '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
      if (/API_KEY|PROJECT|CONFIGURATION_NOT_FOUND|OPERATION_NOT_ALLOWED/.test(code)) throw fail('auth', '로그인 설정 오류입니다 (' + code + '). Firebase 설정을 확인하세요.');
      throw fail('auth', '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    setSession(await r.json());
  }
  var refreshing = null;
  function refresh() {
    if (!refreshing) {
      refreshing = (async function () {
        var r = await http(SECURETOKEN + '/v1/token?key=' + encodeURIComponent(cfg.apiKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(session.refresh_token)
        });
        if (r.status === 400 || r.status === 401 || r.status === 403) throw fail('auth', '세션 만료');
        if (!r.ok) throw fail('net', '서버 오류');
        setSession(await r.json());
      })().then(function () { refreshing = null; }, function (e) { refreshing = null; throw e; });
    }
    return refreshing;
  }
  async function accessToken() {
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    return session.access_token;
  }

  // ───────────── Firestore ─────────────
  // 문서 경로: users/{uid}/kv/{키}  필드: value(JSON 문자열), updatedAt(ms)
  // 문서 ID 에는 ':' 대신 '~' 를 쓴다 (키에는 '~' 가 없음)
  function docPath(key) { return DB + '/users/' + session.user.id + '/kv/' + key.replace(':', '~'); }
  async function fs(method, path, body, keepalive) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var r = await http(FIRESTORE + '/v1/' + path, {
        method: method,
        headers: { Authorization: 'Bearer ' + (await accessToken()), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        keepalive: !!keepalive
      });
      if (r.status === 401 && attempt === 0) { await refresh(); continue; }
      if (r.status === 401) throw fail('auth', '인증 실패');
      if (r.status === 403 || r.status === 404) throw fail('server', 'Firestore 권한/설정 오류 ' + r.status);
      if (!r.ok) throw fail('net', '서버 응답 ' + r.status);
      return r;
    }
  }
  async function fetchRows() {
    var rows = [], token = '';
    do {
      var r = await fs('GET', DB + '/users/' + session.user.id + '/kv?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      var j;
      try { j = await r.json(); } catch (e) { throw fail('net', '응답 해석 실패'); }
      (j.documents || []).forEach(function (d) {
        var f = d.fields || {};
        try {
          rows.push({
            key: d.name.split('/').pop().replace('~', ':'),
            value: JSON.parse((f.value || {}).stringValue),
            ts: parseInt((f.updatedAt || {}).integerValue, 10) || 0
          });
        } catch (e) { /* 해석할 수 없는 문서는 무시 */ }
      });
      token = j.nextPageToken || '';
    } while (token);
    return rows;
  }

  // 서버 → 이 브라우저. apply=false 면 반영 없이 "바뀐 게 있는지"만 돌려준다.
  async function pull(apply) {
    var rows = await fetchRows();
    rows = rows.filter(function (row) { return isSynced(row.key); });

    var remote = {};
    rows.forEach(function (row) { remote[row.key] = row; });
    var firstOnDevice = meta.user !== session.user.id;

    // 이 컴퓨터에서 처음 로그인하는데 양쪽에 다른 내용이 있으면 사용자에게 묻는다.
    var remoteWins = true;
    if (apply && firstOnDevice) {
      var conflicts = rows.filter(function (row) {
        var cur = localStorage.getItem(row.key);
        return cur !== null && !sameAsLocal(cur, row.value);
      });
      if (conflicts.length) {
        remoteWins = confirm(
          '이 컴퓨터에 저장된 자료와 서버의 자료가 서로 다릅니다 (' + conflicts.length + '건).\n\n' +
          '[확인] 서버 자료로 덮어씁니다 (이 컴퓨터 자료는 사라짐)\n' +
          '[취소] 이 컴퓨터 자료를 서버에 올립니다 (서버 자료는 덮어써짐)'
        );
      }
    }

    var changed = false;
    rows.forEach(function (row) {
      var rts = row.ts;
      var cur = localStorage.getItem(row.key);
      if (meta.dirty[row.key] && (meta.ts[row.key] || 0) > rts) return; // 이 컴퓨터 쪽이 더 최신 → 곧 올림
      if (firstOnDevice && cur !== null && !sameAsLocal(cur, row.value) && !remoteWins) {
        if (apply) { meta.dirty[row.key] = 'set'; meta.ts[row.key] = Date.now(); }
        return;
      }
      if (!sameAsLocal(cur, row.value)) {
        changed = true;
        if (apply) localStorage.setItem(row.key, JSON.stringify(row.value));
      }
      if (apply) { meta.ts[row.key] = rts; delete meta.dirty[row.key]; }
    });

    if (apply) {
      if (firstOnDevice) {
        // 서버에 없는 이 컴퓨터의 기존 자료는 첫 로그인 때 올린다.
        localKeys().forEach(function (k) {
          if (!remote[k] && !meta.dirty[k]) { meta.dirty[k] = 'set'; meta.ts[k] = Date.now(); }
        });
      }
      meta.user = session.user.id;
      saveMeta();
    }
    return changed;
  }

  // 이 브라우저 → 서버
  var flushing = false, flushAgain = false, flushTimer = null;
  function schedule() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flush(false); }, 800);
    setStatus('pending');
  }
  async function flush(keepalive) {
    if (!session) return;
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    try {
      var keys = Object.keys(meta.dirty);
      if (!keys.length) { if (currentStatus === 'pending') setStatus('ok'); return; }
      var sent = {}, writes = [];
      keys.forEach(function (k) {
        sent[k] = meta.ts[k];
        var raw = localStorage.getItem(k);
        if (meta.dirty[k] === 'del' || raw === null) { writes.push({ delete: docPath(k) }); return; }
        writes.push({ update: { name: docPath(k), fields: {
          value: { stringValue: raw },
          updatedAt: { integerValue: String(meta.ts[k] || Date.now()) }
        } } });
      });
      for (var i = 0; i < writes.length; i += 400) {
        await fs('POST', DB + ':commit', { writes: writes.slice(i, i + 400) }, keepalive);
      }
      keys.forEach(function (k) { if (meta.ts[k] === sent[k]) delete meta.dirty[k]; });
      saveMeta();
      setStatus(Object.keys(meta.dirty).length ? 'pending' : 'ok');
    } catch (e) {
      setStatus(e.kind === 'auth' ? 'auth' : e.kind === 'server' ? 'server' : 'offline');
      clearTimeout(flushTimer);
      flushTimer = setTimeout(function () { flush(false); }, 30000);
    } finally {
      flushing = false;
      if (flushAgain) { flushAgain = false; schedule(); }
    }
  }

  api.touch = function (key) {
    if (!session || !isSynced(key)) return;
    meta.ts[key] = Date.now();
    meta.dirty[key] = 'set';
    saveMeta();
    schedule();
  };
  api.remove = function (key) {
    if (!session || !isSynced(key)) return;
    meta.ts[key] = Date.now();
    meta.dirty[key] = 'del';
    saveMeta();
    schedule();
  };

  // ───────────── UI ─────────────
  var css = document.createElement('style');
  css.textContent =
    '#cm-login{position:fixed;inset:0;z-index:99999;background:#F2ECDD;display:flex;align-items:center;justify-content:center;font-family:"Noto Serif KR","Apple SD Gothic Neo","Malgun Gothic",serif;color:#1C1410}' +
    '#cm-login form{width:340px;max-width:90vw;background:#FBF7EB;border:1px solid #D8C8AD;border-radius:2px;padding:28px}' +
    '#cm-login h1{margin:0 0 4px;font-size:22px}' +
    '#cm-login p{margin:0 0 18px;font-size:12px;color:#8A7560}' +
    '#cm-login label{display:block;font-size:11px;color:#8A7560;margin:10px 0 4px}' +
    '#cm-login input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #D8C8AD;border-radius:2px;background:#fff;font-size:14px}' +
    '#cm-login button{width:100%;margin-top:18px;padding:10px;border:0;border-radius:2px;background:#A04025;color:#fff;font-size:14px;cursor:pointer}' +
    '#cm-login button:disabled{opacity:.6;cursor:default}' +
    '#cm-login .err{min-height:16px;margin-top:10px;font-size:12px;color:#A04025}' +
    '#cm-badge{position:fixed;right:12px;bottom:10px;z-index:9999;display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:11px;background:#FBF7EB;border:1px solid #D8C8AD;border-radius:999px;color:#443328;font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif}' +
    '#cm-badge button{border:0;background:none;color:#A04025;cursor:pointer;font-size:11px;padding:0}' +
    '#cm-stale{position:fixed;left:0;right:0;top:0;z-index:99998;padding:8px 12px;text-align:center;font-size:13px;background:#A04025;color:#fff;font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif}' +
    '#cm-stale button{margin-left:10px;padding:2px 10px;border:1px solid #fff;border-radius:2px;background:none;color:#fff;cursor:pointer}' +
    '@media print{#cm-badge,#cm-stale{display:none!important}}';
  document.head.appendChild(css);

  var STATUS_TEXT = {
    ok: '☁ 동기화됨',
    pending: '☁ 저장 중…',
    offline: '☁ 오프라인 — 연결되면 자동 저장',
    auth: '☁ 다시 로그인이 필요합니다',
    server: '☁ 서버 설정 오류 — Firestore 규칙을 확인하세요'
  };
  var badge = null;
  function ensureBadge() {
    if (badge) return;
    badge = document.createElement('div');
    badge.id = 'cm-badge';
    badge.className = 'no-print';
    badge.innerHTML = '<span id="cm-badge-text"></span><button type="button" title="이 컴퓨터에서 로그아웃">로그아웃</button>';
    badge.querySelector('button').onclick = logout;
    document.body.appendChild(badge);
  }
  var currentStatus = '';
  function setStatus(s) {
    if (!session) return;
    currentStatus = s;
    ensureBadge();
    badge.querySelector('#cm-badge-text').textContent = (session.user.email || '') + ' · ' + STATUS_TEXT[s];
  }

  function showLogin(message) {
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.id = 'cm-login';
      box.innerHTML =
        '<form><h1>담임의 노트</h1><p>여러 컴퓨터에서 같은 자료를 쓰려면 로그인하세요.</p>' +
        '<label>이메일</label><input type="email" name="email" autocomplete="username" required>' +
        '<label>비밀번호</label><input type="password" name="password" autocomplete="current-password" required>' +
        '<div class="err"></div><button type="submit">로그인</button></form>';
      var form = box.querySelector('form'), err = box.querySelector('.err'), btn = box.querySelector('button');
      err.textContent = message || '';
      form.onsubmit = async function (ev) {
        ev.preventDefault();
        btn.disabled = true; err.textContent = '';
        try {
          await signIn(form.email.value.trim(), form.password.value);
          box.remove();
          resolve();
        } catch (e) {
          err.textContent = e.kind === 'net' ? '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.' : e.message;
          btn.disabled = false;
        }
      };
      (document.body || document.documentElement).appendChild(box);
      form.email.focus();
    });
  }

  function showStale() {
    if (document.getElementById('cm-stale')) return;
    var bar = document.createElement('div');
    bar.id = 'cm-stale';
    bar.className = 'no-print';
    bar.innerHTML = '다른 컴퓨터에서 자료가 변경되었습니다.<button type="button">새로고침</button>';
    bar.querySelector('button').onclick = function () { location.reload(); };
    document.body.appendChild(bar);
  }

  async function logout() {
    await flush(false);
    if (Object.keys(meta.dirty).length &&
        !confirm('서버에 저장되지 않은 변경이 있습니다. 그래도 로그아웃하면 이 변경은 사라집니다. 계속할까요?')) return;
    if (!confirm('로그아웃하면 이 컴퓨터에 저장된 학급 자료가 삭제됩니다 (서버에는 남아 있습니다). 계속할까요?')) return;
    localKeys().forEach(function (k) { localStorage.removeItem(k); });
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  }

  // ───────────── 시작 ─────────────
  async function recheck() {
    if (!session) return;
    try {
      await flush(false);
      if (await pull(false)) showStale();
      setStatus(Object.keys(meta.dirty).length ? 'pending' : 'ok');
    } catch (e) {
      if (e.kind === 'auth' || e.kind === 'server') setStatus(e.kind);
    }
  }

  api.ready = (async function () {
    session = readJSON(SESSION_KEY);
    if (!document.body) await new Promise(function (r) { document.addEventListener('DOMContentLoaded', r); });
    var message = '', bootFailed = false;
    for (;;) {
      if (!session) { await showLogin(message); message = ''; }
      try {
        await pull(true);
        break;
      } catch (e) {
        if (e.kind === 'auth') { clearSession(); message = '로그인이 만료되었습니다. 다시 로그인하세요.'; continue; }
        setStatus(e.kind === 'server' ? 'server' : 'offline'); // 연결 불가 → 이 컴퓨터에 있는 자료로 시작, 나중에 자동 저장
        bootFailed = true;
        break;
      }
    }
    if (!bootFailed) setStatus(Object.keys(meta.dirty).length ? 'pending' : 'ok');
    flush(false);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') recheck(); else flush(true);
    });
    window.addEventListener('pagehide', function () { flush(true); });
    window.addEventListener('online', recheck);
    setInterval(recheck, 5 * 60 * 1000);
  })();
})();
