#!/usr/bin/env python3
"""Tally desktop SQLite mode: loopback only, stdlib only. Does not read file:// storage."""
import argparse
import base64
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import unicodedata
from urllib.parse import parse_qs, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'vendor'))
import tally_sql as sql

APP_ID = 0x54414C59  # TALY
MAX_BODY = 24 * 1024 * 1024
# Frozen v1 schema: shared by fresh initialization and additive v1 -> v2 migration.
SCHEMA_V1 = (
    'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0))',
    'INSERT INTO meta VALUES(1,0)',
    '''CREATE TABLE transactions (id TEXT PRIMARY KEY NOT NULL, date TEXT NOT NULL,
       type TEXT NOT NULL CHECK(type IN ('income','expense','transfer')),
       amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
       category TEXT NOT NULL,title TEXT NOT NULL,source TEXT NOT NULL,
       import_key TEXT, position INTEGER NOT NULL UNIQUE)''',
    'CREATE TABLE budgets (category TEXT PRIMARY KEY NOT NULL, amount INTEGER NOT NULL CHECK(amount>0))',
    '''CREATE TABLE goals (id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,
       target INTEGER NOT NULL CHECK(target>0),saved INTEGER NOT NULL CHECK(saved>=0),position INTEGER NOT NULL UNIQUE)''',
    'CREATE INDEX tx_date ON transactions(date)',
    'CREATE INDEX tx_category_date ON transactions(category,date)',
    'CREATE INDEX tx_type_date ON transactions(type,date)',
    '''CREATE VIEW v_ledger AS SELECT t.*,substr(date,1,7) AS month,
       CASE type WHEN 'income' THEN amount WHEN 'expense' THEN -amount ELSE 0 END AS signed_amount FROM transactions t''',
    '''CREATE VIEW v_monthly_cashflow AS SELECT month,
       SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
       SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
       SUM(CASE WHEN type='transfer' THEN amount ELSE 0 END) AS transfer,
       SUM(signed_amount) AS net,COUNT(*) AS count FROM v_ledger GROUP BY month''',
    '''CREATE VIEW v_monthly_categories AS SELECT month,type,category,SUM(amount) AS total,COUNT(*) AS count
       FROM v_ledger GROUP BY month,type,category''',
    f'PRAGMA application_id={APP_ID}', 'PRAGMA user_version=1',
)

# Never replace a pre-existing settings table during migration. Failed DDL rolls back.
ADD_SETTINGS = (
    '''CREATE TABLE category_colors (
       category TEXT PRIMARY KEY NOT NULL, color TEXT NOT NULL CHECK(length(color)=7))''',
    '''CREATE TABLE category_rules (
       position INTEGER PRIMARY KEY CHECK(position>=0 AND position<500),
       prefix TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('expense','income')),
       category TEXT NOT NULL, match_key TEXT NOT NULL, UNIQUE(type,match_key))''',
    'PRAGMA user_version=2',
)
ADD_CATEGORIES = (
    '''CREATE TABLE custom_categories (
       type TEXT NOT NULL CHECK(type IN ('income','expense')),
       position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
       name TEXT NOT NULL PRIMARY KEY, match_key TEXT NOT NULL UNIQUE, UNIQUE(type,position))''',
    'PRAGMA user_version=3',
)
JS_SPACE = sql.JS_SPACE


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def connect(path):
    db = sqlite3.connect(str(path), timeout=5)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA temp_store=MEMORY')
    return db


def initialize(path):
    if sqlite3.sqlite_version_info < (3, 25, 0):
        raise ValueError('SQLite 3.25以上を含むPythonが必要です。')
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        appid = db.execute('PRAGMA application_id').fetchone()[0]
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if appid == APP_ID and version in (1, 2, 3):
            # Verify the identified base database before any additive migration.
            db.execute('SELECT id,date,type,amount,category,title,source,import_key,position FROM transactions LIMIT 0')
            db.execute('SELECT category,amount FROM budgets LIMIT 0')
            db.execute('SELECT id,title,target,saved,position FROM goals LIMIT 0')
            meta = db.execute('SELECT revision FROM meta WHERE id=1').fetchone()
            if meta is None or type(meta[0]) is not int or meta[0] < 0:
                raise ValueError('SQLite管理情報が不正です。バックアップをご確認ください。')
            if version == 1:
                for statement in ADD_SETTINGS:
                    db.execute(statement)
            else:
                db.execute('SELECT category,color FROM category_colors LIMIT 0')
                db.execute('SELECT position,prefix,type,category,match_key FROM category_rules LIMIT 0')
            if version < 3:
                for statement in ADD_CATEGORIES:
                    db.execute(statement)
            else:
                db.execute('SELECT type,position,name,match_key FROM custom_categories LIMIT 0')
        elif appid or version or db.execute('SELECT 1 FROM sqlite_master LIMIT 1').fetchone():
            raise ValueError('既存の別形式・別バージョンのSQLiteは上書きしません。')
        else:
            for statement in (*SCHEMA_V1, *ADD_SETTINGS, *ADD_CATEGORIES):
                db.execute(statement)


def settings(state,allowed):
    """None means not provided by an older client; an empty mapping/list explicitly clears."""
    colors = rules = None
    if 'colors' in state:
        overrides = state['colors']
        if not isinstance(overrides, dict) or any(
                not any(k in names for names in allowed.values()) or not isinstance(v,str) or not re.fullmatch(r'#[A-Fa-f0-9]{6}',v)
                for k,v in overrides.items()):
            raise ValueError('既存カテゴリの色を #rrggbb 形式で指定してください。')
        colors = list(overrides.items())
    if 'rules' in state:
        raw = state['rules']
        if not isinstance(raw, list) or len(raw) > 500:
            raise ValueError('カテゴリルールは500件以内のリストで指定してください。')
        rules, seen = [], set()
        for i, rule in enumerate(raw):
            if (not isinstance(rule,dict) or set(rule) != {'prefix','type','category'} or
                    not isinstance(rule['type'],str) or rule['type'] not in ('income','expense') or
                    not isinstance(rule['category'],str) or rule['category'] not in allowed[rule['type']] or not isinstance(rule['prefix'],str)):
                raise ValueError(f'{i+1}件目のルールの種別・カテゴリ・接頭辞が不正です。')
            prefix = rule['prefix'].strip(JS_SPACE)
            key = unicodedata.normalize('NFKC',prefix).lower().strip(JS_SPACE)
            if (not sql.text(prefix,150) or not sql.text(key,150) or
                    len(prefix.encode('utf-16-le')) > 300 or len(key.encode('utf-16-le')) > 300):
                raise ValueError(f'{i+1}件目のルールは空ではない150文字以内の接頭辞を指定してください。')
            pair = (rule['type'],key)
            if pair in seen:
                raise ValueError(f'{i+1}件目のルールの種別と接頭辞が重複しています。')
            seen.add(pair)
            rules.append((i,prefix,rule['type'],rule['category'],key))
    return colors,rules


def project(state,custom):
    if not isinstance(state, dict) or set(state) - {'rows','budgets','goals','colors','rules','customCategories'}:
        raise ValueError('家計データの形式が不正です。')
    rows, budgets = sql.validate_projection({'format':'ledger-backup','version':4,'customCategories':custom,
                                           'rows':state.get('rows'),'budgets':state.get('budgets')})
    for n, row in enumerate(state['rows']):
        if 'key' in row and not sql.text(row['key'],8192,empty=True):
            raise ValueError(f'{n+1}件目の照合キーが不正です。')
        if set(row) - {'id','date','type','amount','category','title','source','key'}:
            raise ValueError(f'{n+1}件目に未対応の項目があります。削除せず保存を中止しました。')
    tx = [(*r,state['rows'][i].get('key'),i) for i,r in enumerate(rows)]
    goals=state.get('goals',[])
    if not isinstance(goals,list) or len(goals)>1024:
        raise ValueError('目標一覧の形式・件数が正しくありません。')
    goal_rows, ids = [], set()
    for i, g in enumerate(goals):
        if (not isinstance(g,dict) or set(g)-{'id','title','target','saved'} or
                not sql.text(g.get('id'),512) or not sql.text(g.get('title'),512) or
                not sql.positive(g.get('target')) or type(g.get('saved',0)) is not int or
                not 0 <= g.get('saved',0) <= sql.MAX_SAFE or g['id'] in ids):
            raise ValueError(f'{i+1}件目の目標が不正です。')
        ids.add(g['id'])
        goal_rows.append((g['id'],g['title'],g['target'],g.get('saved',0),i))
    return tx,budgets,goal_rows if 'goals' in state else None,*settings(state,sql.allowed_categories(custom))


def decode_row(r):
    d={k:r[k] for k in ('id','date','type','amount','category','title','source')}
    if r['import_key'] is not None:
        d['key']=r['import_key']
    return d


def read_custom(db):
    out=sql.empty_custom()
    for kind,name in db.execute('SELECT type,name FROM custom_categories ORDER BY type,position'):
        out[kind].append(name)
    return out


def read_state(path):
    with closing(connect(path)) as db, db:
        db.execute('BEGIN')  # Every table below belongs to this revision/snapshot.
        revision=db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0]
        rows=[decode_row(r) for r in db.execute('SELECT * FROM transactions ORDER BY position')]
        budgets=dict(db.execute('SELECT category,amount FROM budgets ORDER BY category'))
        goals=[dict(g) for g in db.execute('SELECT id,title,target,saved FROM goals ORDER BY position')]
        colors=dict(db.execute('SELECT category,color FROM category_colors ORDER BY category'))
        rules=[dict(r) for r in db.execute('SELECT prefix,type,category FROM category_rules ORDER BY position')]
        return {'revision':revision,'state':{'rows':rows,'budgets':budgets,'goals':goals,'colors':colors,'rules':rules,'customCategories':read_custom(db)}}


def save_state(path, state, expected):
    if type(expected) is not int or not 0 <= expected < sql.MAX_SAFE:
        raise ValueError('更新元のリビジョンが不正です。')
    if not isinstance(state,dict): raise ValueError('家計データの形式が不正です。')
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        cur=db.execute('UPDATE meta SET revision=revision+1 WHERE id=1 AND revision=?',(expected,))
        if cur.rowcount!=1:
            raise ApiError(409,'別の画面で更新されています。ページを再読み込みしてやり直してください。')
        # Resolve omitted registry against this exact revision. Validate retained settings
        # against a replacement registry too; reject references rather than deleting them.
        change_registry='customCategories' in state
        custom=sql.custom_categories(state['customCategories']) if change_registry else read_custom(db)
        effective=dict(state)
        if change_registry:
            if 'colors' not in state: effective['colors']=dict(db.execute('SELECT category,color FROM category_colors'))
            if 'rules' not in state: effective['rules']=[dict(r) for r in db.execute('SELECT prefix,type,category FROM category_rules ORDER BY position')]
        tx,budgets,goals,colors,rules = project(effective,custom)
        if change_registry:
            db.execute('DELETE FROM custom_categories')
            db.executemany('INSERT INTO custom_categories(type,position,name,match_key) VALUES(?,?,?,?)',
                           ((kind,i,name,name.lower()) for kind,names in custom.items() for i,name in enumerate(names)))
        # Full-state API; replacement is atomic and retains order + original CSV keys.
        db.execute('DELETE FROM transactions')
        db.execute('DELETE FROM budgets')
        db.executemany('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?)',tx)
        db.executemany('INSERT INTO budgets VALUES(?,?)',budgets)
        if goals is not None:
            db.execute('DELETE FROM goals')
            db.executemany('INSERT INTO goals VALUES(?,?,?,?,?)',goals)
        if 'colors' in state:
            db.execute('DELETE FROM category_colors')
            db.executemany('INSERT INTO category_colors(category,color) VALUES(?,?)',colors)
        if 'rules' in state:
            db.execute('DELETE FROM category_rules')
            db.executemany('INSERT INTO category_rules(position,prefix,type,category,match_key) VALUES(?,?,?,?,?)',rules)
        return expected+1


def query_rows(path, start, end, category, top=None, expected=None):
    if not sql.valid_date(start) or not sql.valid_date(end) or start>end:
        raise ValueError('期間は開始日 ≤ 終了日の YYYY-MM-DD で指定してください。')
    if category and not sql.text(category,512):
        raise ValueError('カテゴリが不正です。')
    if top is not None and (type(top) is not int or not 1<=top<=1000):
        raise ValueError('上位件数は1〜1000です。')
    q='SELECT * FROM transactions WHERE date BETWEEN :start AND :end'
    if category:
        q+=' AND category=:category'
    params={'start':start,'end':end,'category':category,'n':top}
    if top is not None:
        q='''WITH filtered AS ('''+q+''' AND type='expense'), ranked AS (
          SELECT *,ROW_NUMBER() OVER (PARTITION BY category ORDER BY amount DESC,date DESC,id) AS rn FROM filtered)
          SELECT * FROM ranked WHERE rn<=:n ORDER BY category,rn'''
    else:
        q+=' ORDER BY date DESC,id'
    with closing(connect(path)) as db, db:
        db.execute('BEGIN')
        if expected is not None and db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0]!=expected:
            raise ApiError(409,'別の画面で更新されています。分析する前に再読み込みしてください。')
        return [decode_row(r) for r in db.execute(q,params)]


def page_assets(root):
    html=(root/'index.html').read_text(encoding='utf-8')
    if '</head>' not in html: raise ValueError('ビルド済みのindex.htmlを確認してください。')
    html=html.replace('</head>','<script src="/sqlite-client.js"></script></head>',1)
    # Permit precisely the built HTML's inline scripts, not arbitrary inline/eval handlers.
    hashes=[]
    for content in re.findall(r'<script\b[^>]*>(.*?)</script\s*>',html,re.I|re.S):
        if content: hashes.append("'sha256-"+base64.b64encode(hashlib.sha256(content.encode('utf-8')).digest()).decode('ascii')+"'")
    csp=("default-src 'none'; script-src 'self' "+' '.join(hashes)+"; style-src 'self' 'unsafe-inline'; "
         "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; "
         "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    return html.encode('utf-8'),(root/'sqlite-client.js').read_bytes(),csp


class Server(ThreadingHTTPServer):
    daemon_threads=True
    allow_reuse_address=False
    def get_request(self):
        sock,addr=super().get_request()
        sock.settimeout(10)
        return sock,addr


class Handler(BaseHTTPRequestHandler):
    server_version='TallySQLite'
    sys_version=''
    def log_message(self,*args): pass  # Do not log dates, category filters or amounts.

    def reply(self,status,data,ctype):
        self.send_response(status)
        self.send_header('Content-Type',ctype)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','same-origin')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Cross-Origin-Resource-Policy','same-origin')
        self.send_header('Content-Security-Policy',self.server.csp)
        self.end_headers()
        if self.command!='HEAD': self.wfile.write(data)

    def json(self,status,obj):
        self.reply(status,json.dumps(obj,ensure_ascii=False,separators=(',',':')).encode('utf-8'),'application/json; charset=utf-8')

    def dispatch(self):
        if self.client_address[0]!='127.0.0.1' or self.headers.get_all('Host')!=[self.server.authority]:
            raise ApiError(403,'ローカルの正規URL以外は利用できません。')
        origin=self.headers.get_all('Origin')
        if origin and origin!=[self.server.origin]: raise ApiError(403,'異なるオリジンは利用できません。')
        route=urlsplit(self.path)
        if route.scheme or route.netloc: raise ApiError(400,'相対パスを使ってください。')
        api=route.path.startswith('/api/')
        if api:
            if (self.headers.get_all('X-Tally-Client')!=['sqlite-v1'] or
                    self.headers.get('Sec-Fetch-Site','same-origin')!='same-origin'):
                raise ApiError(403,'アプリ内からのみ利用できます。')
        if self.command=='OPTIONS': raise ApiError(403,'クロスオリジン通信は利用できません。')
        if self.command=='POST':
            if route.path!='/api/state' or route.query: raise ApiError(404,'対象がありません。')
            if origin!=[self.server.origin]: raise ApiError(403,'正規のオリジンが必要です。')
            if self.headers.get_content_type()!='application/json': raise ApiError(415,'JSONを指定してください。')
            lengths=self.headers.get_all('Content-Length') or []
            if len(lengths)!=1 or not re.fullmatch(r'[0-9]{1,9}',lengths[0]) or 'Transfer-Encoding' in self.headers:
                raise ApiError(400,'本文のサイズが不正です。')
            n=int(lengths[0]);
            if n>MAX_BODY: raise ApiError(413,'本文が大きすぎます。')
            raw=self.rfile.read(n)
            if len(raw)!=n: raise ApiError(400,'本文を読み取れません。')
            payload=json.loads(raw.decode('utf-8'))
            if not isinstance(payload,dict) or set(payload)!={'expectedRevision','nextState'}: raise ValueError('保存形式が不正です。')
            rev=save_state(self.server.db_path,payload['nextState'],payload['expectedRevision'])
            return self.json(200,{'revision':rev})
        if route.path in ('/','/index.html') and not route.query: return self.reply(200,self.server.html,'text/html; charset=utf-8')
        if route.path=='/sqlite-client.js' and not route.query: return self.reply(200,self.server.client,'text/javascript; charset=utf-8')
        if route.path=='/api/state' and not route.query: return self.json(200,read_state(self.server.db_path))
        if route.path in ('/api/top','/api/period'):
            q=parse_qs(route.query,keep_blank_values=True,strict_parsing=True,max_num_fields=5)
            allowed={'start','end','category','revision'}|({'limit'} if route.path=='/api/top' else set())
            if set(q)-allowed or any(len(v)!=1 for v in q.values()): raise ValueError('検索条件が不正です。')
            top=int(q.get('limit',['5'])[0]) if route.path=='/api/top' else None
            expected=int(q['revision'][0]) if 'revision' in q else None
            rows=query_rows(self.server.db_path,q.get('start',[None])[0],q.get('end',[None])[0],q.get('category',[''])[0],top,expected)
            return self.json(200,{'rows':rows})
        raise ApiError(404,'対象がありません。')

    def handle_route(self):
        try: self.dispatch()
        except ApiError as err: self.json(err.status,{'error':str(err)})
        except (json.JSONDecodeError,UnicodeError,RecursionError): self.json(400,{'error':'有効なUTF-8 JSONを指定してください。'})
        except ValueError as err: self.json(400,{'error':str(err)})
        except sqlite3.OperationalError: self.json(503,{'error':'SQLiteを利用できません。容量・ロック・アクセス権を確認してください。'})
        except sqlite3.DatabaseError: self.json(500,{'error':'SQLite処理に失敗しました。元データは変更されていません。'})
    do_GET=do_HEAD=do_POST=do_OPTIONS=handle_route


def default_db():
    home=os.environ.get('LOCALAPPDATA') if os.name=='nt' else os.environ.get('XDG_DATA_HOME')
    return (Path(home) if home else Path.home()/('.local/share' if os.name!='nt' else 'AppData/Local'))/'Tally'/'ledger.sqlite3'


def create_server(path,port=8766,root=ROOT):
    html,client,csp=page_assets(root)
    serv=Server(('127.0.0.1',port),Handler)
    try:
        serv.db_path=Path(path).resolve()
        initialize(serv.db_path)
        serv.authority=f'127.0.0.1:{serv.server_address[1]}'
        serv.origin='http://'+serv.authority
        serv.html,serv.client,serv.csp=html,client,csp
        return serv
    except BaseException:
        serv.server_close()
        raise


def main():
    p=argparse.ArgumentParser(description='Tally SQLite | Windowsローカル専用')
    p.add_argument('--db',type=Path,default=default_db(),help='SQLiteファイル（既定: LocalAppData/Tally/ledger.sqlite3）')
    p.add_argument('--port',type=int,default=8766,help='127.0.0.1のみ。0は自動割り当て')
    p.add_argument('--no-browser',action='store_true',help='ブラウザを自動で開かない')
    a=p.parse_args()
    if not 0<=a.port<=65535: p.error('ポート範囲は0〜65535です。')
    try:
        with create_server(a.db,a.port) as server:
            print(f'Tally SQLite: {server.origin}/',flush=True)
            print(f'保存先: {server.db_path}\nこのウィンドウを閉じるか Ctrl+C で終了します。',flush=True)
            if not a.no_browser: threading.Thread(target=webbrowser.open,args=(server.origin+'/',),daemon=True).start()
            server.serve_forever()
    except KeyboardInterrupt: pass
    except (OSError,sqlite3.Error,ValueError) as err:
        p.exit(1,f'起動できません: {err}\n')


if __name__=='__main__': main()
