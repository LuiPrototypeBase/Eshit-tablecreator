from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from time import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
import json
import os
import threading


PORT = int(os.environ.get("PORT", "8787"))
HOST = os.environ.get("HOST", "127.0.0.1")
APP_UA = os.environ.get(
    "BANGUMI_USER_AGENT",
    "AkaishiTableGenerator/0.1 (contact: https://bgm.tv)",
)
TOKEN = os.environ.get("BANGUMI_TOKEN", "")
SEARCH_TTL = int(os.environ.get("SEARCH_CACHE_SECONDS", "86400"))
IMAGE_TTL = int(os.environ.get("IMAGE_CACHE_SECONDS", "604800"))
RATE_WINDOW = int(os.environ.get("RATE_WINDOW_SECONDS", "60"))
RATE_LIMIT = int(os.environ.get("RATE_LIMIT", "80"))
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))

cache_lock = threading.Lock()
search_cache = {}
image_cache = {}
rate_buckets = {}


def now():
    return time()


def is_fresh(entry, ttl):
    return entry and now() - entry["time"] < ttl


def client_ip(handler):
    forwarded = handler.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() or handler.client_address[0]


def check_rate_limit(ip):
    timestamp = now()
    with cache_lock:
        bucket = [hit for hit in rate_buckets.get(ip, []) if timestamp - hit < RATE_WINDOW]
        if len(bucket) >= RATE_LIMIT:
            rate_buckets[ip] = bucket
            return False
        bucket.append(timestamp)
        rate_buckets[ip] = bucket
        return True


def clamp_number(value, fallback, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(maximum, max(minimum, number))


def clamp_subject_type(value):
    try:
        subject_type = int(value)
    except (TypeError, ValueError):
        return 2
    return subject_type if subject_type in {1, 2, 4, 6} else 2


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/search":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not check_rate_limit(client_ip(self)):
            self.write_json({"error": "Too many requests. Please try again later."}, HTTPStatus.TOO_MANY_REQUESTS)
            return
        self.search_bangumi()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.write_json({"ok": True, "service": "akaishi-generator"})
            return
        if parsed.path.startswith("/api/subject/"):
            if not check_rate_limit(client_ip(self)):
                self.send_error(HTTPStatus.TOO_MANY_REQUESTS)
                return
            self.get_subject(parsed)
            return
        if parsed.path == "/api/image":
            if not check_rate_limit(client_ip(self)):
                self.send_error(HTTPStatus.TOO_MANY_REQUESTS)
                return
            self.proxy_image(parsed)
            return
        super().do_GET()

    def search_bangumi(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            keyword = str(payload.get("keyword", "")).strip()
            if not keyword:
                self.write_json({"error": "Keyword is required."}, HTTPStatus.BAD_REQUEST)
                return
            subject_type = clamp_subject_type(payload.get("type"))
            include_nsfw = bool(payload.get("nsfw"))
            limit = clamp_number(payload.get("limit"), 20, 1, 50)
            offset = clamp_number(payload.get("offset"), 0, 0, 1000)

            cache_key = f"{keyword.lower()}:{subject_type}:{'nsfw' if include_nsfw else 'sfw'}:{limit}:{offset}"
            with cache_lock:
                cached = search_cache.get(cache_key)
            if is_fresh(cached, SEARCH_TTL):
                self.write_json_bytes(cached["data"], cached=True)
                return

            request_body = json.dumps(
                {
                    "keyword": keyword,
                    "filter": {"type": [subject_type], "nsfw": "include" if include_nsfw else False},
                    "sort": "match",
                }
            ).encode("utf-8")
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": APP_UA,
            }
            if TOKEN:
                headers["Authorization"] = f"Bearer {TOKEN}"

            request = Request(
                f"https://api.bgm.tv/v0/search/subjects?limit={limit}&offset={offset}",
                data=request_body,
                headers=headers,
                method="POST",
            )
            with urlopen(request, timeout=12) as response:
                data = response.read()

            with cache_lock:
                search_cache[cache_key] = {"time": now(), "data": data}
            self.write_json_bytes(data, cached=False)
        except (HTTPError, URLError, TimeoutError) as error:
            self.write_json({"error": f"Bangumi upstream unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)
        except Exception as error:
            self.write_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def proxy_image(self, parsed):
        target = parse_qs(parsed.query).get("url", [""])[0]
        if not target.startswith(("https://", "http://")):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return

        with cache_lock:
            cached = image_cache.get(target)
        if is_fresh(cached, IMAGE_TTL):
            self.write_image(cached["data"], cached["content_type"], cached=True)
            return

        try:
            request = Request(target, headers={"User-Agent": APP_UA})
            with urlopen(request, timeout=12) as response:
                content_type = response.headers.get("Content-Type", "image/jpeg")
                data = response.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                return

            with cache_lock:
                image_cache[target] = {
                    "time": now(),
                    "data": data,
                    "content_type": content_type,
                }
            self.write_image(data, content_type, cached=False)
        except Exception:
            self.send_error(HTTPStatus.BAD_GATEWAY)

    def get_subject(self, parsed):
        subject_id = parsed.path.rstrip("/").split("/")[-1]
        if not subject_id.isdigit():
            self.write_json({"error": "Invalid subject id."}, HTTPStatus.BAD_REQUEST)
            return

        cache_key = f"subject:{subject_id}"
        with cache_lock:
            cached = search_cache.get(cache_key)
        if is_fresh(cached, SEARCH_TTL):
            self.write_json_bytes(cached["data"], cached=True)
            return

        headers = {
            "Accept": "application/json",
            "User-Agent": APP_UA,
        }
        if TOKEN:
            headers["Authorization"] = f"Bearer {TOKEN}"

        try:
            request = Request(f"https://api.bgm.tv/v0/subjects/{subject_id}", headers=headers)
            with urlopen(request, timeout=12) as response:
                data = response.read()
            with cache_lock:
                search_cache[cache_key] = {"time": now(), "data": data}
            self.write_json_bytes(data, cached=False)
        except (HTTPError, URLError, TimeoutError) as error:
            self.write_json({"error": f"Bangumi upstream unavailable: {error}"}, HTTPStatus.BAD_GATEWAY)

    def write_json(self, payload, status=HTTPStatus.OK):
        self.write_json_bytes(json.dumps(payload, ensure_ascii=False).encode("utf-8"), status=status)

    def write_json_bytes(self, data, status=HTTPStatus.OK, cached=False):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=300" if cached else "no-store")
        self.send_header("X-Cache", "HIT" if cached else "MISS")
        self.end_headers()
        self.wfile.write(data)

    def write_image(self, data, content_type, cached=False):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("X-Cache", "HIT" if cached else "MISS")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Akaishi generator server started: http://{HOST}:{PORT}")
    server.serve_forever()
