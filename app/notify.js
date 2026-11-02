// 담임의 노트 — 일정 알림 (선택)
// '일정·공지' 화면의 일정(schedule:<반> 키의 events)을 보고 브라우저 알림을 띄웁니다.
// 설정은 기기마다 따로 저장됩니다(localStorage 'cm-notify', 동기화하지 않음).
// 서버 푸시가 없으므로 앱(탭)이 열려 있거나 백그라운드에 살아 있을 때만 알림이 울립니다.
//
//  - 하루 요약: 설정한 시각(기본 08:00)이 지난 뒤 처음 확인할 때, 오늘 일정이 있으면 한 번 알림
//  - 시간 알림: 시간이 적힌 일정은 그 시각 N분 전(기본 30분)에 한 번 알림 (이미 지난 일정은 건너뜀)
//  - 일정마다 '알림' 체크를 끄면 그 일정은 알림에서 빠집니다.
(function () {
  'use strict';
  var KEY = 'cm-notify';
  var SENT = 'cm-notify-sent';
  var DEFAULTS = { on: false, daily: '08:00', lead: 30 };
  var listeners = [];

  function read(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toMin(hm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  function supported() { return typeof window.Notification !== 'undefined'; }
  function permission() { return supported() ? Notification.permission : 'unsupported'; }

  function get() {
    var s = read(KEY, {});
    return {
      on: !!s.on,
      daily: typeof s.daily === 'string' ? s.daily : DEFAULTS.daily,
      lead: typeof s.lead === 'number' ? s.lead : DEFAULTS.lead
    };
  }
  function set(patch) {
    var s = Object.assign(get(), patch || {});
    write(KEY, s);
    listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
    check();
    return s;
  }

  // 켜기: 권한을 요청하고, 허용되면 on=true 로 저장. 결과 권한 문자열을 돌려준다.
  async function enable() {
    if (!supported()) return 'unsupported';
    var p = Notification.permission;
    if (p === 'default') {
      try { p = await Notification.requestPermission(); } catch (e) { p = Notification.permission; }
    }
    if (p === 'granted') set({ on: true });
    return p;
  }
  function disable() { set({ on: false }); }

  async function show(title, body, tag) {
    var opts = { body: body, tag: tag, icon: 'icon-192.png', badge: 'icon-192.png', lang: 'ko' };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        var reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, opts);
        return true;
      }
    } catch (e) {}
    try { new Notification(title, opts); return true; } catch (e) { return false; }
  }

  function test() {
    return show('담임의 노트 알림', '알림이 이렇게 표시돼요.', 'cm-test');
  }

  // 모든 반의 일정 모으기
  function allEvents() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('schedule:') !== 0) continue;
      var cls = k.slice(9);
      var v = read(k, null);
      var evs = v && Array.isArray(v.events) ? v.events : [];
      evs.forEach(function (ev) {
        if (ev && ev.date && ev.title && ev.remind !== false) out.push({ cls: cls, ev: ev });
      });
    }
    out.sort(function (a, b) {
      return ((a.ev.time || '') + a.cls).localeCompare((b.ev.time || '') + b.cls, 'ko', { numeric: true });
    });
    return out;
  }

  function label(x) { return x.cls + '반 · ' + (x.ev.time ? x.ev.time + ' ' : '') + x.ev.title; }

  var checking = false;
  async function check() {
    var s = get();
    if (!s.on || permission() !== 'granted' || checking) return;
    checking = true;
    try {
      if (window.cmSync && window.cmSync.ready) { try { await window.cmSync.ready; } catch (e) {} }
      var now = new Date();
      var today = ymd(now);
      var nowMin = now.getHours() * 60 + now.getMinutes();
      var sent = read(SENT, {});
      var changed = false;
      var todays = allEvents().filter(function (x) { return x.ev.date === today; });

      // 1) 하루 요약
      var dailyMin = toMin(s.daily);
      var dkey = 'daily:' + today;
      if (dailyMin !== null && nowMin >= dailyMin && !sent[dkey]) {
        if (todays.length) {
          var lines = todays.slice(0, 6).map(label);
          if (todays.length > 6) lines.push('외 ' + (todays.length - 6) + '건');
          await show('오늘 일정 ' + todays.length + '건', lines.join('\n'), 'cm-daily');
        }
        sent[dkey] = Date.now(); changed = true;
      }

      // 2) 시간 알림 (N분 전)
      var lead = Math.max(0, s.lead | 0);
      for (var i = 0; i < todays.length; i++) {
        var x = todays[i];
        var at = toMin(x.ev.time);
        if (at === null) continue;
        var key = 'ev:' + x.ev.id + ':' + x.ev.date + 'T' + x.ev.time;
        if (sent[key]) continue;
        if (nowMin >= at - lead && nowMin <= at) {
          var left = at - nowMin;
          await show((left > 0 ? left + '분 뒤 일정' : '지금 일정') + ' · ' + x.cls + '반',
            x.ev.time + ' ' + x.ev.title + (x.ev.content ? '\n' + x.ev.content : ''), 'cm-ev-' + x.ev.id);
          sent[key] = Date.now(); changed = true;
        } else if (nowMin > at) {
          sent[key] = Date.now(); changed = true; // 이미 지난 일정: 늦게 울리지 않도록 표시만
        }
      }

      if (changed) {
        var cutoff = Date.now() - 3 * 864e5; // 3일 지난 기록 정리
        Object.keys(sent).forEach(function (k) { if (sent[k] < cutoff) delete sent[k]; });
        write(SENT, sent);
      }
    } finally {
      checking = false;
    }
  }

  window.cmNotify = {
    get: get,
    set: set,
    enable: enable,
    disable: disable,
    test: test,
    check: check,
    supported: supported,
    permission: permission,
    subscribe: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    }
  };

  setInterval(check, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('load', function () { setTimeout(check, 1500); });
})();
