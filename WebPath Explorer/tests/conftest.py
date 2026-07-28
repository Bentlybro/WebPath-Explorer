import os
import sys
import tempfile
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))

# map.py exposes a conventional module-level WSGI app.  Point that import-time
# app at a disposable database so test collection can never migrate production
# or the repository's example database.
IMPORT_DATABASE = Path(tempfile.mkdtemp(prefix="webpath-tests-")) / "import.db"
os.environ["WEBPATH_DB_PATH"] = str(IMPORT_DATABASE)
os.environ["WEBPATH_DATABASE"] = str(IMPORT_DATABASE)
