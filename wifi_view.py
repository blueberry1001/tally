"""Optional Tally viewer for a trusted home LAN. Python 3.8+, stdlib only.
Only serves the app's index.html. No directory listing, file writes, or ledger API.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path
from urllib.parse import urlsplit
import socket
import sys

PRIVATE = tuple(IPv4Network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
PORT = 8765


def private(addr):
    try:
        return any(IPv4Address(addr) in net for net in PRIVATE)
    except ValueError:
        return False


def addresses():
    return sorted({info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET) if private(info[4][0])})


class Viewer(BaseHTTPRequestHandler):
    server_version = 'Tally'
    sys_version = ''

    def do_GET(self):
        self.serve_app(True)

    def do_HEAD(self):
        self.serve_app(False)

    def serve_app(self, body):
        if not private(self.client_address[0]) or self.headers.get('Host', '') != self.server.allowed_host:
            self.send_error(403)
            return
        if urlsplit(self.path).path not in ('/', '/index.html'):
            self.send_error(404)
            return
        doc = self.server.app_html
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(doc)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        if body:
            self.wfile.write(doc)

    def log_message(self, *args):
        pass


class HomeServer(ThreadingHTTPServer):
    def get_request(self):
        sock, addr = super().get_request()
        sock.settimeout(5)
        return sock, addr


def main():
    addrs = addresses()
    if not addrs:
        raise ValueError('家庭内Wi-FiのIPv4アドレスが見つかりません。PCのネットワーク接続をご確認ください。')
    if len(addrs) > 1:
        print('Wi-Fi / 家庭内LANのアドレスを選んでください（Windowsの設定 → ネットワークで確認）。')
        for i, addr in enumerate(addrs, 1):
            print(f'{i}: {addr}')
        choice = int(input('番号: '))
        if not 1 <= choice <= len(addrs):
            raise ValueError('一覧から番号を選んでください。')
        addr = addrs[choice-1]
    else:
        addr = addrs[0]
    doc = Path(__file__).with_name('index.html').read_bytes()
    with HomeServer((addr, PORT), Viewer) as server:
        server.allowed_host = f'{addr}:{PORT}'
        server.app_html = doc
        print(f'\nTally | 同じ家庭内Wi-FiのAndroidで開くURL:\n\n   http://{server.allowed_host}/\n')
        print('家計データは各ブラウザに保存されます。これは自動同期ではありません。\nこのウィンドウを閉じるか Ctrl+C で配信を停止します。')
        server.serve_forever()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n停止しました。')
    except (OSError, ValueError) as err:
        print(f'起動できませんでした: {err}', file=sys.stderr)
        sys.exit(1)
