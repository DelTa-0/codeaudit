import json
import requests
from flask import Flask

import helpers
from helpers import used_helper


app = Flask(__name__)


def main():
    data = json.dumps({"ok": True})
    resp = requests.get("https://example.com", timeout=5)
    print(used_helper(data), resp.status_code, helpers.ANSWER)


main()
