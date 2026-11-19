/* Run: node tests/sql-cli.cjs. Optional TALLY_PYTHON = full path of a Python 3 executable.
 * Real stdlib SQLite DBs and HTTP loopback. No real backup, browser profile, npm or pip.
 */
'use strict';
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const python = process.env.TALLY_PYTHON || (process.platform==='win32'?'py':'python3');
const prefix = process.platform==='win32'&&!process.env.TALLY_PYTHON?['-3']:[];
const suite = String.raw`
import base64, concurrent.futures, csv, hashlib, http.client, json, os, re, sqlite3, sys, tempfile, threading, unittest
from contextlib import closing, redirect_stderr
from io import StringIO
from pathlib import Path
from urllib.parse import urlencode
import tally_db as db
import tally_sql as cli

def tx(rid, category, value, day='2024-02-01', kind='expense',title=None):
    return dict(id=rid,date=day,type=kind,category=category,amount=value,title=title or 'Test '+rid,source='PayPay',key='k:'+rid)

def fixture():
    return {'format':'ledger-backup','version':2,'rows':[
        tx('a','食費',1200,'2024-02-29',title=' =1+1'),tx('z','食費',1200),
        tx('b','食費',1200,'2024-02-29',title='Comma, "Cafe"'),tx('outside','食費',9000,'2024-03-01'),
        tx('x','交通',3000),tx('y','交通',2300),tx('more','交通',500),
        tx('s','給与',9500,kind='income'),tx('tr','振替',10000,kind='transfer')
    ],'budgets':{'食費':10000},'goals':[dict(id='g',title='Travel',target=50000,saved=1000)]}

def state():
    p=fixture(); return dict({k:p[k] for k in ('rows','budgets','goals')}, customCategories=cli.empty_custom(),colors={'食費':'#Aa12BC','振替':'#010203'},
        rules=[dict(prefix='本屋',type='expense',category='趣味'),dict(prefix='ＭｙＳｈｏｐ',type='expense',category='食費'),
               dict(prefix='myshop',type='income',category='副収入')])

class SQL(unittest.TestCase):
    def setUp(self):
        import uuid, shutil
        parent=(Path.cwd()/'tests').resolve(); self.tmpdir=parent/('sql-tmp-'+uuid.uuid4().hex)
        self.tmpdir.mkdir()  # inherit workspace ACLs; do not write to OS temp or real AppData
        def clean():
            checked=self.tmpdir.resolve()
            if checked.parent!=parent or not re.fullmatch('sql-tmp-[0-9a-f]{32}',checked.name): raise RuntimeError('Invalid test fixture path')
            shutil.rmtree(checked)
        self.addCleanup(clean)
        self.back=self.tmpdir/'backup.json';self.db=self.tmpdir/'records.sqlite'
        self.back.write_text(json.dumps(fixture(),ensure_ascii=False),encoding='utf-8-sig')

    def test_cli_real_sqlite_views_indexes_ties_and_dates(self):
        with closing(cli.open_analysis(self.back)) as conn:
            rows=cli.report(conn,start='2024-02-01',end='2024-02-29',top=2)
            self.assertEqual([r['id'] for r in rows if r['category']=='食費'],['a','b'])
            self.assertEqual([r['id'] for r in rows if r['category']=='交通'],['x','y'])
            self.assertEqual(len(rows),4)
            periods=cli.report(conn,'monthly',txn_type='all');self.assertEqual(periods[0],dict(month='2024-02',income=9500,expense=9400,transfer=10000,net=100,count=8))
            self.assertEqual(dict(conn.execute('select * from v_monthly_cashflow order by month limit 1').fetchone()),periods[0])
            self.assertTrue(conn.execute('select * from v_monthly_categories').fetchall())
            self.assertIn('tx_type_date', [r[1] for r in conn.execute('pragma index_list(transactions)')]);
            with self.assertRaises(sqlite3.OperationalError):conn.execute('delete from budgets')
            self.assertEqual(cli.report(conn,category="食費' OR 1=1 --"),[])
            self.assertEqual(len(cli.report(conn,'merchants',category='食費',top=2)),2)
            self.assertEqual(cli.report(conn,'categories',category='食費')[0]['total'],12600)
            for invalid in [dict(top=0),dict(start='2023-02-29'),dict(start='2024-03-01',end='2024-02-29')]:
                with self.assertRaises(ValueError):cli.report(conn,**invalid)

    def test_cli_explicit_exports_and_unchanged_input(self):
        before=self.back.read_bytes(); out=self.tmpdir/'report.csv'
        self.assertEqual(cli.main([str(self.back),'--category','食費','--top','100','--period-start','2024-02-02','--period-end','2024-02-29','--format','csv','--output',str(out),'--export-db',str(self.db)]),0)
        with out.open(encoding='utf-8-sig',newline='') as f:rows=list(csv.DictReader(f))
        self.assertEqual([r['id'] for r in rows],['a','b']);self.assertEqual(rows[0]['title'],"' =1+1");self.assertEqual(rows[1]['title'],'Comma, "Cafe"')
        with closing(sqlite3.connect(str(self.db))) as conn:
            self.assertEqual(conn.execute('select count(*) from transactions').fetchone()[0],9)
            self.assertEqual(conn.execute('select amount from budgets').fetchone()[0],10000)
        result=out.read_bytes()
        with redirect_stderr(StringIO()),self.assertRaises(SystemExit):cli.main([str(self.back),'--output',str(out)])
        self.assertEqual(result,out.read_bytes());self.assertEqual(before,self.back.read_bytes())

    def test_backup_validation_and_compatibility(self):
        for version in [1,2,3]:
            p=fixture();p['version']=version
            if version==3:p.update(colors=state()['colors'],rules=state()['rules'])
            self.back.write_text(json.dumps(p),encoding='utf-8')
            with closing(cli.open_analysis(self.back)) as conn:
                self.assertEqual(cli.report(conn,top=1,category='食費')[0]['id'],'outside')
                self.assertEqual({r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")},{'transactions','budgets'})
        for change in ('duplicate','truth','bad-date','overlong','unknown-version'):
            p=fixture()
            if change=='duplicate':p['rows'].append(p['rows'][0])
            if change=='truth':p['rows'][0]['amount']=True
            if change=='bad-date':p['rows'][0]['date']='2024-02-30'
            if change=='overlong':p['rows'][0]['title']='X'*8193
            if change=='unknown-version':p['version']=99
            self.back.write_text(json.dumps(p),encoding='utf-8')
            with self.assertRaises(ValueError):cli.open_analysis(self.back)

    def test_transaction_rollback_reopen_and_conflicting_concurrent_writers(self):
        db.initialize(self.db); first=state();self.assertEqual(db.save_state(self.db,first,0),1)
        db.initialize(self.db); self.assertEqual(db.read_state(self.db),dict(revision=1,state=first))
        with closing(sqlite3.connect(str(self.db))) as c,c:
            c.execute("CREATE TRIGGER fail BEFORE INSERT ON budgets BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):db.save_state(self.db,first,1)
        self.assertEqual(db.read_state(self.db),dict(revision=1,state=first))
        with closing(sqlite3.connect(str(self.db))) as c,c:c.execute('DROP TRIGGER fail')
        def writer(i):
            s=state();s['goals'][0]['saved']=i
            try:return db.save_state(self.db,s,1)
            except db.ApiError as err:return err.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex: vals=list(ex.map(writer,[55,66]))
        self.assertEqual(sorted(vals),[2,409]);self.assertIn(db.read_state(self.db)['state']['goals'][0]['saved'],[55,66])
        other=self.tmpdir/'not-tally.sqlite';
        with closing(sqlite3.connect(str(other))) as c,c:c.execute('create table other(x)')
        with self.assertRaises(ValueError):db.initialize(other)
        with closing(sqlite3.connect(str(other))) as c:self.assertEqual(c.execute('select count(*) from sqlite_master').fetchone()[0],1)

    def test_additive_schema_migration_preserves_data_and_revision(self):
        old=fixture(); legacy={k:old[k] for k in ('rows','budgets','goals')}
        # Build the exact old format, with significant row ordering and CSV identity keys.
        with closing(db.connect(self.db)) as c,c:
            c.execute('BEGIN')
            for stmt in db.SCHEMA_V1:c.execute(stmt)
            for i,r in enumerate(legacy['rows']):
                v=[r[k] for k in ('id','date','type','amount','category','title','source','key')]
                c.execute('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?)',v+[i])
            c.executemany('INSERT INTO budgets VALUES(?,?)',legacy['budgets'].items())
            g=legacy['goals'][0];c.execute('INSERT INTO goals VALUES(?,?,?,?,0)',[g[k] for k in ('id','title','target','saved')]);c.execute('UPDATE meta SET revision=42')
        db.initialize(self.db);db.initialize(self.db)
        self.assertEqual(db.read_state(self.db),dict(revision=42,state=dict(legacy,colors={},rules=[],customCategories=cli.empty_custom())))
        with closing(db.connect(self.db)) as c:self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],3)
        self.assertEqual(db.save_state(self.db,state(),42),43)
        self.assertEqual(db.read_state(self.db),dict(revision=43,state=state()))

    def test_v2_settings_survive_additive_migration(self):
        with closing(db.connect(self.db)) as c,c:
            c.execute('BEGIN')
            for stmt in (*db.SCHEMA_V1,*db.ADD_SETTINGS): c.execute(stmt)
            c.execute("INSERT INTO category_colors VALUES('交通','#123456')")
            c.execute("INSERT INTO category_rules VALUES(0,'Ａ','expense','交通','a')")
            c.execute("UPDATE meta SET revision=7")
        db.initialize(self.db);db.initialize(self.db)
        r=db.read_state(self.db);self.assertEqual(r['revision'],7);self.assertEqual(r['state']['customCategories'],cli.empty_custom());self.assertEqual(r['state']['colors'],{'交通':'#123456'});self.assertEqual(r['state']['rules'],[dict(prefix='Ａ',type='expense',category='交通')]);

    def test_registered_references_survive_old_client_and_reject_partial_drop(self):
        db.initialize(self.db);s=state();s['customCategories']={'expense':['Pet','推し活'],'income':['配当']};s['rows'].extend([tx('pet','Pet',2700),tx('div','配当',1550,kind='income')]);s['budgets']['Pet']=15000;s['colors'].update(Pet='#Aa2233',配当='#112233');s['rules'].append(dict(type='expense',category='Pet',prefix='病院'))
        raw=dict(s,customCategories={'expense':['　Ｐｅｔ　','推し活'],'income':['配当']});self.assertEqual(db.save_state(self.db,raw,0),1);self.assertEqual(db.read_state(self.db),dict(revision=1,state=s));self.assertEqual(db.query_rows(self.db,'2024-02-01','2024-02-29','Pet',3)[0]['id'],'pet')
        self.assertEqual(db.save_state(self.db,dict(rows=s['rows'],budgets=s['budgets']),1),2);prior=dict(revision=2,state=s);self.assertEqual(db.read_state(self.db),prior)
        for x in [dict(s,customCategories=cli.empty_custom()),dict(rows=[],budgets={},customCategories=cli.empty_custom()),dict(s,rows=[tx('wrong','Pet',3,kind='income')]),dict(s,budgets={'配当':1}),dict(s,rules=[dict(prefix='inc',type='income',category='Pet')]),dict(s,colors={'PET':'#abcdef'})]:
            with self.assertRaises(ValueError):db.save_state(self.db,x,2)
            self.assertEqual(db.read_state(self.db),prior)
        self.assertEqual(db.save_state(self.db,dict(rows=[],budgets={},colors={},rules=[],customCategories=cli.empty_custom()),2),3)
        self.assertEqual(db.read_state(self.db)['state']['customCategories'],cli.empty_custom())

    def test_backup_v4_registry_and_category_validation(self):
        p=dict(state(),format='ledger-backup',version=4,customCategories={'expense':['旅行'],'income':['配当']});p['rows'].append(tx('a99','旅行',77));p['budgets']['旅行']=88;p['rules'].append(dict(type='income',prefix='入金',category='配当'));p['colors']['旅行']='#aabbcc';self.back.write_text(json.dumps(p),encoding='utf8')
        with closing(cli.open_analysis(self.back)) as c:self.assertEqual(cli.report(c,category='旅行')[0]['amount'],77)
        for x in [dict(p,customCategories=cli.empty_custom()),dict(p,rows=[tx('a','旅行',1,kind='transfer')]),dict(p,budgets={'配当':1}),dict(p,rules=[dict(type='expense',prefix='A',category='配当')]),dict(p,colors={'unknown':'#123456'})]:
            with self.assertRaises(ValueError):cli.validate_projection(x)
        for name in ('','食費','振替','__proto__','ｔｏＳｔｒｉｎｇ','"','＜','x\n','X\u0000','‮','🏡'*17,'＆'):
            with self.assertRaises(ValueError):cli.custom_categories({'expense':[name],'income':[]})
        for custom in (None,[],{'expense':[' ＦＯＯ '],'income':['foo']},{'expense':[],'income':[],'transfer':[]},{'expense':[str(i) for i in range(101)],'income':[]}):
            with self.assertRaises(ValueError):cli.custom_categories(custom)

    def test_failed_migration_rolls_back_all_ddl(self):
        with closing(db.connect(self.db)) as c,c:
            c.execute('BEGIN')
            for stmt in db.SCHEMA_V1:c.execute(stmt)
            c.execute('CREATE TABLE category_rules(legacy TEXT)');c.execute("INSERT INTO category_rules VALUES('keep')")
        with self.assertRaises(sqlite3.OperationalError):db.initialize(self.db)
        with closing(db.connect(self.db)) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],1)
            self.assertEqual(c.execute('SELECT legacy FROM category_rules').fetchone()[0],'keep')
            self.assertEqual(c.execute("SELECT count(*) FROM sqlite_master WHERE name='category_colors'").fetchone()[0],0)

    def test_settings_validation_older_clients_and_explicit_reset(self):
        db.initialize(self.db); original=state();payload=state();payload['rules'][0]['prefix']='\ufeff 本屋　'
        self.assertEqual(db.save_state(self.db,payload,0),1)
        self.assertEqual(db.read_state(self.db)['state'],original)
        dup=dict(prefix='  MyShOp  ',type='expense',category='交通');base=original['rules'][1]
        for changes in [dict(colors={'unknown':'#111111'}),dict(colors={'食品':'#123456'}),dict(colors={'食費':'#fff'}),dict(colors={'食費':'#1234567'}),dict(colors=[]),
                dict(rules=original['rules']+[dup]),dict(rules=[dict(base,prefix='　')]),dict(rules=[dict(base,prefix='x'*151)]),
                dict(rules=[dict(base,prefix='ﷺ'*12)]),dict(rules=[dict(base,type='transfer',category='振替')]),
                dict(rules=[dict(base,category='給与')]),dict(rules=[dict(base,extra='invalid')]),dict(rules=[base]*501),dict(rules=None)]:
            with self.subTest(changes=str(changes)[:40]),self.assertRaises(ValueError):db.save_state(self.db,dict(original,**changes),1)
            self.assertEqual(db.read_state(self.db),dict(revision=1,state=original))
        older={'rows':original['rows'][:2],'budgets':{}}
        self.assertEqual(db.save_state(self.db,older,1),2)
        self.assertEqual(db.read_state(self.db)['state'],dict(original,**older))
        # One optional property can be cleared without resetting another.
        self.assertEqual(db.save_state(self.db,dict(older,rules=[]),2),3)
        self.assertEqual(db.read_state(self.db)['state'],dict(original,**older,rules=[]))
        self.assertEqual(db.save_state(self.db,dict(older,colors={}),3),4)
        self.assertEqual(db.read_state(self.db)['state'],dict(original,**older,rules=[],colors={}))
        limit=[dict(base,prefix=str(i)) for i in range(500)]
        self.assertEqual(db.save_state(self.db,dict(older,rules=limit),4),5);self.assertEqual(db.read_state(self.db)['state']['rules'],limit)

    def test_late_rule_write_failure_rolls_back_batch_and_settings(self):
        db.initialize(self.db); before=state();db.save_state(self.db,before,0)
        changed=state();changed['rows'][1]['category']='交通';changed['rows'][2]['category']='趣味';changed['budgets']={};changed['goals']=[]
        changed['colors']={'趣味':'#000000'};changed['rules'].reverse()
        with closing(db.connect(self.db)) as c,c:
            c.execute("CREATE TRIGGER fail_rule BEFORE INSERT ON category_rules WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'synthetic fail'); END")
        with self.assertRaises(sqlite3.IntegrityError):db.save_state(self.db,changed,1)
        self.assertEqual(db.read_state(self.db),dict(revision=1,state=before))
        with closing(db.connect(self.db)) as c,c:c.execute('DROP TRIGGER fail_rule')
        self.assertEqual(db.save_state(self.db,changed,1),2)
        with self.assertRaises(db.ApiError) as err:db.save_state(self.db,before,1)
        self.assertEqual(err.exception.status,409)
        db.initialize(self.db);self.assertEqual(db.read_state(self.db),dict(revision=2,state=changed))

    def test_real_loopback_http_and_sql_queries(self):
        # Use ephemeral port + explicitly isolated temp DB. Never open a browser.
        with db.create_server(self.db,0) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                def req(method,path,obj=None,headers=None):
                    hs={'Host':server.authority,'X-Tally-Client':'sqlite-v1','Origin':server.origin}
                    if obj is not None: hs['Content-Type']='application/json'
                    for k,v in (headers or {}).items():
                        if v is None:hs.pop(k,None)
                        else:hs[k]=v
                    with closing(http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)) as c:
                        c.request(method,path,json.dumps(obj).encode() if obj is not None else None,hs)
                        r=c.getresponse(); return r.status,r.read(),dict(r.getheaders())
                status,html,head=req('GET','/');self.assertEqual(status,200);html=html.decode();
                self.assertIn('src="/sqlite-client.js"',html.split('</head>')[0]);self.assertEqual(head['Cache-Control'],'no-store')
                for code in re.findall(r'<script\b[^>]*>(.*?)</script\s*>',html,re.S|re.I):
                    if code:self.assertIn(base64.b64encode(hashlib.sha256(code.encode()).digest()).decode(),head['Content-Security-Policy'])
                self.assertNotIn('Access-Control-Allow-Origin',head);self.assertEqual(req('GET','/sqlite-client.js')[0],200)
                for hs in [{'Origin':'null'},{'Origin':'http://example.invalid'},{'Host':'example.invalid'},{'X-Tally-Client':None},{'Sec-Fetch-Site':'cross-site'}]:
                    self.assertEqual(req('GET','/api/state',headers=hs)[0],403)
                self.assertEqual(req('GET','/records.sqlite')[0],404);self.assertEqual(req('OPTIONS','/api/state')[0],403)
                self.assertEqual(json.loads(req('GET','/api/state')[1]),dict(revision=0,state=dict(rows=[],budgets={},goals=[],colors={},rules=[],customCategories=cli.empty_custom())))
                s=state(); payload={'nextState':s,'expectedRevision':0}
                self.assertEqual(req('POST','/api/state',payload,{'Origin':None})[0],403)
                self.assertEqual(req('POST','/api/state',payload,{'Content-Type':'text/plain'})[0],415)
                self.assertEqual(req('POST','/api/state',payload)[0],200);self.assertEqual(req('POST','/api/state',payload)[0],409)
                self.assertEqual(json.loads(req('GET','/api/state')[1]),dict(revision=1,state=s))
                params=dict(start='2024-02-01',end='2024-02-29',category='食費',limit=2,revision=1)
                def top(q):return req('GET','/api/top?'+urlencode(q))
                self.assertEqual([r['id'] for r in json.loads(top(params)[1])['rows']],['a','b'])
                self.assertEqual([r['key'] for r in json.loads(top(params)[1])['rows']],['k:a','k:b'])
                self.assertEqual(top(dict(params,revision=0))[0],409);self.assertEqual(top(dict(params,limit=-1))[0],400)
                self.assertEqual(json.loads(top(dict(params,category="' OR 1 --"))[1])['rows'],[])
                status,body,_=req('GET','/api/period?start=2024-02-29&end=2024-02-29&revision=1');self.assertEqual(status,200);self.assertEqual([r['id'] for r in json.loads(body)['rows']],['a','b'])
                invalid=state();invalid['goals'][0]['saved']=-9
                self.assertEqual(req('POST','/api/state',dict(nextState=invalid,expectedRevision=1))[0],400)
                self.assertEqual(json.loads(req('GET','/api/state')[1]),dict(revision=1,state=s))
            finally:server.shutdown();thread.join(3)

unittest.main(argv=['sql-tests'],verbosity=2)
`;
const result=spawnSync(python,[...prefix,'-B','-c',suite],{cwd:root,stdio:'inherit',env:{...process.env,PYTHONUTF8:'1'},windowsHide:true});
if(result.error){console.error('Set TALLY_PYTHON to your Python 3 executable:',result.error.message);process.exitCode=1;}else process.exitCode=result.status??1;
