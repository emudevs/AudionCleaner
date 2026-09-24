import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import bootstrap
import common


class FFmpegSetupTests(unittest.TestCase):
    def test_download_installs_both_tools_and_reuses_them(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            for name in ("ffmpeg.exe", "ffprobe.exe"):
                z.writestr("ffmpeg-test/bin/" + name, b"test")
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ), \
                patch.object(bootstrap, "TOOLS_DIR", Path(temp)), \
                patch.object(bootstrap, "valid_media_tool", side_effect=lambda p: p.is_file()), \
                patch.object(bootstrap, "download_ffmpeg", side_effect=lambda p: p.write_bytes(archive.getvalue())) as download:
            paths = bootstrap.install_ffmpeg()
            self.assertTrue(all(Path(p).is_file() for p in paths))
            self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(Path(paths[0]).parent))
            bootstrap.install_ffmpeg()
            self.assertEqual(download.call_count, 1)

    def test_missing_probe_triggers_reinstall(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(bootstrap, "TOOLS_DIR", Path(temp)), \
                patch.object(bootstrap, "valid_media_tool", side_effect=lambda p: p.is_file()), \
                patch.object(bootstrap, "download_ffmpeg", side_effect=OSError("offline")):
            binary = Path(temp) / "ffmpeg/bin/ffmpeg.exe"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"test")
            with self.assertRaisesRegex(RuntimeError, "installation failed"):
                bootstrap.install_ffmpeg()
            self.assertTrue(binary.exists())

    def test_common_exports_private_tools_without_runtime_json(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"PATH": ""}), \
                patch.object(common, "TOOLS_DIR", Path(temp)), patch.object(common, "load_runtime", return_value={}):
            folder = Path(temp) / "ffmpeg/bin"
            folder.mkdir(parents=True)
            common.configure_media_path()
            common.configure_media_path()
            self.assertEqual(os.environ["PATH"].split(os.pathsep).count(str(folder)), 1)


if __name__ == "__main__":
    unittest.main()
