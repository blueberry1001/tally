/* Optional localhost SQLite adapter. Only the local database server loads this file.
 * No CDN, file:// reads, localStorage writes, or retries on conflicts.
 */
(() => {
  'use strict';
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return;
  function request(method, path, payload) {
    const req = new XMLHttpRequest();
    try {
      req.open(method, path, false);
      req.setRequestHeader('X-Tally-Client', 'sqlite-v1');
      if (payload !== undefined) req.setRequestHeader('Content-Type', 'application/json');
      req.send(payload === undefined ? null : JSON.stringify(payload));
    } catch (_) {
      const err = new Error('SQLiteサーバーに接続できません。起動したウィンドウと接続先を確認してください。');
      err.status = 0;
      throw err;
    }
    let response;
    try { response = JSON.parse(req.responseText); } catch (_) { /* HTML from wrong server or invalid response */ }
    if (req.status !== 200 || response === undefined) {
      const err = new Error(response?.error || `SQLiteの処理に失敗しました（HTTP ${req.status}）。`);
      err.status = req.status;
      throw err;
    }
    return response;
  }
  let revision = null;
  const scope = (start, end, category) => {
    const q = new URLSearchParams({start, end, category:category || ''});
    if (revision !== null) q.set('revision', String(revision));
    return q;
  };
  const api = {
    read() { const r = request('GET', '/api/state'); revision = r.revision; return r; },
    save(nextState, expectedRevision) { revision = request('POST','/api/state',{nextState,expectedRevision}).revision; return revision; },
    queryTop(start, end, limit=5, category='') {
      const q = scope(start,end,category); q.set('limit',String(limit));
      return request('GET', '/api/top?' + q.toString()).rows;
    },
    queryPeriod(start, end, category='') { return request('GET','/api/period?' + scope(start,end,category)).rows; },
  };
  Object.defineProperty(window, 'TallyDB', {value:Object.freeze(api), enumerable:true});
})();
