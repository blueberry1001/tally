"""Package the already-built app; never include a database, backup or local profile."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from html.parser import HTMLParser
import hashlib

ROOT = Path(__file__).resolve().parent
FILES = ('index.html', '使い方.txt', '機能比較.md', 'Start-SQLite.cmd', 'tally_db.py',
         'sqlite-client.js', 'vendor/tally_sql.py', 'SQL-NOTES.md', 'tests/sql-cli.cjs',
         'Start-WiFi.cmd', 'wifi_view.py')

class OfflineCheck(HTMLParser):
    def handle_starttag(self, tag, attrs):
        at = dict(attrs)
        if tag == 'script' and 'src' in at or tag == 'link' and at.get('rel') == 'stylesheet':
            raise ValueError('Build index.html before packaging; external script/style detected.')

if __name__ == '__main__':
    html=(ROOT/'index.html').read_text('utf-8')
    OfflineCheck().feed(html)
    for marker in ('window.TallyExplorer=', 'window.TallyMap=','window.TallyPlans=', 'window.TallyBulk=', 'window.TallyPrefs=', 'window.TallyHelp=', 'window.TallyGuide=', 'ax-week-day', 'cfg-category-add', 'entry-bulk', 'CSVをエクスポート', 'TallyDataActions', 'TallyLedgerCSV','TallyExchange','import-map-form','data-import', 'tally.treemap.layout.v1', 'tm-period-form', 'TallyOpenAnalysis', 'TallyHeat', '年間ヒートマップ', 'data-config="display"', 'TallyPortableView', '端末引き継ぎ用にエクスポート', 'queryTop(s.a,s.b,s.limit,s.category)'):
        assert marker in html, f'Missing release feature: {marker}'
    package=ROOT/'Tally.zip'
    with ZipFile(package, 'w', compression=ZIP_DEFLATED) as out:
        for name in FILES:
            out.write(ROOT/name, name)
    with ZipFile(package) as z:
        assert tuple(z.namelist()) == FILES and z.testzip() is None
        for name in FILES:
            assert z.read(name) == (ROOT/name).read_bytes(), name
    print(f'PASS: {len(FILES)} release entries verified; SHA256 {hashlib.sha256(package.read_bytes()).hexdigest()}')
