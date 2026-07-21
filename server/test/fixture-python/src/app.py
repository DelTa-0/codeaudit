import json
import requests
from flask import Flask

import helpers
from helpers import used_helper


app = Flask(__name__)


def lazy_docx_load(path):
    # lazy in-function import — must still count as an import of python-docx
    import docx

    return docx.Document(path)


@app.route("/health")
def health():
    # decorator-wired route handler — must never be a dead-code candidate
    return {"ok": True}


def internal_helper(value):
    # only called within this module — must never be a dead-code candidate
    return value.upper()


def main():
    data = json.dumps({"ok": True})
    resp = requests.get("https://example.com", timeout=5)
    print(used_helper(internal_helper(data)), resp.status_code, helpers.ANSWER)


main()
