import argparse
import hashlib
import json
from pathlib import Path


REPOSITORY = "Kasper4649/ZdicBobPlugin"
RELEASE_ASSET = "zdic.bobplugin"


def update_appcast(message):
    with Path("src/info.json").open(encoding="utf-8") as f:
        info = json.load(f)
    version = info["version"]
    release_file = Path("release") / RELEASE_ASSET
    if not release_file.is_file():
        raise FileNotFoundError(f"Release file does not exist: {release_file}")
    with release_file.open("rb") as f:
        c = f.read()
        file_hash = hashlib.sha256(c).hexdigest()
    version_info = {
        "version": version,
        "desc": message,
        "sha256": file_hash,
        "url": (
            f"https://github.com/{REPOSITORY}/releases/download/"
            f"v{version}/{release_file.name}"
        ),
        "minBobVersion": info["minBobVersion"],
    }
    appcast_file = Path("appcast.json")
    if appcast_file.is_file():
        with appcast_file.open(encoding="utf-8") as f:
            appcast = json.load(f)
        if appcast.get("identifier") != info["identifier"]:
            appcast["versions"] = []
    else:
        appcast = {"versions": []}
    appcast["identifier"] = info["identifier"]
    appcast["versions"] = [
        existing
        for existing in appcast["versions"]
        if existing.get("version") != version
    ]
    appcast["versions"].insert(0, version_info)
    with appcast_file.open("w", encoding="utf-8") as f:
        json.dump(appcast, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"v{version}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Add a release to appcast.json.")
    parser.add_argument("message", help="Release description")
    update_appcast(parser.parse_args().message)
