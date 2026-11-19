#!/usr/bin/env python3
"""Read-only, local SQLite analytics for Tally JSON backups; Python 3.8+."""
import argparse
import csv
from contextlib import closing
from datetime import date
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import unicodedata

MAX_BYTES = 16 * 1024 * 1024
MAX_SAFE = (1 << 53) - 1
TYPES = ('income', 'expense', 'transfer')
BUILTIN = {'expense':('食費','日用品','交通','趣味','固定費','その他支出'),
           'income':('給与','副収入','その他収入'), 'transfer':('振替',)}
# Names are keys in browser dictionaries too. Re-check after Unicode canonicalization.
RESERVED = frozenset(s.lower() for s in ('constructor','prototype','__proto__','__defineGetter__',
                     '__defineSetter__','hasOwnProperty','__lookupGetter__','__lookupSetter__',
                     'isPrototypeOf','propertyIsEnumerable','toString','valueOf','toLocaleString'))
JS_SPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

def empty_custom():
    return {'expense':[],'income':[]}

def custom_categories(raw):
    out=empty_custom()
    if not isinstance(raw,dict) or set(raw)!=set(out):
        raise ValueError('追加カテゴリには支出と収入のリストが必要です。')
    seen=set(RESERVED).union(*(set(names) for names in BUILTIN.values()))
    def unsafe(s):
        return any(c in '<>&\"\'`' or unicodedata.category(c) in ('Cc','Cf','Cs','Zl','Zp') for c in s)
    for kind, values in out.items():
        names=raw[kind]
        if not isinstance(names,list) or len(names)>100: raise ValueError('追加カテゴリは各種別100件までです。')
        for s in names:
            if not isinstance(s,str) or unsafe(s): raise ValueError('使用できないカテゴリ名です。')
            name=unicodedata.normalize('NFKC',s).strip(JS_SPACE)
            if not name or unsafe(name) or len(name.encode('utf-16-le'))>64: raise ValueError('カテゴリ名は1〜32文字で指定してください。')
            key=name.lower()
            if key in seen: raise ValueError('カテゴリ名が予約名・既存の名前と重複しています。')
            seen.add(key);values.append(name)
    return out

def allowed_categories(custom):
    return {kind:set(names).union(custom.get(kind,())) for kind,names in BUILTIN.items()}
SCHEMA = '''
BEGIN;
CREATE TABLE transactions (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
    amount INTEGER NOT NULL CHECK (typeof(amount)='integer' AND amount>0),
    category TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL
);
CREATE TABLE budgets (category TEXT PRIMARY KEY NOT NULL, amount INTEGER NOT NULL CHECK(amount>0));
CREATE INDEX tx_date ON transactions(date);
CREATE INDEX tx_type_date ON transactions(type,date);
CREATE INDEX tx_category_date ON transactions(category,date);
CREATE VIEW v_ledger AS
SELECT t.*, substr(date,1,7) AS month,
 CASE type WHEN 'income' THEN amount WHEN 'expense' THEN -amount ELSE 0 END AS signed_amount
FROM transactions t;
CREATE VIEW v_monthly_cashflow AS
SELECT month, SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
 SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
 SUM(CASE WHEN type='transfer' THEN amount ELSE 0 END) AS transfer,
 SUM(signed_amount) AS net, COUNT(*) AS count FROM v_ledger GROUP BY month;
CREATE VIEW v_monthly_categories AS
SELECT month,type,category,SUM(amount) AS total,COUNT(*) AS count
FROM v_ledger GROUP BY month,type,category;
PRAGMA user_version=1;
'''
TOP_SQL = '''SELECT id,date,type,amount,category,title,source,rank FROM (
 SELECT *, ROW_NUMBER() OVER (PARTITION BY type,category ORDER BY amount DESC,date DESC,id) AS rank
 FROM filtered
) WHERE rank<=:top ORDER BY type,category,rank'''
REPORTS = {
    'top': TOP_SQL,
    'merchants': '''SELECT type,category,title,total,count,rank FROM (
        SELECT type,category,title,SUM(amount) AS total, COUNT(*) AS count,
        ROW_NUMBER() OVER (PARTITION BY type,category ORDER BY SUM(amount) DESC,title) AS rank
        FROM filtered GROUP BY type,category,title
    ) WHERE rank<=:top ORDER BY type,category,rank''',
    'categories': '''SELECT type,category,SUM(amount) AS total,COUNT(*) AS count
        FROM filtered GROUP BY type,category ORDER BY type,total DESC,category''',
    'monthly': '''SELECT month,SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
        SUM(CASE WHEN type='transfer' THEN amount ELSE 0 END) AS transfer,
        SUM(signed_amount) AS net, COUNT(*) AS count FROM filtered GROUP BY month ORDER BY month''',
}
COLUMNS = {
    'top': ('id','date','type','amount','category','title','source','rank'),
    'merchants': ('type','category','title','total','count','rank'),
    'categories': ('type','category','total','count'),
    'monthly': ('month','income','expense','transfer','net','count'),
}


def valid_date(value):
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        return value >= '1900-01-01' and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def text(value, limit, empty=False):
    if not (isinstance(value, str) and len(value) <= limit and (empty or value.strip()) and '\0' not in value):
        return False
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeEncodeError:
        return False
    return True


def positive(value):
    return type(value) is int and 0 < value <= MAX_SAFE


def load_backup(path):
    """Validate the whole backup, then return its analysis projection."""
    with Path(path).open('rb') as f:
        data = f.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('バックアップの上限は16 MiBです。')
    try:
        raw = json.loads(data.decode('utf-8-sig'))
    except (UnicodeError, ValueError, RecursionError):
        raise ValueError('UTF-8のJSONバックアップを選んでください。') from None
    return validate_projection(raw)


def validate_projection(raw):
    """Validate an analysis projection shared with the loopback database adapter."""
    if (not isinstance(raw, dict) or raw.get('format') != 'ledger-backup' or
            type(raw.get('version')) is not int or raw['version'] not in (1,2,3,4)):
        raise ValueError('Tallyのバージョン1〜4 JSONバックアップに対応しています。')
    # Old analysis exports did not declare a registry. Enforce referential integrity for v4.
    allowed = None
    if raw['version']==4:
        allowed=allowed_categories(custom_categories(raw.get('customCategories')))
        overrides=raw.get('colors',{});rules=raw.get('rules',[])
        if (not isinstance(overrides,dict) or any(c not in set.union(*allowed.values()) for c in overrides)
                or not isinstance(rules,list) or len(rules)>500):
            raise ValueError('色またはルールのカテゴリ指定を確認してください。')
        for r in rules:
            if (not isinstance(r,dict) or r.get('type') not in ('income','expense') or
                    not isinstance(r.get('category'),str) or r['category'] not in allowed[r['type']]):
                raise ValueError('未登録・種別違いのルール対象カテゴリです。')
    rows, budgets = raw.get('rows'), raw.get('budgets')
    if not isinstance(rows, list) or len(rows) > 100000 or not isinstance(budgets, dict) or len(budgets) > 1024:
        raise ValueError('取引・予算の形式または件数が正しくありません。')
    checked, ids, total = [], set(), 0
    for i, r in enumerate(rows, 1):
        if not isinstance(r, dict):
            raise ValueError(f'{i}件目の取引が不正です。')
        rid = r.get('id')
        if type(rid) is int and abs(rid) <= MAX_SAFE:
            rid = str(rid)
        if not (text(rid, 512) and valid_date(r.get('date')) and r.get('type') in TYPES and
                positive(r.get('amount')) and text(r.get('category'), 512) and
                text(r.get('title'), 8192) and text(r.get('source'), 2048, empty=True)):
            raise ValueError(f'{i}件目の取引のID・日付・分類・金額・文字列を確認してください。')
        if allowed is not None and r['category'] not in allowed[r['type']]:
            raise ValueError(f'{i}件目の取引は未登録・種別違いのカテゴリを参照しています。')
        if rid in ids:
            raise ValueError(f'{i}件目の取引IDが重複しています。')
        ids.add(rid)
        total += r['amount']
        checked.append((rid,r['date'],r['type'],r['amount'],r['category'],r['title'],r['source']))
    if total > (1 << 63) - 1:
        raise ValueError('総額がSQLiteの整数精度の範囲を超えています。')
    if any(not text(c, 512) or not positive(v) or (allowed is not None and c not in allowed['expense']) for c, v in budgets.items()):
        raise ValueError('予算のカテゴリ・金額を確認してください。')
    return checked, list(budgets.items())


def open_analysis(path):
    """Return an in-memory SQLite connection. Caller closes it; no network/disk DB."""
    if sqlite3.sqlite_version_info < (3, 25, 0):
        raise ValueError('SQLite 3.25以上を含むPythonが必要です。')
    rows, budgets = load_backup(path)
    db = sqlite3.connect(':memory:')
    try:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA temp_store=MEMORY')
        # executescript explicitly opens a transaction, so DDL and all inserts commit together.
        with db:
            db.executescript(SCHEMA)
            db.executemany('INSERT INTO transactions VALUES (?,?,?,?,?,?,?)', rows)
            db.executemany('INSERT INTO budgets VALUES (?,?)', budgets)
        db.execute('PRAGMA query_only=ON')
        return db
    except BaseException:
        db.close()
        raise


def report(db, mode='top', *, start=None, end=None, category=None, txn_type='expense', top=5):
    """Run an allowlisted parameterized SELECT; returns list[dict]. Bounds inclusive."""
    if mode not in REPORTS or txn_type not in (*TYPES, 'all'):
        raise ValueError('未知のレポートまたは種別です。')
    if type(top) is not int or not 1 <= top <= 1000:
        raise ValueError('--top は1〜1000の整数で指定してください。')
    if (start is not None and not valid_date(start)) or (end is not None and not valid_date(end)):
        raise ValueError('期間は実在する日付を YYYY-MM-DD で指定してください。')
    if start and end and start > end:
        raise ValueError('開始日は終了日以前にしてください。')
    if category is not None and not text(category, 512):
        raise ValueError('カテゴリ名は1〜512文字で指定してください。')
    clauses, args = [], {'top': top}
    for val, key, clause in ((start,'start','date>=:start'), (end,'end','date<=:end'),
                             (category,'category','category=:category'),
                             (None if txn_type=='all' else txn_type,'type','type=:type')):
        if val is not None:
            args[key] = val
            clauses.append(clause)
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    sql = 'WITH filtered AS (SELECT * FROM v_ledger' + where + ') ' + REPORTS[mode]
    return [dict(row) for row in db.execute(sql, args)]


def export_db(db, path):
    """Export the whole analysis snapshot; atomically reserve a new target, never overwrite."""
    target = Path(path).absolute()
    fd = os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    identity = os.fstat(fd)
    os.close(fd)
    try:
        with closing(sqlite3.connect(str(target))) as dest:
            db.backup(dest)
    except BaseException:
        # Only undo the exact newly-created target; never remove a pre-existing/replaced file.
        if target.exists() and os.path.samestat(identity, target.stat()):
            target.unlink()
        raise


def csv_cell(value):
    if not isinstance(value, str):
        return value
    normalized = unicodedata.normalize('NFKC', value)
    i = 0
    while i < len(normalized) and (normalized[i].isspace() or unicodedata.category(normalized[i]) in ('Cc', 'Cf')):
        i += 1
    if value.startswith(('\t','\r','\n')) or normalized[i:i+1] in ('=', '+', '-', '@'):
        return "'" + value
    return value


def encoded(rows, mode, fmt):
    if fmt == 'json':
        return (json.dumps(rows, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    s = io.StringIO(newline='')
    w = csv.writer(s)
    w.writerow(COLUMNS[mode])
    w.writerows(tuple(csv_cell(r[k]) for k in COLUMNS[mode]) for r in rows)
    return s.getvalue().encode('utf-8-sig')


def main(argv=None):
    p = argparse.ArgumentParser(description='Tally: オフラインSQLite分析（JSONを変更しません）')
    p.add_argument('backup', type=Path, help='Tallyから保存したJSONバックアップ')
    p.add_argument('--report', choices=REPORTS, default='top', help='既定: top（カテゴリ別・取引上位）')
    p.add_argument('--period-start', metavar='YYYY-MM-DD', help='開始日、この日を含む')
    p.add_argument('--period-end', metavar='YYYY-MM-DD', help='終了日、この日を含む')
    p.add_argument('--category', help='カテゴリ完全一致')
    p.add_argument('--type', choices=(*TYPES,'all'), default='expense', help='既定: expense。全収支はall')
    p.add_argument('--top', type=int, default=5, help='カテゴリ別上位件数、1〜1000。top/merchantsのみ適用')
    p.add_argument('--format', choices=('json','csv'), default='json')
    p.add_argument('--output', type=Path, help='レポートの新規保存先。省略時は標準出力')
    p.add_argument('--export-db', type=Path, help='任意：フィルタ前の全取引・予算を新規.sqliteに保存')
    p.add_argument('--version', action='version', version=f'Tally SQL 1 / SQLite {sqlite3.sqlite_version}')
    a = p.parse_args(argv)
    try:
        paths = [q.resolve() for q in (a.output, a.export_db) if q is not None]
        if len(set(paths)) != len(paths) or any(q.exists() for q in paths):
            raise ValueError('保存先はそれぞれ別の、新規ファイルを指定してください（上書き禁止）。')
        with closing(open_analysis(a.backup)) as db:
            rows = report(db, a.report, start=a.period_start, end=a.period_end, category=a.category,
                          txn_type=a.type, top=a.top)
            payload = encoded(rows, a.report, a.format)
            if a.export_db is not None:
                export_db(db, a.export_db)
            if a.output is not None:
                with a.output.open('xb') as f:
                    f.write(payload)
            else:
                sys.stdout.buffer.write(payload)
    except (OSError, sqlite3.Error, ValueError) as err:
        p.exit(2, f'Tally SQL: {err}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
