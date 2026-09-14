// ==UserScript==
// @name         图书馆座位快速选座助手（河工职大 · 超星座位）
// @namespace    hbcit.seat.quick
// @version      1.4.8
// @description  高频座位空窗速览 + 一键预选到官方“提交”前；只读取数据、只帮你选好，提交与验证码永远由本人完成。电脑端(Chrome/Edge+Tampermonkey)与安卓端(Kiwi/Firefox+Tampermonkey)同一份脚本。
// @match        *://office.chaoxing.com/front/third/apps/seat/*
// @match        *://*.chaoxing.com/front/third/apps/seat/*
// @match        *://os.hbcit.edu.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 合规边界（写死，请勿修改）：
 * 1) 只做 GET/只读查询与“预选”，绝不自动调用 data/apps/seat/submit；
 * 2) 不做后台轮询/定时抢座，数据只在打开面板或手动点“刷新”时拉取；
 * 3) 不绕过验证码(captcha)与易盾风控(wyToken)——最后一步由本人点“提交”并完成验证；
 * 4) 仅在本人已登录的官方页面上下文运行，同源请求，自动携带登录态，不收集、不上传任何数据。
 */
(function () {
  'use strict';
  if (window.__seatQuickLoaded) return;
  window.__seatQuickLoaded = true;

  /* ---------------- M0 学校门户(os.hbcit.edu.cn)：一键直达座位预约 ---------------- */
  var PortalJump = (function () {
    var AUTO_KEY = 'seatQuick.portalAuto';
    var SEAT_URL = 'https://office.chaoxing.com/front/third/apps/seat/list?deptIdEnc=087075e03ab2e001';
    function autoOn() { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { return false; } }
    function isPortalHome() {
      var p = location.pathname.replace(/\/+$/, '');
      return p === '' || p === '/' || p === '/index' || p === '/mobile';
    }
    function mount() {
      if (!isPortalHome()) return;
      if (autoOn()) { location.replace(SEAT_URL); return; }  // 自动模式：替换历史，返回键不会循环
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;right:12px;bottom:78px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:flex-end;font-family:inherit;';
      var go = document.createElement('button');
      go.textContent = '⚡ 座位预约 一键直达';
      go.style.cssText = 'border:none;background:#2563eb;color:#fff;border-radius:22px;padding:12px 18px;font-size:14.5px;font-weight:700;box-shadow:0 4px 14px rgba(37,99,235,.4);cursor:pointer;';
      go.onclick = function () { location.href = SEAT_URL; };
      var sw = document.createElement('button');
      function syncSw() { sw.textContent = '门户自动跳转：' + (autoOn() ? '开' : '关'); }
      sw.style.cssText = 'border:1px solid #cbd5e1;background:rgba(255,255,255,.94);color:#475569;border-radius:16px;padding:6px 12px;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);';
      sw.onclick = function () {
        try { localStorage.setItem(AUTO_KEY, autoOn() ? '0' : '1'); } catch (e) {}
        syncSw();
        sw.title = autoOn() ? '已开启：一进门户首页自动跳到座位预约' : '已关闭：点上方按钮手动直达';
      };
      syncSw();
      box.appendChild(go); box.appendChild(sw);
      function attach() { document.body.appendChild(box); }
      if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
    }
    return { mount: mount, SEAT_URL: SEAT_URL };
  })();
  if (/^os\.hbcit\.edu\.cn$/i.test(location.hostname)) { PortalJump.mount(); return; }

  /* ---------------- M1 数据层 ---------------- */
  var ROOMS = [
    { id: 11226, name: '2F-24h借阅空间', short: '24h' },
    { id: 12818, name: '2F-阅览区', short: '2F' },
    { id: 12819, name: '3F-阅览区', short: '3F' },
    { id: 12820, name: '4F-阅览区', short: '4F' }
  ];
  var ROOMSHORT = { 11226: '24h', 12818: '2F', 12819: '3F', 12820: '4F' };
  var STORE_KEY = 'seatQuick.favs.v1';
  var PENDING_KEY = 'sq.pending';
  var CHAIN_KEY = 'sq.chain';        // 分段连约计划（跨页面跳转保留）
  var AUTO_KEY = 'seatQuick.autoOpen'; // 进入座位页是否自动展开面板（默认开，'0'=关）
  var DEFAULT_FID = '087075e03ab2e001';

  function getFid() {
    try {
      var u = new URL(location.href);
      return u.searchParams.get('fidEnc') || u.searchParams.get('deptIdEnc') || DEFAULT_FID;
    } catch (e) { return DEFAULT_FID; }
  }
  function ymd(offset) {
    var d = new Date(); d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  var Data = (function () {
    var cache = {};
    function roomInfo(roomId, day) {
      var key = roomId + '@' + day;
      if (cache[key]) return Promise.resolve(cache[key]);
      var body = new URLSearchParams({ id: String(roomId), toDay: day, fidEnc: getFid(), queryReserve: 'true' });
      return fetch('/data/apps/seat/room/info', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.success) throw new Error('room/info 失败 ' + roomId);
        cache[key] = j.data; return j.data;
      });
    }
    // 全量座位号清单（getdrawseat，按天不变化可长期缓存）
    function drawSeats(roomId) {
      var key = 'draw' + roomId;
      if (cache[key]) return Promise.resolve(cache[key]);
      return fetch('/data/apps/seat/getdrawseat?id=' + roomId, { credentials: 'include' })
        .then(function (r) { return r.json(); }).then(function (j) {
          var arr = Array.isArray(j.data) ? j.data : Object.values(j.data || {});
          var nums = arr.map(function (x) { return String(x.seatNum); }).filter(Boolean);
          cache[key] = nums; return nums;
        }).catch(function () { return []; });
    }
    function allRooms(day) {
      return Promise.all(ROOMS.map(function (rm) {
        return Promise.all([
          roomInfo(rm.id, day).catch(function () { return null; }),
          drawSeats(rm.id)
        ]).then(function (pair) { return { rm: rm, d: pair[0], seats: pair[1] }; });
      }));
    }
    function clear(day) {
      Object.keys(cache).forEach(function (k) { if (!day || k.indexOf('@' + day) === k.length - day.length - 1) delete cache[k]; });
    }
    return { roomInfo: roomInfo, allRooms: allRooms, clear: clear };
  })();

  /* ---------------- M2 计算层 ---------------- */
  var Calc = (function () {
    function toMin(ts) { var d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); }
    // 返回某座位某天的分段/空窗/最长可约
    function detail(data, seatNum, day, serverNowMs) {
      var st = (data.seatRoom && data.seatRoom.seatSpecialTime) || {};
      var wk = ['sun', 'mon', 'tues', 'wed', 'thur', 'fri', 'sat'][new Date(day + 'T00:00:00').getDay()];
      var ss = st[wk + 'StartTime'] || '08:00', se = st[wk + 'EndTime'] || '21:00';
      var os = +ss.split(':')[0] * 60 + (+ss.split(':')[1]);
      var oe = +se.split(':')[0] * 60 + (+se.split(':')[1]);
      var isToday = new Date(serverNowMs).toDateString() === new Date(day + 'T00:00:00').toDateString();
      var lo = os;
      if (isToday) { var n = new Date(serverNowMs); lo = Math.max(lo, n.getHours() * 60 + n.getMinutes()); }
      // 占用表 key 各房间格式不一（2F为“224”，24h房间为补零“054”），三种形式都查
      var occMap = data.groupedReservesMap || {};
      var occRaw = occMap[String(seatNum)] || occMap[String(Number(seatNum))] ||
        occMap[String(seatNum).padStart(3, '0')] || [];
      var raw = occRaw
        .map(function (s) { return [toMin(s.startTime), toMin(s.endTime)]; })
        .sort(function (a, b) { return a[0] - b[0]; });
      var merged = [];
      raw.forEach(function (x) {
        if (merged.length && x[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], x[1]);
        else merged.push(x.slice());
      });
      var segs = [], cur = os;
      if (lo > os) segs.push({ s: os, e: lo, kind: 'past' });
      var c2 = lo;
      merged.forEach(function (x) {
        if (x[0] > c2) segs.push({ s: c2, e: Math.min(x[0], oe), kind: 'free' });
        segs.push({ s: Math.max(x[0], c2), e: Math.min(x[1], oe), kind: 'occ' });
        c2 = Math.max(c2, x[1]);
      });
      if (c2 < oe) segs.push({ s: c2, e: oe, kind: 'free' });
      var unit = (data.seatConfig && data.seatConfig.timeUnit) || 60;
      var min1 = (data.seatConfig && data.seatConfig.minReserveDuration * 60) || 60;
      // 可约空段：今天时把起点向上取整到下一个整点（预约按整点粒度）
      var wins = segs.filter(function (s) { return s.kind === 'free' && s.e > s.s; }).map(function (s) {
        var start = s.s;
        if (isToday && start % unit !== 0) start = Math.ceil(start / unit) * unit;
        return [start, s.e];
      }).filter(function (w) { return w[1] > w[0]; });
      var bookable = wins.filter(function (w) { return w[1] - w[0] >= min1; });
      var longest = bookable.reduce(function (m, w) { return Math.max(m, w[1] - w[0]); }, 0);
      var status = 'full';
      if (bookable.length) {
        status = (!isToday && bookable.length === 1 && bookable[0][0] <= os + 1 && bookable[0][1] === oe) ? 'allFree' : 'partial';
      }
      function hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
      return {
        os: os, oe: oe, segs: segs, bookable: bookable, longest: longest, status: status, isToday: isToday,
        bookableTxt: bookable.map(function (w) { return hm(w[0]) + '-' + hm(w[1]); }),
        longestTxt: longest >= 60 ? (Math.floor(longest / 60) + 'h' + (longest % 60 ? longest % 60 + 'm' : '')) : '—'
      };
    }
    // 解析房间开放时间/占用，供 detail 与 blocks 复用
    function roomBasis(data, seatNum, day, serverNowMs) {
      var st = (data.seatRoom && data.seatRoom.seatSpecialTime) || {};
      var wk = ['sun', 'mon', 'tues', 'wed', 'thur', 'fri', 'sat'][new Date(day + 'T00:00:00').getDay()];
      var ss = st[wk + 'StartTime'] || '08:00', se = st[wk + 'EndTime'] || '21:00';
      var os = +ss.split(':')[0] * 60 + (+ss.split(':')[1] || 0);
      var oe = +se.split(':')[0] * 60 + (+se.split(':')[1] || 0);
      var isToday = new Date(serverNowMs).toDateString() === new Date(day + 'T00:00:00').toDateString();
      var nn = new Date(serverNowMs), nowMin = nn.getHours() * 60 + nn.getMinutes();
      var occMap = data.groupedReservesMap || {};
      var occRaw = occMap[String(seatNum)] || occMap[String(Number(seatNum))] ||
        occMap[String(seatNum).padStart(3, '0')] || [];
      var merged = [];
      occRaw.map(function (s) { return [toMin(s.startTime), toMin(s.endTime)]; })
        .sort(function (a, b) { return a[0] - b[0]; })
        .forEach(function (x) {
          if (merged.length && x[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], x[1]);
          else merged.push(x.slice());
        });
      return { os: os, oe: oe, isToday: isToday, nowMin: nowMin, merged: merged,
        unit: (data.seatConfig && data.seatConfig.timeUnit) || 60 };
    }
    function hmMin(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
    // 逐小时时间块：past=已过 occ=被占 free=可选（与官方时间栏同源）
    function blocks(data, seatNum, day, serverNowMs) {
      var B = roomBasis(data, seatNum, day, serverNowMs), out = [];
      var overlap = function (a, b) { return a[1] > b[0] && b[1] > a[0]; };
      for (var t = B.os; t < B.oe; t += B.unit) {
        var blk = [t, Math.min(t + B.unit, B.oe)];
        var state = 'free';
        if (B.merged.some(function (m) { return overlap(blk, m); })) state = 'occ';
        // 与官方一致：今天只能从“下一个整点”开始，当前小时及之前的块一律不可选
        else if (B.isToday && blk[0] < Math.ceil(B.nowMin / B.unit) * B.unit) state = 'past';
        out.push({ s: blk[0], e: blk[1], label: hmMin(blk[0]) + '-' + hmMin(blk[1]), state: state });
      }
      return out;
    }
    return { detail: detail, blocks: blocks };
  })();

  /* ---------------- M3 本地收藏 ---------------- */
  var Store = (function () {
    var DEFAULTS = [];   // 不预置任何座位，首次使用为空，由使用者自行“点选添加/手输添加”高频座位
    function load() {
      try { var a = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(a) ? a : DEFAULTS.slice(); }
      catch (e) { return DEFAULTS.slice(); }
    }
    function save(a) { localStorage.setItem(STORE_KEY, JSON.stringify(a)); }
    function add(room, num) {
      num = String(num).padStart(3, '0'); room = Number(room);
      var a = load();
      if (a.some(function (x) { return x.room === room && x.num === num; })) return false;
      a.push({ room: room, num: num }); save(a); return true;
    }
    function remove(room, num) {
      num = String(num).padStart(3, '0'); room = Number(room);
      save(load().filter(function (x) { return !(x.room === room && x.num === num); }));
    }
    return { load: load, add: add, remove: remove };
  })();

  /* ---------------- M3.5 分区（无电区：内置号段 + 使用者自定义座位） ---------------- */
  var NP_KEY = 'seatQuick.noPower.v1';
  var BUILTIN_ZONES = [
    { room: 12818, from: 169, to: 211, name: '无电区' }  // 2F阅览区 169-211 号为无电座（两端含）
  ];
  var NoPower = (function () {
    function loadSet() {
      try { var a = JSON.parse(localStorage.getItem(NP_KEY)); return Array.isArray(a) ? a.slice() : []; }
      catch (e) { return []; }
    }
    function key(room, num) { return Number(room) + ':' + String(num).padStart(3, '0'); }
    function list() { return loadSet(); }
    function has(room, num) { return loadSet().indexOf(key(room, num)) >= 0; }
    function add(room, nums) {
      var a = loadSet(); var added = 0;
      nums.forEach(function (n) {
        var k = key(room, n); if (a.indexOf(k) < 0) { a.push(k); added++; }
      });
      try { localStorage.setItem(NP_KEY, JSON.stringify(a)); } catch (e) {}
      return added;
    }
    function remove(k) {
      try { localStorage.setItem(NP_KEY, JSON.stringify(loadSet().filter(function (x) { return x !== k; }))); } catch (e) {}
    }
    return { list: list, has: has, add: add, remove: remove, key: key };
  })();
  // 返回 {name,custom:false内置/true自定义} 或 null
  function zoneOf(room, num) {
    var n = Number(num);
    for (var i = 0; i < BUILTIN_ZONES.length; i++) {
      var z = BUILTIN_ZONES[i];
      if (Number(room) === z.room && n >= z.from && n <= z.to) return { name: z.name, custom: false };
    }
    if (NoPower.has(room, num)) return { name: '无电区', custom: true };
    return null;
  }
  function isNoPower(room, num) { return !!zoneOf(room, num); }

  /* ---------------- M5 一键预选（只选不交） ---------------- */
  var Preselect = (function () {
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function getVM() {
      var el = null;
      try { el = [].slice.call(document.querySelectorAll('*')).filter(function (e) { return e.__vue__; })[0]; } catch (e) {}
      return el ? el.__vue__ : null;
    }
    function selectUrl(room, day) {
      var f = getFid();
      return '/front/third/apps/seat/select?deptIdEnc=' + f + '&id=' + room + '&day=' + day + '&backLevel=2&fidEnc=' + f;
    }
    // 在官方页面内驱动其原生选择链：choseTime -> confirmTime(1) -> choseSeat，停在“提交”
    async function drive(seatNum, winText) {
      var vm = getVM();
      if (!vm) return { err: '页面未就绪' };
      var P = function (n) { return String(n).padStart(2, '0'); };
      var maxDur = (vm.seatConfig && vm.seatConfig.reserveDuration) || 4;
      var sh = +winText.split('-')[0].split(':')[0], eh = +winText.split('-')[1].split(':')[0];
      if (eh - sh > maxDur) eh = sh + maxDur;                 // 单次不超过上限
      var sb = P(sh) + ':00-' + P(sh + 1) + ':00';
      var eb = P(eh - 1) + ':00-' + P(eh) + ':00';
      var i1 = vm.dynamicTimes.findIndex(function (t) { return t.time === sb; });
      var i2 = vm.dynamicTimes.findIndex(function (t) { return t.time === eb; });
      if (i1 < 0 || i2 < 0) return { err: '该时段不可选：' + sb + ' ~ ' + eb };
      // 同页之前已选过别的时段：官方组件没有复位方法，手动清掉已选状态，避免把新点击当成“结束时间”
      if (vm.dynamicChosedseTimes && vm.dynamicChosedseTimes.length) {
        (vm.dynamicTimes || []).forEach(function (b) { if (b.cls !== 'noSelect') b.cls = ''; });
        vm.dynamicChosedseTimes = [];
        vm.dynamicChosedTimeInfo = { startTime: '', endTime: '', duration: '' };
        vm.chosedTimeInfo = null; vm.chosedSeatNum = ''; vm.dynamicSeatNums = [];
        await sleep(60);
      }
      vm.choseTime(vm.dynamicTimes[i1], i1);
      if (i2 !== i1) vm.choseTime(vm.dynamicTimes[i2], i2); // 单块(1h)只点一次，重复点会取消
      vm.confirmTime(1);
      for (var i = 0; i < 60; i++) { await sleep(100); if (vm.chosedTimeInfo && vm.chosedTimeInfo.startTime) break; }
      for (var j = 0; j < 60; j++) { if ((vm.dynamicSeatNums || []).length) break; await sleep(100); }
      var arr = vm.dynamicSeatNums || [];
      var si = arr.findIndex(function (x) { return x.seatNum === seatNum; });
      if (si < 0) return { err: '列表中没有该座位' };
      // 可约判据以 drawSeatList.reserveStatus 为准：0=可约，-1=该时段已被约/不可选
      var drawn = (vm.drawSeatList || []).find(function (x) { return x.seatNum === seatNum; });
      if (drawn && drawn.reserveStatus !== 0) return { err: '该座位此时段刚被约走，请换一个空段' };
      vm.choseSeat(arr[si], si); await sleep(200);
      var verify = await openVerify();   // 直接弹出官方安全验证界面，由本人完成
      return { ok: true, seat: vm.chosedSeatNum, start: vm.chosedTimeInfo.startTime, end: vm.chosedTimeInfo.endTime, verify: verify };
    }
    // 面板点空段：同房同天直接在当前页驱动（不刷新）；楼层/日期/页面不对就写 pending 自动跳过去续选
    function go(room, num, win, day) {
      var u = new URL(location.href);
      var hereRoom = Number(u.searchParams.get('id')), hereDay = u.searchParams.get('day');
      if (/\/seat\/select/.test(location.pathname) && hereRoom === Number(room) && hereDay === day) {
        return drive(num, win);
      }
      goNav(room, num, win, day);
      return Promise.resolve({ navigating: true });
    }
    // 强制走“写 pending → 重新进入选座页”路径（用于连约第2段：官方组件无时间复位方法，刷新最稳）
    function goNav(room, num, win, day) {
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ room: Number(room), num: num, win: win, day: day })); } catch (e) {}
      location.href = selectUrl(room, day);
    }
    // 页面加载后若存在 pending，等 Vue 就绪自动执行
    async function runPending() {
      if (!/\/seat\/select/.test(location.pathname)) return;
      var pend = null;
      try { pend = JSON.parse(sessionStorage.getItem(PENDING_KEY)); } catch (e) {}
      if (!pend) return;
      var u = new URL(location.href);
      if (Number(u.searchParams.get('id')) !== Number(pend.room) || u.searchParams.get('day') !== pend.day) return;
      var vm = null;
      for (var i = 0; i < 80; i++) { vm = getVM(); if (vm && vm.dynamicTimes && vm.dynamicTimes.length) break; await sleep(200); }
      if (!vm) return;
      var r = await drive(pend.num, pend.win);
      try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
      // 若属于分段连约的第2段，推进连约阶段
      var chain = null;
      try { chain = JSON.parse(sessionStorage.getItem(CHAIN_KEY)); } catch (e2) {}
      if (r && r.ok) {
        if (chain && Number(chain.room) === Number(pend.room) && chain.num === pend.num && chain.day === pend.day && chain.stage === 2) {
          chain.stage = 3;
          try { sessionStorage.setItem(CHAIN_KEY, JSON.stringify(chain)); } catch (e3) {}
          toast('第2段 ' + r.start + '-' + r.end + ' 已选好并弹出验证，请本人完成验证；两段都验证即连约完成');
        } else {
          toast('已为你选好 ' + pend.num + ' 号 ' + r.start + '-' + r.end + '，请在弹出的验证界面由本人完成');
        }
      } else if (r && r.err) toast('预选未完成：' + r.err);
    }
    return { go: go, goNav: goNav, runPending: runPending };
  })();

  // 选好座位后自动点官方“提交”，弹出安全验证界面（验证码仍由本人完成，脚本不碰 /submit）
  // 官方提交条刚渲染时点击可能被吞，这里以“验证码确实弹出”为准、有限重试
  function openVerify() {
    return new Promise(function (res) {
      var tries = 0, clicked = 0;
      var timer = setInterval(function () {
        tries++;
        var cap = document.querySelector('.u-captcha') || document.querySelector('.cx_comImageValidate');
        if (cap && cap.offsetWidth > 0) { clearInterval(timer); res(true); return; }
        var btn = document.querySelector('.order_submit');
        if (btn && btn.offsetParent !== null && clicked < 4) { btn.click(); clicked++; }
        if (tries > 50) { clearInterval(timer); res(false); }
      }, 150);
    });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483200;background:#111827;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;max-width:88vw;line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }

  /* ---------------- M6 选时自动确认 + 座位定位（时间→座位、座位→时间 两种顺序都支持） ---------------- */
  var Assist = (function () {
    var ASSIST_KEY = 'seatQuick.assist';
    var pendingSeat = null; // 先点座位、后选时间时记住的座位号
    function enabled() { try { return localStorage.getItem(ASSIST_KEY) !== '0'; } catch (e) { return true; } } // 默认开
    function setOn(v) { try { localStorage.setItem(ASSIST_KEY, v ? '1' : '0'); } catch (e) {} }
    function getVM() {
      var el = null;
      try { el = [].slice.call(document.querySelectorAll('*')).filter(function (e) { return e.__vue__; })[0]; } catch (e) {}
      return el ? el.__vue__ : null;
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    var pill = null;
    function hidePill() { if (pill) { pill.remove(); pill = null; } }
    function showPill(text, cb) {
      hidePill();
      pill = document.createElement('button');
      pill.id = 'sq-pill';
      pill.textContent = text;
      pill.style.cssText = 'position:fixed;right:14px;bottom:132px;z-index:2147483000;background:#16a34a;color:#fff;border:none;border-radius:22px;padding:9px 16px;font-size:13.5px;font-weight:700;box-shadow:0 4px 14px rgba(22,163,74,.4);cursor:pointer;';
      pill.onclick = cb;
      document.body.appendChild(pill);
    }
    async function waitTimeInfo(vm) {
      for (var i = 0; i < 60; i++) { await sleep(100); if (vm.chosedTimeInfo && vm.chosedTimeInfo.startTime) return true; }
      return false;
    }
    function clearPending() {
      pendingSeat = null;
      document.querySelectorAll('.seat-div.sq-pending-seat').forEach(function (d) { d.classList.remove('sq-pending-seat'); });
    }
    // 时间确认后，把先记住的座位自动选上
    function pickRemembered(vm) {
      var num = pendingSeat; if (!num) return;
      (async function () {
        for (var k = 0; k < 60; k++) { if ((vm.dynamicSeatNums || []).length) break; await sleep(100); }
        var arr = vm.dynamicSeatNums || [];
        var si = arr.findIndex(function (x) { return x.seatNum === num; });
        if (si < 0) { toast(num + ' 号在该时段不可选（可能刚被约走），请换一个座位'); clearPending(); return; }
        var drawn = (vm.drawSeatList || []).find(function (x) { return x.seatNum === num; });
        if (drawn && drawn.reserveStatus !== 0) { toast(num + ' 号该时段刚被约走，请换一个座位'); clearPending(); return; }
        vm.choseSeat(arr[si], si);
        clearPending(); hidePill();
        toast(num + ' 号已选好，正在弹出验证界面…');
        openVerify();
      })();
    }
    // 改选时间前清掉上一次“已确认”的状态（正在点选过程中不能清，否则开始块会被误清）
    function resetChoice(vm) {
      var had = vm.chosedTimeInfo && vm.chosedTimeInfo.startTime;
      if (!had) return;
      (vm.dynamicTimes || []).forEach(function (b) { if (b.cls !== 'noSelect') b.cls = ''; });
      vm.dynamicChosedseTimes = [];
      vm.dynamicChosedTimeInfo = { startTime: '', endTime: '', duration: '' };
      vm.chosedTimeInfo = null; vm.chosedSeatNum = ''; vm.dynamicSeatNums = [];
    }
    // 点了时间块之后：两块齐了自动点“确认时间”；只有一块给“确认1小时”浮钮
    function afterTimeClick() {
      sleep(220).then(async function () {
        var vm = getVM(); if (!vm || !enabled()) return;
        var n = (vm.dynamicChosedseTimes || []).length;
        var ready = vm.chosedTimeInfo && vm.chosedTimeInfo.startTime;
        if (ready) { hidePill(); return; }
        if (n >= 2) {
          hidePill();
          vm.confirmTime(1);
          if (await waitTimeInfo(vm)) { if (pendingSeat) pickRemembered(vm); else toast('时间已确认，在座位图上点你要的座位即可'); }
        } else if (n === 1) {
          showPill('✔ 确认就坐这1小时', function () {
            hidePill(); vm.confirmTime(1);
            waitTimeInfo(vm).then(function (ok) { if (ok) { if (pendingSeat) pickRemembered(vm); else toast('时间已确认，在座位图上点你要的座位即可'); } });
          });
        }
      });
    }
    // 座位定位：在官方座位图上闪烁并滚动到指定座位（只定位、不选座）
    function locate(roomId, num) {
      num = String(num).padStart(3, '0');
      var here = null, m = location.href.match(/[?&]id=(\d+)/);
      if (m) here = Number(m[1]);
      if (here != null && roomId && Number(roomId) !== here) { toast('当前不是' + (ROOMSHORT[roomId] || roomId) + '楼层，请先切到该楼层座位图'); return false; }
      var seat = null;
      [].slice.call(document.querySelectorAll('.seat-div')).some(function (d) {
        var el = d.querySelector('.seat-number');
        if (el && el.textContent.trim() === num) { seat = d; return true; }
        return false;
      });
      document.querySelectorAll('.seat-div.sq-locate').forEach(function (d) { d.classList.remove('sq-locate'); });
      if (!seat) { toast('当前座位图没找到 ' + num + ' 号'); return false; }
      seat.classList.add('sq-locate');
      try { seat.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      setTimeout(function () { seat.classList.remove('sq-locate'); }, 8000);
      return true;
    }
    function init() {
      document.addEventListener('click', function (e) {
        if (!enabled()) return;
        var vm = getVM(); if (!vm) return;
        var cell = e.target.closest && e.target.closest('.time_cell');
        if (cell && vm.timesShow) { resetChoice(vm); afterTimeClick(); return; }
        // 座位点击：时间已确认→走官方原生；时间没确认→先记住座位，选完时间自动补上
        var seat = e.target.closest && e.target.closest('.seat-div');
        if (seat) {
          var timeReady = vm.chosedTimeInfo && vm.chosedTimeInfo.startTime;
          if (timeReady) { clearPending(); setTimeout(openVerify, 350); return; }  // 官方选座后自动弹验证
          var numEl = seat.querySelector('.seat-number'); if (!numEl) return;
          e.preventDefault(); e.stopPropagation();
          var seatNum = numEl.textContent.trim();
          // 优先：弹出该座位的“可选时段”底部窗（v1.4.3，手机端点座位即选时段）
          var mRoom = location.href.match(/[?&]id=(\d+)/);
          if (mRoom && typeof window.__sqOpenPickerBySeat === 'function') {
            document.querySelectorAll('.seat-div.sq-pending-seat').forEach(function (d) { d.classList.remove('sq-pending-seat'); });
            seat.classList.add('sq-pending-seat');
            window.__sqOpenPickerBySeat(Number(mRoom[1]), seatNum);
            return;
          }
          document.querySelectorAll('.seat-div.sq-pending-seat').forEach(function (d) { d.classList.remove('sq-pending-seat'); });
          pendingSeat = seatNum;
          seat.classList.add('sq-pending-seat');
          toast('已记住 ' + pendingSeat + ' 号，现在去点开始+结束时间块，选完自动帮你选好');
        }
      }, true);
    }
    return { init: init, enabled: enabled, setOn: setOn, locate: locate, clearPending: clearPending };
  })();

  /* ---------------- M4 面板 UI ---------------- */
  var UI = (function () {
    var state = { day: 'tomorrow', target: 240, sort: 'longest', winS: null, winE: null, expanded: {},
      power: (function () { try { return localStorage.getItem('seatQuick.powerFilter') || 'all'; } catch (e) { return 'all'; } })() };
    function mount() {
      var old = document.getElementById('sq-root'); if (old) old.remove();
      var root = document.createElement('div'); root.id = 'sq-root';
      root.innerHTML =
        '<style>' +
        '#sq-root *{box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}' +
        '#sq-launch{position:fixed;right:14px;bottom:90px;z-index:2147483000;background:#2563eb;color:#fff;border:none;border-radius:24px;padding:10px 16px;font-size:14px;font-weight:600;box-shadow:0 4px 14px rgba(37,99,235,.4);cursor:pointer;}' +
        '#sq-panel{position:fixed;z-index:2147483001;background:#f4f6fb;display:none;flex-direction:column;overflow:hidden;right:12px;bottom:12px;width:380px;max-width:calc(100vw - 24px);height:76vh;max-height:720px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);}' +
        '#sq-root.sheet #sq-panel{left:0;right:0;bottom:0;width:100%;max-width:100%;height:82vh;border-radius:16px 16px 0 0;}' +
        '.sq-head{background:#2563eb;color:#fff;padding:10px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
        '.sq-head b{font-size:15px;}.sq-seg{display:flex;background:rgba(255,255,255,.22);border-radius:8px;overflow:hidden;}' +
        '.sq-seg button{border:none;background:transparent;color:#fff;padding:4px 12px;font-size:13px;cursor:pointer;}' +
        '.sq-seg button.on{background:#fff;color:#2563eb;font-weight:700;}' +
        '.sq-close{margin-left:auto;border:none;background:transparent;color:#fff;font-size:18px;cursor:pointer;line-height:1;}' +
        '.sq-tools{display:flex;gap:6px;align-items:center;padding:8px 10px;background:#fff;border-bottom:1px solid #e5e7eb;flex-wrap:wrap;}' +
        '.sq-tools select{font-size:12.5px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;}' +
        '.sq-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:12.5px;cursor:pointer;font-weight:600;}' +
        '.sq-btn.ghost{background:#fff;color:#2563eb;border:1px solid #2563eb;}' +
        '.sq-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 10px;}' +
        '.sq-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:9px 10px;margin-bottom:8px;}' +
        '.sq-card.full{opacity:.55;}.sq-row1{display:flex;align-items:center;gap:8px;margin-bottom:6px;}' +
        '.sq-no{font-weight:700;font-size:15px;}.sq-tag{font-size:11px;color:#64748b;}' +
        '.sq-badge{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600;white-space:nowrap;}' +
        '.sq-x{border:none;background:transparent;color:#94a3b8;font-size:16px;cursor:pointer;padding:0 2px;}' +
        '.sq-bar{display:flex;height:12px;border-radius:4px;overflow:hidden;background:#e5e7eb;}' +
        '.sq-bar i{display:block;height:100%;}.sq-free{background:#16a34a;}.sq-free2{background:#86efac;}.sq-occ,.sq-past{background:#e5e7eb;}' +
        '.sq-chips{margin-top:6px;display:flex;gap:5px;flex-wrap:wrap;}' +
        '.sq-chip{border:1px solid #bbf7d0;background:#f0fdf4;color:#15803d;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;}' +
        '.sq-chip:active{background:#16a34a;color:#fff;}.sq-none{color:#94a3b8;font-size:12px;}' +
        '.sq-add{display:flex;gap:6px;padding:8px 10px;background:#fff;border-top:1px solid #e5e7eb;}' +
        '.sq-add select,.sq-add input{font-size:13px;padding:6px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;}' +
        '.sq-add input{max-width:110px;}.sq-foot{padding:6px 10px;font-size:11px;color:#94a3b8;background:#fff;}' +
        '.sq-btn.on{background:#16a34a;border-color:#16a34a;color:#fff;}' +
        '#sq-picktip{display:none;background:#fef3c7;border-bottom:1px solid #fde68a;color:#92400e;font-size:12px;padding:7px 10px;line-height:1.45;}' +
        '#sq-chain{display:none;background:#eff6ff;border-bottom:1px solid #bfdbfe;color:#1e3a8a;font-size:12px;padding:8px 10px;line-height:1.5;}' +
        '#sq-chain b{color:#1d4ed8;}' +
        '#sq-chain .sq-chain-btns{display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap;}' +
        '#sq-chain .sq-chain-go{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12.5px;font-weight:700;cursor:pointer;}' +
        '#sq-chain .sq-chain-x{border:none;background:transparent;color:#64748b;font-size:15px;cursor:pointer;}' +
        '#sq-chain .sq-chain-note{color:#b45309;}' +
        '.seat-div.sq-is-fav{outline:2px solid #f59e0b !important;outline-offset:-2px;}' +
        '.seat-div.sq-is-fav .seat-number{color:#f59e0b !important;font-weight:700;}' +
        '.seat-div.sq-pending-seat{outline:3px solid #2563eb !important;outline-offset:-2px;}' +
        '.seat-div.sq-pending-seat .seat-number{color:#2563eb !important;font-weight:700;}' +
        '@keyframes sqlocate{0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.0);}50%{box-shadow:0 0 0 6px rgba(37,99,235,.55);}}' +
        '.seat-div.sq-locate{outline:3px solid #2563eb !important;outline-offset:-2px;animation:sqlocate .9s ease-in-out infinite;z-index:5;}' +
        '.seat-div.sq-locate .seat-number{color:#2563eb !important;font-weight:800;}' +
        '.sq-sec{display:flex;align-items:center;gap:6px;margin:12px 0 6px;font-size:12.5px;font-weight:700;color:#334155;}' +
        '.sq-sec::after{content:"";flex:1;height:1px;background:#e2e8f0;}' +
        '.sq-sec small{font-weight:400;color:#94a3b8;}' +
        '.sq-seats{display:flex;flex-direction:column;gap:4px;}' +
        '.sq-srow{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:6px 9px;font-size:12.5px;cursor:pointer;}' +
        '.sq-srow:active{background:#eff6ff;border-color:#93c5fd;}' +
        '.sq-srow .n{font-weight:700;color:#0f172a;width:40px;flex:none;}' +
        '.sq-srow .w{color:#15803d;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.sq-star{flex:none;border:none;background:transparent;color:#f59e0b;font-size:15px;line-height:1;cursor:pointer;padding:0 2px;}' +
        '.sq-ztag{flex:none;font-size:10.5px;font-weight:700;border-radius:5px;padding:1px 5px;margin-left:4px;background:#e2e8f0;color:#475569;}' +
        '.sq-ztag.custom{background:#fef3c7;color:#92400e;cursor:pointer;}' +
        '#sq-zonepop{display:none;border-bottom:1px solid #e5e7eb;background:#f8fafc;padding:8px 10px;flex-direction:column;gap:6px;}' +
        '#sq-zonepop .zp-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:#475569;}' +
        '#sq-zonepop select,#sq-zonepop input{font-size:12.5px;padding:5px 7px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;}' +
        '#sq-zonepop input{flex:1;min-width:90px;}' +
        '#sq-zonepop .zp-add{border:none;background:#2563eb;color:#fff;border-radius:7px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;}' +
        '.zp-chips{display:flex;flex-wrap:wrap;gap:5px;}' +
        '.zp-chips button{border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:12px;font-size:11.5px;padding:3px 8px;cursor:pointer;}' +
        '.zp-tip{font-size:11px;color:#94a3b8;line-height:1.5;}' +
        '.sq-more{width:100%;margin-top:5px;border:1px dashed #cbd5e1;background:#fff;color:#475569;border-radius:7px;padding:6px;font-size:12px;cursor:pointer;}' +
        '#sq-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483002;display:none;}' +
        '#sq-picker{position:fixed;left:50%;bottom:0;transform:translateX(-50%);width:min(460px,100%);max-height:80vh;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.25);z-index:2147483003;display:none;flex-direction:column;padding:13px 13px calc(14px + env(safe-area-inset-bottom));}' +
        '#sq-picker .pk-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex:none;}' +
        '#sq-picker .pk-head b{font-size:16px;color:#0f172a;}' +
        '#sq-picker .pk-head small{color:#64748b;font-size:12px;}' +
        '#sq-picker .pk-close{margin-left:auto;border:none;background:#f1f5f9;color:#475569;width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;}' +
        '.pk-quick{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;flex:none;-webkit-overflow-scrolling:touch;}' +
        '.pk-quick button{flex:none;border:1px solid #16a34a;background:#f0fdf4;color:#15803d;border-radius:16px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;}' +
        '.pk-quick .pk-q-tip{flex:none;align-self:center;color:#94a3b8;font-size:11.5px;}' +
        '.pk-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;overflow-y:auto;padding:2px 1px 10px;-webkit-overflow-scrolling:touch;}' +
        '.pk-grid button{min-height:48px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#334155;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.25;padding:4px 2px;}' +
        '.pk-grid button b{font-size:12.5px;font-weight:700;}' +
        '.pk-grid button small{font-size:10px;color:#94a3b8;font-weight:400;}' +
        '.pk-grid button.occ,.pk-grid button.past{background:#f1f5f9;color:#94a3b8;border-color:#e2e8f0;cursor:not-allowed;}' +
        '.pk-grid button.occ small{color:#cbd5e1;}' +
        '.pk-grid button.edge{background:#2563eb;border-color:#2563eb;color:#fff;}' +
        '.pk-grid button.inr{background:#bfdbfe;border-color:#93c5fd;color:#1e3a8a;}' +
        '.pk-grid button.edge small,.pk-grid button.inr small{color:#e0e7ff;}' +
        '.pk-legend{display:flex;gap:12px;font-size:11px;color:#64748b;flex:none;padding:2px 1px 8px;}' +
        '.pk-legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:3px;vertical-align:-1px;}' +
        '.pk-foot{display:flex;gap:10px;align-items:center;flex:none;padding-top:9px;border-top:1px solid #e5e7eb;}' +
        '#pk-sum{flex:1;font-size:13px;color:#475569;}' +
        '#pk-ok{border:none;background:#16a34a;color:#fff;border-radius:9px;padding:11px 18px;font-size:14.5px;font-weight:700;cursor:pointer;}' +
        '#pk-ok:disabled{background:#cbd5e1;cursor:not-allowed;}' +
        '</style>' +
        '<button id="sq-launch">⚡ 快速选座</button>' +
        '<div id="sq-panel">' +
        '<div class="sq-head"><b>高频座位</b>' +
        '<div class="sq-seg" id="sq-day"><button data-d="today">今天</button><button data-d="tomorrow" class="on">明天</button></div>' +
        '<button class="sq-close" id="sq-close">×</button></div>' +
        '<div class="sq-tools"><label style="font-size:12px;color:#475569;">至少 ' +
        '<select id="sq-target"><option value="0">不限</option><option value="60">1h</option><option value="120">2h</option><option value="180">3h</option><option value="240" selected>4h</option></select></label>' +
        '<label style="font-size:12px;color:#475569;">排序 ' +
        '<select id="sq-sort"><option value="longest">最长优先</option><option value="custom">我的顺序</option></select></label>' +
        '<label style="font-size:12px;color:#475569;">电源 ' +
        '<select id="sq-power"><option value="all">全部</option><option value="power">仅有电</option><option value="nopower">仅无电区</option></select></label>' +
        '<button class="sq-btn ghost" id="sq-zonemgr" title="管理自定义无电座位">🔌无电区管理</button>' +
        '<button class="sq-btn" id="sq-refresh">刷新</button>' +
        '<button class="sq-btn ghost" id="sq-pickmode" title="在官方座位图上点座位直接加入高频">⭐点选添加</button>' +
        '<button class="sq-btn ghost" id="sq-assist" title="点两个时间块后自动确认，再点座位即可">⏱ 选时自动确认：开</button>' +
        '<button class="sq-btn ghost" id="sq-auto" title="进入座位预约页面自动展开本面板">🚀 进入自动展开：开</button>' +
        '<span style="margin-left:auto;font-size:11px;color:#94a3b8;" id="sq-updated"></span></div>' +
        '<div class="sq-tools" style="border-bottom:1px solid #e5e7eb;padding-top:6px;padding-bottom:6px;">' +
        '<label style="font-size:12px;color:#475569;display:flex;align-items:center;gap:4px;flex-wrap:wrap;">指定时段 ' +
        '<select id="sq-ws"></select><span>至</span><select id="sq-we"></select>' +
        '<span id="sq-winhint" style="color:#94a3b8;font-size:11px;">（不选=按“至少”时长筛全部空座）</span></label></div>' +
        '<div id="sq-picktip">点选模式：直接点击官方座位图中的座位即可加入高频（<b>不会触发预约</b>），已收藏座位有橙色描边；再点一次“⭐点选添加”退出。</div>' +
        '<div id="sq-zonepop"><div class="zp-row"><b>自定义无电座</b>' +
        '<select id="zp-room"><option value="11226">24h空间</option><option value="12818" selected>2F</option><option value="12819">3F</option><option value="12820">4F</option></select>' +
        '<input id="zp-num" placeholder="座位号，可填 172 或 172,175 或 172-175" inputmode="text">' +
        '<button class="zp-add" id="zp-add">加入无电</button></div>' +
        '<div class="zp-chips" id="zp-chips"></div>' +
        '<div class="zp-tip">内置无电区：2F阅览区 169-211 号（灰色“无电”标，不可删）；你自己加的为黄色标，点标签可移除。</div></div>' +
        '<div id="sq-chain"></div>' +
        '<div class="sq-list" id="sq-list">加载中…</div>' +
        '<div class="sq-add"><select id="sq-addroom"><option value="11226">24h空间</option><option value="12818" selected>2F</option><option value="12819">3F</option><option value="12820">4F</option></select>' +
        '<input id="sq-addnum" placeholder="座位号 如001" inputmode="numeric">' +
        '<button class="sq-btn" id="sq-goroom" title="在本面板列表中滚动定位到所选楼层分区（不跳转页面）">↓到楼层</button>' +
        '<button class="sq-btn ghost" id="sq-addbtn">☆收藏</button>' +
        '<button class="sq-btn ghost" id="sq-findbtn" title="在官方座位图上闪烁定位该座位（不选座）">◎定位</button></div>' +
        '<div class="sq-foot">⭐高频置顶，其后按2F→4F列全部空座 · 单次≤4h；选超4h自动拆2段连约（每天限2段共8h）<br>👆 点座位号弹出时间块（和官方一样点起止格），选好自动弹官方验证（验证码本人点）</div>' +
        '</div>' +
        '<div id="sq-mask"></div>' +
        '<div id="sq-picker"><div class="pk-head"><b id="pk-title">选时间</b><small id="pk-sub"></small><button class="pk-close" id="pk-close">×</button></div>' +
        '<div class="pk-quick" id="pk-quick"></div>' +
        '<div class="pk-legend"><span><i style="background:#fff;border:1px solid #cbd5e1;"></i>可选</span><span><i style="background:#f1f5f9;border:1px solid #e2e8f0;"></i>已约/已过</span><span><i style="background:#2563eb;"></i>起止</span><span><i style="background:#bfdbfe;"></i>选中段</span></div>' +
        '<div class="pk-grid" id="pk-grid"></div>' +
        '<div class="pk-foot"><span id="pk-sum">点一下开始格，再点一下结束格</span><button id="pk-ok" disabled>确认预约</button></div></div>';
      document.body.appendChild(root);
      // 官方安全验证弹出时自动藏起本面板，避免挡住验证码；关闭后恢复（fixed 元素 offsetParent 为 null，用尺寸判断）
      setInterval(function () {
        var cap = document.querySelector('.u-captcha') || document.querySelector('.cx_comImageValidate');
        var on = cap && cap.offsetWidth > 0 && getComputedStyle(cap).display !== 'none';
        root.style.visibility = on ? 'hidden' : '';
        var p = document.getElementById('sq-pill'); if (p) p.style.visibility = on ? 'hidden' : '';
      }, 400);
      if (window.innerWidth < 560) root.classList.add('sheet');
      var $ = function (s) { return root.querySelector(s); };
      $('#sq-launch').onclick = function () { $('#sq-panel').style.display = 'flex'; render(); };
      $('#sq-close').onclick = function () { $('#sq-panel').style.display = 'none'; };
      /* ---- 分段连约：学校单次≤4h、每天最多2次预约，超过4h自动拆成2段，每段都停在提交前由本人验证 ---- */
      function hm2(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
      function winMin(t) { var a = t.split('-'); return [parseHM(a[0]), parseHM(a[1])]; }
      function parseHM(s) { var p = s.split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
      function loadChain() { try { return JSON.parse(sessionStorage.getItem(CHAIN_KEY)); } catch (e) { return null; } }
      function saveChain(c) { try { sessionStorage.setItem(CHAIN_KEY, JSON.stringify(c)); } catch (e) {} }
      function renderChain(c) {
        var box = $('#sq-chain');
        var u = new URL(location.href);
        var hereRoom = Number(u.searchParams.get('id')), hereDay = u.searchParams.get('day');
        if (!c || (c.room && hereRoom != null && Number(c.room) !== hereRoom) || (c.day && hereDay && c.day !== hereDay)) { box.style.display = 'none'; box.innerHTML = ''; return; }
        var seg1 = hm2(c.s) + '-' + hm2(c.e1), seg2 = hm2(c.s2) + '-' + hm2(c.e2);
        var html;
        if (c.stage === 3) {
          html = '🔗 <b>连约第②段 ' + seg2 + ' 已预选</b>，请本人点官方“提交”并完成验证；两段都提交成功后即连约完成（每天限2段）。' +
            '<div class="sq-chain-btns"><button class="sq-chain-x" data-chain-cancel>收起 ✕</button></div>';
        } else {
          html = '🔗 分段连约 <b>' + c.num + '号</b>：① <b>' + seg1 + '</b>（先选好并由本人提交验证）→ ② <b>' + seg2 + '</b>。学校单次≤4h、每天最多2段。' +
            (c.note ? '<div class="sq-chain-note">' + c.note + '</div>' : '') +
            '<div class="sq-chain-btns"><button class="sq-chain-go" data-chain-go>约第②段 ' + seg2 + '</button>' +
            '<button class="sq-chain-x" data-chain-cancel>取消连约 ✕</button></div>';
        }
        box.innerHTML = html; box.style.display = 'block';
        var goBtn = box.querySelector('[data-chain-go]');
        if (goBtn) goBtn.onclick = function () {
          c.stage = 2; saveChain(c);
          toast('正在为你准备第②段，请稍候…');
          Preselect.goNav(c.room, c.num, seg2, c.day);   // 刷新进入干净页面后自动预选第2段
        };
        box.querySelector('[data-chain-cancel]').onclick = function () {
          try { sessionStorage.removeItem(CHAIN_KEY); } catch (e) {}
          box.style.display = 'none'; box.innerHTML = '';
        };
      }
      // 发起：≤4h走普通预选；>4h拆两段。任何结果都必须给用户明确反馈，不许静默
      function handleRes(r) {
        if (!r) { toast('预选没有返回结果，请重试一次'); return; }
        if (r.navigating) { toast('正在进入对应楼层/日期页面，落地后自动为你选好…'); return; }
        if (r.ok) toast('已为你选好 ' + r.seat + ' 号 ' + r.start + '-' + r.end + '，请在弹出的验证界面本人完成' + (r.verify ? '' : '（验证层没弹出时手动点页面底部“提交”）'));
        else if (r.err) toast('预选未完成：' + r.err);
      }
      function startChain(room, num, winText, day, maxDurMin) {
        var w = winMin(winText), s = w[0], e = w[1];
        if (e - s <= maxDurMin) { Preselect.go(room, num, winText, day).then(handleRes).catch(function (er) { toast('预选异常：' + (er && er.message || er)); }); return; }
        var e1 = Math.min(e, s + maxDurMin);
        var s2 = e1, e2 = Math.min(e, s2 + maxDurMin);
        if (e2 - s2 < 60) { toast('剩余时长不足1小时，无法组成第2段，已按第1段 ' + hm2(s) + '-' + hm2(e1) + ' 预选'); Preselect.go(room, num, hm2(s) + '-' + hm2(e1), day).then(handleRes); return; }
        var note = e2 < e ? ('每天最多2段共' + (maxDurMin * 2 / 60) + 'h，' + hm2(e2) + ' 之后无法再约，已按前两段规划') : '';
        var c = { room: Number(room), num: num, day: day, s: s, e1: e1, s2: s2, e2: e2, stage: 1, note: note };
        saveChain(c);
        Preselect.go(room, num, hm2(s) + '-' + hm2(e1), day).then(function (r) {
          if (r && r.navigating) { renderChain(loadChain()); return; }  // 跨房间：落地后由 pending 流程处理
          if (r && r.ok) { renderChain(loadChain()); toast('第①段 ' + hm2(s) + '-' + hm2(e1) + ' 已选好并弹出验证，本人完成验证后，点面板里的“约第②段”'); }
          else handleRes(r);
        }).catch(function (er) { toast('第①段预选异常：' + (er && er.message || er)); });
      }
      /* ---- 点座位号 → 仿官方“逐小时时间块”选择器（点起止格，确认后自动选座弹验证） ---- */
      var PICK = null;
      function closePicker() {
        $('#sq-mask').style.display = 'none'; $('#sq-picker').style.display = 'none'; PICK = null;
        document.querySelectorAll('.seat-div.sq-pending-seat').forEach(function (d) { d.classList.remove('sq-pending-seat'); });
      }
      function paintGrid() {
        var p = PICK, grid = $('#pk-grid'); grid.innerHTML = '';
        p.blocks.forEach(function (b, i) {
          var btn = document.createElement('button');
          var cls = b.state === 'free' ? '' : b.state;
          if (p.s === i) cls = 'edge';
          else if (p.e >= 0 && i > Math.min(p.s, p.e) && i < Math.max(p.s, p.e)) cls = 'inr';
          else if (p.e === i) cls = 'edge';
          if (cls) btn.className = cls;
          btn.dataset.i = i;
          btn.innerHTML = '<b>' + hm2(b.s) + '</b><small>' + (b.state === 'occ' ? '已约' : b.state === 'past' ? '已过' : ('至' + hm2(b.e).slice(0, 2))) + '</small>';
          grid.appendChild(btn);
        });
      }
      function updateSum() {
        var p = PICK, ok = $('#pk-ok'), sum = $('#pk-sum');
        if (p.s < 0) { ok.disabled = true; sum.textContent = '点一下开始格，再点一下结束格'; return; }
        var lo = p.s, hi = p.e >= 0 ? p.e : p.s;
        var a = p.blocks[lo], b = p.blocks[hi];
        var txt = hm2(a.s) + '-' + hm2(b.e);
        var hours = (b.e - a.s) / 60;
        sum.textContent = '已选 ' + txt + '（' + hours + 'h）' + (hours > p.maxMin / 60 ? '，将自动分2段连约' : '');
        ok.disabled = false; ok.textContent = '确认预约 ' + txt;
      }
      function openPicker(room, num, day, maxMin, wins, blks) {
        PICK = { room: Number(room), num: num, day: day, maxMin: maxMin, blocks: blks || [], s: -1, e: -1 };
        $('#pk-title').textContent = num + ' 号 · 选时间';
        var z0 = zoneOf(room, num);
        $('#pk-sub').textContent = (ROOMSHORT[room] || '') + ' · ' + (day || '') + (z0 ? ' · ' + z0.name : '');
        // 顶部快捷空段（一键选最长空窗；超4h标分2段）
        var q = $('#pk-quick'); q.innerHTML = '<span class="pk-q-tip">快捷</span>';
        (wins || []).forEach(function (t) {
          var aa = t.split('-'), dur = parseHM(aa[1]) - parseHM(aa[0]);
          var b = document.createElement('button');
          b.textContent = t + (dur > maxMin ? ' ·分2段' : '');
          b.onclick = function () { try { closePicker(); startChain(Number(room), num, t, day, maxMin); } catch (er) { toast('快捷选座出错：' + (er && er.message || er)); } };
          q.appendChild(b);
        });
        paintGrid(); updateSum();
        $('#sq-mask').style.display = 'block'; $('#sq-picker').style.display = 'flex';
        var g = $('#pk-grid');
        g.onclick = function (ev) {
          var btn = ev.target.closest('button[data-i]'); if (!btn || !PICK) return;
          var i = Number(btn.dataset.i), p = PICK;
          if (p.blocks[i].state !== 'free') { toast('该格已' + (p.blocks[i].state === 'occ' ? '被预约' : '过去') + '，不能选'); return; }
          if (p.s < 0) { p.s = i; }
          else if (p.e < 0) {
            var lo = Math.min(p.s, i), hi = Math.max(p.s, i);
            var blocked = p.blocks.slice(lo, hi + 1).some(function (x) { return x.state !== 'free'; });
            if (blocked) { p.s = i; toast('中间有不可选时段，已把这格设为开始'); }
            else {
              var maxN = p.maxMin / 60;
              if (hi - lo + 1 > maxN) {
                if (i > p.s) hi = p.s + maxN - 1; else lo = p.s - maxN + 1;
                toast('单次最多 ' + maxN + ' 小时，已自动收边；坐更久走分2段连约');
              }
              p.s = lo; p.e = hi;
            }
          } else { p.s = i; p.e = -1; }   // 已选完整段后再点=重选
          paintGrid(); updateSum();
        };
        $('#pk-ok').onclick = function () {
          try {
            var p = PICK; if (!p || p.s < 0) { toast('请先点选开始和结束时间格'); return; }
            var hi = p.e >= 0 ? p.e : p.s;
            var t = hm2(p.blocks[p.s].s) + '-' + hm2(p.blocks[hi].e);
            closePicker(); startChain(p.room, p.num, t, p.day, p.maxMin);
          } catch (er) { toast('确认选座出错：' + (er && er.message || er)); }
        };
      }
      $('#sq-mask').onclick = closePicker; $('#pk-close').onclick = closePicker;
      // 官方座位图上直接点座位（时间还没确认时）→ 现拉该座数据并弹出时间块选择器
      window.__sqOpenPickerBySeat = function (room, num) {
        var u = new URL(location.href); var day = u.searchParams.get('day') || ymd(0);
        toast('正在读取 ' + num + ' 号可约时间…');
        Data.roomInfo(room, day).then(function (d) {
          var c = Calc.detail(d, num, day, d.serverNow || Date.now());
          var max = ((d.seatConfig && d.seatConfig.reserveDuration) || 4) * 60;
          var blks = Calc.blocks(d, num, day, d.serverNow || Date.now());
          openPicker(Number(room), String(num).padStart(3, '0'), day, max, c.bookableTxt, blks);
        }).catch(function () { toast('时间读取失败：请先打开一次快速面板刷新数据'); });
      };
      $('#sq-day').onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return;
        [].slice.call($('#sq-day').children).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on'); state.day = b.dataset.d; render();
      };
      $('#sq-target').onchange = function (e) { state.target = Number(e.target.value); render(); };
      $('#sq-sort').onchange = function (e) { state.sort = e.target.value; render(); };
      // 电源筛选
      $('#sq-power').value = state.power;
      $('#sq-power').onchange = function (e) {
        state.power = e.target.value;
        try { localStorage.setItem('seatQuick.powerFilter', state.power); } catch (er) {}
        state.expanded = {}; render();
      };
      // 无电区自定义管理
      function renderZoneChips() {
        var box = $('#zp-chips'); box.innerHTML = '';
        var all = NoPower.list();
        if (!all.length) box.innerHTML = '<span class="zp-tip">还没有自定义无电座（内置 2F 169-211 始终生效）</span>';
        all.forEach(function (k) {
          var p = k.split(':'), b = document.createElement('button');
          b.textContent = (ROOMSHORT[p[0]] || p[0]) + ' ' + p[1] + ' ×';
          b.title = '点此移除';
          b.onclick = function () { NoPower.remove(k); renderZoneChips(); render(true); };
          box.appendChild(b);
        });
      }
      $('#sq-zonemgr').onclick = function () {
        var pop = $('#sq-zonepop');
        var show = pop.style.display !== 'flex';
        pop.style.display = show ? 'flex' : 'none';
        this.classList.toggle('on', show);
        if (show) renderZoneChips();
      };
      $('#zp-add').onclick = function () {
        var room = Number($('#zp-room').value), raw = $('#zp-num').value.trim();
        if (!raw) { toast('先填座位号，如 172 或 172,175 或 172-175'); return; }
        var nums = [], m;
        raw.split(/[,，、\s]+/).filter(Boolean).forEach(function (tok) {
          if ((m = tok.match(/^(\d{1,3})\s*[-~到]\s*(\d{1,3})$/))) {
            var a = Number(m[1]), b2 = Number(m[2]);
            if (b2 < a) { var t2 = a; a = b2; b2 = t2; }
            for (var x = a; x <= b2 && x <= 999; x++) nums.push(x);
          } else if (/^\d{1,3}$/.test(tok)) nums.push(Number(tok));
        });
        if (!nums.length) { toast('没认出座位号格式，例：172、172,175、172-175'); return; }
        var n = NoPower.add(room, nums);
        $('#zp-num').value = ''; renderZoneChips(); render(true);
        toast('已把 ' + n + ' 个座位加入' + (ROOMSHORT[room] || '') + '无电区');
      };
      // 指定时段下拉（08:00–22:00，整点）
      function hh(h) { return String(h).padStart(2, '0') + ':00'; }
      function fillHours(sel, from, to, withAny) {
        var html = withAny ? '<option value="">不限</option>' : '';
        for (var h = from; h <= to; h++) html += '<option value="' + (h * 60) + '">' + hh(h) + '</option>';
        sel.innerHTML = html;
      }
      fillHours($('#sq-ws'), 8, 21, true);
      fillHours($('#sq-we'), 9, 22, false);
      function syncWinHint() {
        var has = state.winS != null && state.winE != null && state.winE > state.winS;
        var txt = has ? ('只看能整段约 ' + hh(state.winS / 60) + '-' + hh(state.winE / 60) + ' 的座位' + (state.winE - state.winS > 240 ? '；超4h将自动拆2段连约' : '')) : '（不选=按“至少”时长筛全部空座）';
        $('#sq-winhint').textContent = txt;
        $('#sq-target').disabled = has;
        $('#sq-we').disabled = state.winS == null;
      }
      $('#sq-ws').onchange = function (e) {
        if (e.target.value === '') { state.winS = null; state.winE = null; $('#sq-we').value = ''; syncWinHint(); render(); return; }
        state.winS = Number(e.target.value);
        if (state.winS != null && (state.winE == null || state.winE <= state.winS)) {
          state.winE = Math.min(state.winS + 240, 22 * 60);
          $('#sq-we').value = String(state.winE);
        }
        syncWinHint(); render();
      };
      $('#sq-we').onchange = function (e) {
        state.winE = e.target.value === '' ? null : Number(e.target.value);
        syncWinHint(); render();
      };
      syncWinHint();
      $('#sq-refresh').onclick = function () { Data.clear(); render(); };
      $('#sq-addbtn').onclick = function () {
        var n = $('#sq-addnum').value.trim();
        if (!/^\d{1,3}$/.test(n)) { alert('请输入数字座位号'); return; }
        if (!Store.add($('#sq-addroom').value, n)) alert('该座位已在列表中');
        $('#sq-addnum').value = ''; render();
      };
      $('#sq-findbtn').onclick = function () {
        var n = $('#sq-addnum').value.trim();
        if (!/^\d{1,3}$/.test(n)) { alert('请输入数字座位号'); return; }
        Assist.locate($('#sq-addroom').value, n);
      };
      // 选好楼层后，在本面板结果列表里滚动定位到该楼层分区（不跳转、不刷新）
      $('#sq-goroom').onclick = function () {
        var rid = $('#sq-addroom').value;
        var list = $('#sq-list');
        var head = list.querySelector('.sq-sec[data-rid="' + rid + '"]');
        if (!head) { toast('当前筛选条件下该楼层没有分区，放宽时长/时段再试'); return; }
        var top = head.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 4;
        list.scrollTop = top;
      };
      /* ---- 点选添加：在官方座位图上点座位即加入高频 ---- */
      state.pickMode = false;
      function currentRoomId() { var m = location.href.match(/[?&]id=(\d+)/); return m ? Number(m[1]) : null; }
      function markFavSeats() {
        var rid = currentRoomId(); if (rid == null) return;
        var favSet = {};
        Store.load().forEach(function (f) { if (Number(f.room) === rid) favSet[f.num] = 1; });
        document.querySelectorAll('.seat-div').forEach(function (d) {
          var el = d.querySelector('.seat-number'); if (!el) return;
          if (favSet[el.textContent.trim()]) d.classList.add('sq-is-fav');
          else d.classList.remove('sq-is-fav');
        });
      }
      $('#sq-pickmode').onclick = function () {
        state.pickMode = !state.pickMode;
        this.classList.toggle('on', state.pickMode);
        $('#sq-picktip').style.display = state.pickMode ? 'block' : 'none';
        if (state.pickMode) {
          if (!/\/seat\/select/.test(location.pathname)) toast('请先进入某楼层的“选座”座位图，再开启点选添加');
          markFavSeats();
        }
      };
      // 手动连点开关
      var assistBtn = $('#sq-assist');
      function syncAssistBtn() { assistBtn.textContent = '⏱ 选时自动确认：' + (Assist.enabled() ? '开' : '关'); assistBtn.classList.toggle('on', Assist.enabled()); }
      syncAssistBtn();
      assistBtn.onclick = function () { Assist.setOn(!Assist.enabled()); syncAssistBtn(); toast(Assist.enabled() ? '已开启：时间→座位、座位→时间两种顺序都自动补到提交前' : '已关闭，恢复官方原始操作'); };
      // 进入页面自动展开开关
      function autoOpenOn() { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch (e) { return true; } }
      var autoBtn = $('#sq-auto');
      function syncAutoBtn() { autoBtn.textContent = '🚀 进入自动展开：' + (autoOpenOn() ? '开' : '关'); autoBtn.classList.toggle('on', autoOpenOn()); }
      syncAutoBtn();
      autoBtn.onclick = function () { try { localStorage.setItem(AUTO_KEY, autoOpenOn() ? '0' : '1'); } catch (e) {} syncAutoBtn(); toast(autoOpenOn() ? '已开启：一进座位预约页就自动展开面板' : '已关闭：需要手动点右下角“⚡快速选座”'); };
      // 捕获阶段拦截：点选模式下把“点座位”变成“加入高频”，阻止官方选座逻辑
      document.addEventListener('click', function (e) {
        if (!state.pickMode) return;
        var d = e.target.closest && e.target.closest('.seat-div'); if (!d) return;
        e.preventDefault(); e.stopPropagation();
        var numEl = d.querySelector('.seat-number'); if (!numEl) return;
        var rid = currentRoomId(); if (rid == null) return;
        var num = numEl.textContent.trim();
        var ok = Store.add(rid, num);
        toast(ok ? ('已加入高频：' + (ROOMSHORT[rid] || rid) + ' ' + num + ' 号') : (num + ' 号已在高频列表中'));
        markFavSeats(); render();
      }, true);
      // 官方座位图会随时段重绘，重绘后重新描边（rAF 节流）
      var markRaf = 0;
      new MutationObserver(function () {
        if (markRaf) return; markRaf = requestAnimationFrame(function () { markRaf = 0; markFavSeats(); });
      }).observe(document.body, { childList: true, subtree: true });
      function badge(c, isToday) {
        if (c.status === 'allFree') return isToday ? ['现在可约', '#dcfce7', '#15803d'] : ['全天空', '#dcfce7', '#15803d'];
        if (c.status === 'partial') return ['有空段', '#dbeafe', '#1d4ed8'];
        return ['已约满', '#f1f5f9', '#64748b'];
      }
      var FLOORORDER = [12818, 11226, 12819, 12820]; // 二楼→四楼（2F阅览区、2F-24h、3F、4F）
      var SECNAME = { 12818: '2F · 阅览区', 11226: '2F · 24h借阅空间', 12819: '3F · 阅览区', 12820: '4F · 阅览区' };
      var ROW_LIMIT = 40; // 每层默认只渲染前40行，点“展开”再显示其余，保证流畅
      function hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
      function wtxt(w) { return hm(w[0]) + '-' + hm(w[1]); }
      function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
      function render(keepPos) {
        var day = state.day === 'today' ? ymd(0) : ymd(1);
        var list = $('#sq-list');
        var keepScroll = keepPos ? list.scrollTop : 0;
        if (!keepPos) { list.textContent = '加载中…'; list.scrollTop = 0; }
        Data.allRooms(day).then(function (res) {
          var dmap = {}, smap = {}, serverNow = Date.now();
          res.forEach(function (x) {
            if (x.d) { dmap[x.rm.id] = x.d; serverNow = x.d.serverNow || serverNow; }
            smap[x.rm.id] = x.seats || [];
          });
          var ws = state.winS, we = state.winE;
          var hasWin = ws != null && we != null && we > ws;
          // 指定时段：必须有一整段空窗完整覆盖 [ws,we]
          function coverWins(c) {
            if (!hasWin) return null;
            var h = c.bookable.filter(function (w) { return w[0] <= ws && w[1] >= we; });
            return h.length ? h : null;
          }
          function qualifies(c) { return hasWin ? !!coverWins(c) : c.longest >= state.target; }
          function pickChip(c) {
            if (hasWin) return hm(ws) + '-' + hm(we);
            var b = c.bookable.slice().sort(function (a, b) { return (b[1] - b[0]) - (a[1] - a[0]); })[0];
            return b ? wtxt(b) : '';
          }
          var favList = Store.load();
          var favSet = {}; favList.forEach(function (f) { favSet[f.room + ':' + f.num] = 1; });
          // ① 高频座位（置顶）
          var favs = favList.map(function (f) {
            var d = dmap[f.room]; if (!d) return null;
            return { room: f.room, num: f.num, c: Calc.detail(d, f.num, day, serverNow) };
          }).filter(Boolean).filter(function (f) { return qualifies(f.c); });
          if (state.sort === 'longest') favs.sort(function (a, b) { return b.c.longest - a.c.longest; });
          // ② 其余座位按楼层分区（排除已在高频里的），每个楼层再拆“普通/无电区”两个小节
          var sections = [];
          FLOORORDER.forEach(function (rid) {
            var d = dmap[rid];
            var allRows = d ? (smap[rid] || []).filter(function (n) { return !favSet[rid + ':' + n]; })
              .map(function (n) { return { room: rid, num: n, c: Calc.detail(d, n, day, serverNow) }; })
              .filter(function (x) { return qualifies(x.c); })
              .sort(function (a, b) { return Number(a.num) - Number(b.num); }) : [];
            var mainRows = allRows.filter(function (x) { return !isNoPower(rid, x.num); });
            var zoneRows = allRows.filter(function (x) { return isNoPower(rid, x.num); });
            if (state.power !== 'nopower') sections.push({ key: String(rid), rid: rid, zone: false, rows: mainRows });
            if (state.power !== 'power' && zoneRows.length) sections.push({ key: rid + ':z', rid: rid, zone: true, rows: zoneRows });
          });
          function ztagHtml(room, num) {
            var z = zoneOf(room, num);
            if (!z) return '';
            return '<span class="sq-ztag' + (z.custom ? ' custom' : '') + '" data-zrm="' + room + '" data-zn="' + num +
              '" title="' + (z.custom ? '我加的无电座，点此移除' : '内置无电区 169-211') + '">无电</span>';
          }
          var totalOther = sections.reduce(function (s, x) { return s + x.rows.length; }, 0);
          list.innerHTML = '';
          // —— 高频区 ——
          var favHead = document.createElement('div');
          favHead.className = 'sq-sec';
          favHead.innerHTML = '⭐ 高频座位 <small>符合 ' + favs.length + ' 个</small>';
          list.appendChild(favHead);
          if (!favs.length) {
            var n0 = document.createElement('div'); n0.className = 'sq-none';
            n0.textContent = hasWin ? '高频座位在该时段均不可约，看下方楼层空座' : '当前条件下高频无符合座位，看下方楼层空座';
            list.appendChild(n0);
          }
          favs.forEach(function (f) {
            var bd = badge(f.c, f.c.isToday);
            var span = f.c.oe - f.c.os;
            var bars = f.c.segs.filter(function (s) { return s.e > s.s; }).map(function (s) {
              var w = ((s.e - s.s) / span * 100).toFixed(2);
              var cls = s.kind === 'free' ? ((s.e - s.s) >= 240 ? 'sq-free' : 'sq-free2') : (s.kind === 'past' ? 'sq-past' : 'sq-occ');
              return '<i class="' + cls + '" style="width:' + w + '%"></i>';
            }).join('');
            var chips;
            if (hasWin) chips = '<button class="sq-chip" data-r="' + f.room + '" data-n="' + f.num + '" data-t="' + hm(ws) + '-' + hm(we) + '">约 ' + hm(ws) + '-' + hm(we) + (we - ws > 240 ? ' ·分2段' : '') + '</button>';
            else chips = f.c.bookableTxt.length
              ? f.c.bookableTxt.map(function (t) {
                  var over = (function () { var a = t.split('-'); return parseHM(a[1]) - parseHM(a[0]) > 240; })();
                  return '<button class="sq-chip" data-r="' + f.room + '" data-n="' + f.num + '" data-t="' + t + '">' + t + (over ? ' ·分2段' : '') + '</button>';
                }).join('')
              : '<span class="sq-none">暂无可约整段</span>';
            var card = document.createElement('div');
            card.className = 'sq-card' + (f.c.status === 'full' ? ' full' : '');
            card.setAttribute('data-pick', '1'); card.dataset.r = f.room; card.dataset.n = f.num;
            card.dataset.w = f.c.bookableTxt.join('|');
            card.innerHTML =
              '<div class="sq-row1"><span class="sq-no">' + f.num + '</span><span class="sq-tag">' + (ROOMSHORT[f.room] || '') + '</span>' + ztagHtml(f.room, f.num) +
              '<span class="sq-badge" style="background:' + bd[1] + ';color:' + bd[2] + '">' + bd[0] + ' · 最长' + f.c.longestTxt + '</span>' +
              '<button class="sq-x" data-rm="' + f.room + '" data-rn="' + f.num + '" title="移除">×</button></div>' +
              '<div class="sq-bar">' + bars + '</div><div class="sq-chips">' + chips + '</div>';
            list.appendChild(card);
          });
          // —— 楼层区 ——
          sections.forEach(function (sec) {
            var head = document.createElement('div'); head.className = 'sq-sec'; head.dataset.rid = sec.rid;
            head.innerHTML = esc(SECNAME[sec.rid] + (sec.zone ? ' · 无电区' : '')) + ' <small>空余 ' + sec.rows.length + ' 个</small>';
            list.appendChild(head);
            if (!sec.rows.length) {
              var ne = document.createElement('div'); ne.className = 'sq-none';
              ne.textContent = hasWin ? '该时段此层无整段空余座位' : '此层无符合时长的空余座位';
              list.appendChild(ne); return;
            }
            var shown = state.expanded[sec.key] ? sec.rows : sec.rows.slice(0, ROW_LIMIT);
            var box = document.createElement('div'); box.className = 'sq-seats';
            box.innerHTML = shown.map(function (x) {
              var winDesc;
              if (hasWin) {
                var cov = coverWins(x.c)[0];
                winDesc = '约 ' + hm(ws) + '-' + hm(we) + (we - ws > 240 ? ' ·分2段' : '') + ((cov[0] === ws && cov[1] === we) ? '' : '（该座空 ' + wtxt(cov) + '）');
              } else winDesc = x.c.bookableTxt.join(' ');
              var t = pickChip(x.c);
              return '<div class="sq-srow" data-pick="1" data-r="' + x.room + '" data-n="' + x.num + '" data-t="' + t + '" data-w="' + x.c.bookableTxt.join('|') + '" title="点座位号弹出可选时段">' +
                '<span class="n">' + x.num + '</span>' + ztagHtml(x.room, x.num) + '<span class="w">' + esc(winDesc) + '</span>' +
                '<button class="sq-star" data-add="' + x.room + '" data-an="' + x.num + '" title="加入高频">☆</button></div>';
            }).join('');
            list.appendChild(box);
            if (sec.rows.length > shown.length) {
              var more = document.createElement('button');
              more.className = 'sq-more'; more.dataset.more = sec.key;
              more.textContent = '展开剩余 ' + (sec.rows.length - shown.length) + ' 个';
              list.appendChild(more);
            }
          });
          if (!favs.length && !totalOther) {
            list.insertAdjacentHTML('beforeend', '<div class="sq-none" style="margin-top:8px;">没有符合条件的座位，换个时段/缩短时长试试</div>');
          }
          list.onclick = function (e) {
            var zrm = e.target.closest('.sq-ztag.custom');
            if (zrm) { NoPower.remove(NoPower.key(zrm.dataset.zrm, zrm.dataset.zn)); toast('已从自定义无电区移除：' + zrm.dataset.zn + ' 号'); render(true); return; }
            var star = e.target.closest('[data-add]');
            if (star) { Store.add(star.dataset.add, star.dataset.an); toast('已加入高频：' + (ROOMSHORT[star.dataset.add] || '') + ' ' + star.dataset.an); render(); return; }
            var mo = e.target.closest('[data-more]');
            if (mo) { state.expanded[mo.dataset.more] = !state.expanded[mo.dataset.more]; render(true); return; }  // 展开时保持滚动位置
            var rm = e.target.closest('[data-rm]');
            if (rm) { Store.remove(rm.dataset.rm, rm.dataset.rn); render(); return; }
            // 高频卡上的小空段按钮：一键直达；点座位号/卡片其他位置 → 弹时段选择窗
            var ch = e.target.closest('.sq-chip');
            if (ch && ch.dataset.t) {
              var ridC = Number(ch.dataset.r);
              var cfgC = (dmap[ridC] && dmap[ridC].seatConfig) || {};
              try { startChain(ridC, ch.dataset.n, ch.dataset.t, day, (cfgC.reserveDuration || 4) * 60); }
              catch (er) { toast('选座出错：' + (er && er.message || er)); }
              return;
            }
            var pk = e.target.closest('[data-pick]');
            if (pk) {
              var ridP = Number(pk.dataset.r);
              var dP = dmap[ridP], cfgP = (dP && dP.seatConfig) || {};
              var maxP = (cfgP.reserveDuration || 4) * 60;
              var winsP = (pk.dataset.w || '').split('|').filter(Boolean);
              var blksP = dP ? Calc.blocks(dP, pk.dataset.n, day, serverNow) : [];
              openPicker(ridP, pk.dataset.n, day, maxP, winsP, blksP);
            }
          };
          var d = new Date(serverNow);
          $('#sq-updated').textContent = '更新 ' + d.toLocaleTimeString('zh-CN', { hour12: false }) + ' · 共' + (favs.length + totalOther) + '座可选';
          syncWinHint();
          renderChain(loadChain());
          markFavSeats();
          if (keepPos) list.scrollTop = keepScroll;  // 展开剩余时回到原位置，不跳顶
        }).catch(function (e) { list.textContent = '加载失败：' + e.message + '（可能登录已过期，请从门户重新进入）'; });
      }
      window.__sqRender = render;
      return { open: function () { $('#sq-panel').style.display = 'flex'; render(); } };
    }
    var inst = null;
    return { init: function () { inst = mount(); return inst; }, open: function () { if (inst) inst.open(); } };
  })();

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    var inst = UI.init();
    Assist.init();          // 手动连点：时间/座位顺序随意，自动补到提交前
    Preselect.runPending();   // 跨房间跳转落地后自动续跑预选
    // 进入座位系统自动展开面板（列表页/座位图页都弹；自动续选跳转落地时不弹，避免干扰验证）
    try {
      var autoOn = localStorage.getItem(AUTO_KEY) !== '0';
      var pend = sessionStorage.getItem(PENDING_KEY);
      if (autoOn && !pend && /\/seat\/(list|select)(\/|$|\?)/.test(location.pathname + location.search)) {
        setTimeout(function () { inst && inst.open(); }, 250);
      }
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
