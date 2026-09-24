#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export PATH="/Library/Frameworks/Python.framework/Versions/3.12/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PYTHONUNBUFFERED=1
finish() {
    code=$?
    if [ "$code" -ne 0 ]; then
        printf '\nSetup or application failed. See the message above.\n'
    fi
    if [ -t 0 ]; then read -r -p "Press Return to close..." _reply || true; fi
}
trap finish EXIT
if ! command -v python3.12 >/dev/null 2>&1; then
    printf 'Install Python 3.12 for macOS from python.org, then reopen this script.\n'
    exit 1
fi
if ! python3.12 -c 'import tkinter' >/dev/null 2>&1; then
    printf 'Python 3.12 needs Tkinter. Use the python.org macOS installer.\n'
    exit 1
fi
python3.12 bootstrap.py
.venv/bin/python app.py
