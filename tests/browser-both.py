"""Run the same bundled app UI suite in standalone and fresh, isolated SQLite modes.
Usage: python -B tests/browser-both.py <path-to-node.exe>. CHROME_PATH selects Edge.
"""
import subprocess, sys, threading, uuid, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tally_db


def main():
    node = sys.argv[1] if len(sys.argv)>1 else 'node'
    base = [node, str(ROOT/'tests'/'browser-smoke.cjs')]
    subprocess.run(base, cwd=ROOT, check=True)
    parent=(ROOT/'tests').resolve(); name='browser-db-'+uuid.uuid4().hex; tmp=parent/name; tmp.mkdir()
    try:
        with tally_db.create_server(tmp/'test.sqlite3',port=0) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try: subprocess.run([*base,'--test-db','--url='+server.origin+'/'],cwd=ROOT,check=True)
            finally: server.shutdown();thread.join(3)
    finally:
        if tmp.resolve()!=parent/name or tmp.resolve().parent!=parent:raise RuntimeError('unexpected temporary path')
        shutil.rmtree(tmp)

if __name__=='__main__':main()
